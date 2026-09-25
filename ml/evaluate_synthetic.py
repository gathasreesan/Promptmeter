"""
Does the synthetic data actually help?

Trains the existing classifier twice and compares it against one fixed, human-written
test set:

    A   original phrases.csv only          (what ships today)
    B   original + dataset/synthetic_*.csv

    python evaluate_synthetic.py
    python evaluate_synthetic.py --no-search        # skip the hyperparameter grid

Reads train.py rather than reimplementing it, so the two arms use the same TieredTfidf,
the same LogisticRegression settings and the same grid the production model was chosen
with. Whatever this measures, it measures about the real model.

Three things keep the comparison honest:

  1. THE TEST SET IS HUMAN-WRITTEN AND FIXED. It is a stratified 25% of phrases.csv,
     drawn with train.py's own RANDOM_STATE, so arm A here is the model that ships.
     No synthetic row is ever in it. A synthetic test set would measure how well the
     model learned the generator.

  2. SYNTHETIC ROWS THAT LEAK ARE DROPPED. A generated paraphrase of a test row is a
     training row containing the answer. Every synthetic row is compared against every
     test row on character 3-5 grams, and anything above the threshold is removed from
     arm B before training. The count is reported; a large one means the generator was
     shown the test set through the seed corpus.

  3. THE HEADLINE NUMBER IS THE ONE THAT CAN HURT A USER. Four-way accuracy is
     reported, but the decision the optimizer makes is KEEP/DROP, and its expensive
     failure is one-sided: deleting a constraint silently changes what the user asked
     for, while keeping a filler phrase costs a few tokens. So `importantDropRate` --
     true-IMPORTANT rows predicted removable -- is the number the verdict turns on.

This script NEVER writes utils/ml-model.js or metrics.json. Retraining production is
train.py, run by hand, after reading the verdict below.
"""

import argparse
import csv
import json
import os
import sys

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    precision_recall_fscore_support,
)
from sklearn.metrics.pairwise import linear_kernel
from sklearn.model_selection import train_test_split

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import (  # noqa: E402 - path has to be set before this import
    DATASET,
    RANDOM_STATE,
    TEST_SIZE,
    build_model,
    describe,
    keep_drop_accuracy,
    load_dataset,
    search_params,
)

HERE = os.path.dirname(os.path.abspath(__file__))
SYNTHETIC = os.path.join(HERE, "dataset", "synthetic_10000.csv")
OUT = os.path.join(HERE, "eval_synthetic.json")

# Same similarity measure and threshold as the generator's duplicate check, so a row
# that survived generation cannot fail here for a different reason.
LEAK_THRESHOLD = 0.85

# Settings used when --no-search is passed. Not a claim about what is best -- just a
# fixed point so the two arms differ only in their data.
DEFAULT_PARAMS = {"ngram_range": (1, 2), "sublinear_tf": True, "bigram_min_df": 2, "C": 4.0}


def load_synthetic(path):
    """
    Reads the generated CSV. Returns (texts, labels).

    The `context` column is read but not used as a feature: the browser classifier is
    handed one span at a time and has no context to give the model, so training on
    context would measure a model the extension cannot run. See the REPETITIVE note in
    ml/README.md.
    """
    if not os.path.exists(path):
        return [], []
    texts, labels = [], []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip()
            if text and label:
                texts.append(text)
                labels.append(label)
    return texts, labels


def leaking(candidate_texts, test_texts, threshold=LEAK_THRESHOLD):
    """
    Indices of candidate rows too similar to any test row.

    Fitted on both sets together so the n-gram space is shared; compared in blocks so
    the dense similarity matrix stays small.
    """
    if not candidate_texts or not test_texts:
        return set()

    vectorizer = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=1)
    vectorizer.fit(candidate_texts + test_texts)
    candidates = vectorizer.transform(candidate_texts)
    tests = vectorizer.transform(test_texts)

    found = set()
    block = 512
    for start in range(0, candidates.shape[0], block):
        stop = min(start + block, candidates.shape[0])
        similarity = linear_kernel(candidates[start:stop], tests)
        for offset, row in enumerate(similarity):
            if row.size and row.max() >= threshold:
                found.add(start + offset)
    return found


def to_binary(values):
    return ["KEEP" if value == "IMPORTANT" else "DROP" for value in values]


def score(name, train_x, train_y, test_x, test_y, params):
    """Fits one arm and returns every metric the comparison reports."""
    vectorizer, classifier = build_model(params)
    classifier.fit(vectorizer.fit_transform(train_x), train_y)
    predicted = list(classifier.predict(vectorizer.transform(test_x)))

    classes = list(classifier.classes_)
    macro = precision_recall_fscore_support(
        test_y, predicted, average="macro", zero_division=0)
    per_class = precision_recall_fscore_support(
        test_y, predicted, labels=classes, zero_division=0)

    binary_true, binary_pred = to_binary(test_y), to_binary(predicted)
    binary = precision_recall_fscore_support(
        binary_true, binary_pred, average="macro", zero_division=0)

    # The failure that costs a user something: a sentence carrying a constraint,
    # classified as removable, and therefore deleted from their prompt.
    important = [i for i, label in enumerate(test_y) if label == "IMPORTANT"]
    dropped = [i for i in important if predicted[i] != "IMPORTANT"]

    return {
        "name": name,
        "params": describe(params),
        "trainRows": len(train_x),
        "vocabulary": len(vectorizer.vocabulary_),
        "accuracy": round(float(accuracy_score(test_y, predicted)), 4),
        "macro": {
            "precision": round(float(macro[0]), 4),
            "recall": round(float(macro[1]), 4),
            "f1": round(float(macro[2]), 4),
        },
        "perClass": {
            label: {
                "precision": round(float(per_class[0][i]), 4),
                "recall": round(float(per_class[1][i]), 4),
                "f1": round(float(per_class[2][i]), 4),
                "support": int(per_class[3][i]),
            }
            for i, label in enumerate(classes)
        },
        "binary": {
            "accuracy": round(float(accuracy_score(binary_true, binary_pred)), 4),
            "precision": round(float(binary[0]), 4),
            "recall": round(float(binary[1]), 4),
            "f1": round(float(binary[2]), 4),
        },
        "importantDropped": len(dropped),
        "importantTotal": len(important),
        "importantDropRate": round(len(dropped) / len(important), 4) if important else 0.0,
        "confusion": {
            "labels": classes,
            "matrix": confusion_matrix(test_y, predicted, labels=classes).tolist(),
        },
        "_predicted": predicted,
        "_classes": classes,
    }


def compare(seed, texts, labels, synthetic_x, synthetic_y, params_a, params_b):
    """One split: hold out human rows, guard the leak, fit both arms, score both."""
    train_x, test_x, train_y, test_y = train_test_split(
        texts, labels, test_size=TEST_SIZE, random_state=seed, stratify=labels)

    leaked = leaking(synthetic_x, test_x)
    clean_x = [t for i, t in enumerate(synthetic_x) if i not in leaked]
    clean_y = [y for i, y in enumerate(synthetic_y) if i not in leaked]

    return (
        score("A -- original only", train_x, train_y, test_x, test_y, params_a),
        score("B -- original + synthetic",
              train_x + clean_x, train_y + clean_y, test_x, test_y, params_b),
        test_y, len(leaked),
    )


def repeated(repeats, texts, labels, synthetic_x, synthetic_y, params_a, params_b):
    """
    Runs the comparison over `repeats` different held-out splits.

    One split is not enough to act on. The human test set is 156 rows, 41 of them
    IMPORTANT, so the headline harm metric moves 2.4 points every time a single row
    changes side -- a difference that looks decisive and is noise. Re-splitting with a
    different seed and reporting the spread is what makes the verdict mean anything.

    @returns dict of metric name -> {mean, std, deltas} plus the per-split win counts
    """
    collected = {"accuracy": [], "binary": [], "harm": []}
    wins = {"binary": 0, "harm_worse": 0}

    for offset in range(repeats):
        arm_a, arm_b, _, _ = compare(
            RANDOM_STATE + offset, texts, labels, synthetic_x, synthetic_y,
            params_a, params_b)
        collected["accuracy"].append(arm_b["accuracy"] - arm_a["accuracy"])
        collected["binary"].append(
            arm_b["binary"]["accuracy"] - arm_a["binary"]["accuracy"])
        collected["harm"].append(
            arm_b["importantDropRate"] - arm_a["importantDropRate"])
        if collected["binary"][-1] > 0:
            wins["binary"] += 1
        if collected["harm"][-1] > 0:
            wins["harm_worse"] += 1
        print("  split {0:>2}   4-way {1:+.4f}   keep/drop {2:+.4f}   harm {3:+.4f}".format(
            offset + 1, collected["accuracy"][-1], collected["binary"][-1],
            collected["harm"][-1]))

    summary = {
        name: {
            "meanDelta": round(float(sum(values) / len(values)), 4),
            "stdDelta": round(float(np.std(values)), 4),
            "deltas": [round(float(v), 4) for v in values],
        }
        for name, values in collected.items()
    }
    summary["splits"] = repeats
    summary["binaryWins"] = wins["binary"]
    summary["harmWorseIn"] = wins["harm_worse"]
    return summary


def report(arm, test_y):
    print("\n" + "=" * 66)
    print(arm["name"])
    print("=" * 66)
    print("{0} training rows, {1} features".format(arm["trainRows"], arm["vocabulary"]))
    print(arm["params"])
    print()
    print(classification_report(test_y, arm["_predicted"], zero_division=0))
    print("4-way accuracy      {0:.4f}".format(arm["accuracy"]))
    print("KEEP/DROP accuracy  {0:.4f}".format(arm["binary"]["accuracy"]))
    print("KEEP/DROP F1 (macro){0:.4f}".format(arm["binary"]["f1"]))
    print("IMPORTANT deleted   {0}/{1}  ({2:.2%})".format(
        arm["importantDropped"], arm["importantTotal"], arm["importantDropRate"]))


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--synthetic", default=SYNTHETIC)
    parser.add_argument("--no-search", action="store_true",
                        help="use fixed hyperparameters instead of the grid")
    parser.add_argument("--repeats", type=int, default=10,
                        help="held-out splits to average the verdict over (1 = single split)")
    args = parser.parse_args()

    texts, labels, _ = load_dataset(DATASET)
    print("Original dataset: {0} human-written rows".format(len(texts)))

    # Identical split to train.py, so arm A is the shipping model and not a lookalike.
    train_x, test_x, train_y, test_y = train_test_split(
        texts, labels, test_size=TEST_SIZE, random_state=RANDOM_STATE, stratify=labels)
    print("Held-out test set: {0} human-written rows (never synthetic)".format(len(test_x)))

    synthetic_x, synthetic_y = load_synthetic(args.synthetic)
    if not synthetic_x:
        print("\nNo synthetic rows at {0} -- nothing to compare.".format(args.synthetic))
        print("Run generate_synthetic.py first.")
        return 1
    print("Synthetic dataset: {0} rows".format(len(synthetic_x)))

    leaked = leaking(synthetic_x, test_x)
    clean_x = [t for i, t in enumerate(synthetic_x) if i not in leaked]
    clean_y = [y for i, y in enumerate(synthetic_y) if i not in leaked]
    print("Leak guard: dropped {0} synthetic rows too close to a test row; "
          "{1} remain".format(len(leaked), len(clean_x)))

    if args.no_search:
        params_a = params_b = DEFAULT_PARAMS
        print("\nUsing fixed hyperparameters (--no-search)")
    else:
        # Searched separately per arm. Forcing arm B to use settings chosen on arm A's
        # data would hand arm A an advantage that has nothing to do with the data.
        print("\nSearching hyperparameters for arm A (5-fold CV on KEEP/DROP)...")
        params_a, _ = search_params(train_x, train_y)
        print("  " + describe(params_a))
        print("Searching hyperparameters for arm B...")
        params_b, _ = search_params(train_x + clean_x, train_y + clean_y)
        print("  " + describe(params_b))

    arm_a = score("A -- original only", train_x, train_y, test_x, test_y, params_a)
    arm_b = score("B -- original + synthetic",
                  train_x + clean_x, train_y + clean_y, test_x, test_y, params_b)

    report(arm_a, test_y)
    report(arm_b, test_y)

    spread = None
    if args.repeats > 1:
        print("\n" + "-" * 66)
        print("Re-splitting {0} times (one split is noise at this size)".format(args.repeats))
        print("-" * 66)
        spread = repeated(args.repeats, texts, labels, synthetic_x, synthetic_y,
                          params_a, params_b)
        delta_four = spread["accuracy"]["meanDelta"]
        delta_binary = spread["binary"]["meanDelta"]
        delta_harm = spread["harm"]["meanDelta"]
    else:
        delta_binary = arm_b["binary"]["accuracy"] - arm_a["binary"]["accuracy"]
        delta_four = arm_b["accuracy"] - arm_a["accuracy"]
        delta_harm = arm_b["importantDropRate"] - arm_a["importantDropRate"]

    # Promote only on the metric the optimizer consumes, and only when the one-sided
    # harm did not get worse. A model that reads FILLER vs REDUNDANT better while
    # deleting more constraints is worse for this extension, whatever its accuracy says.
    #
    # Across repeated splits the gain must also clear the split-to-split spread. A mean
    # of +0.85% with a standard deviation of 2.2% is a coin flip dressed as a result,
    # and the naive standard error understates it further: the splits are re-draws from
    # the same 621 rows, so they are nowhere near independent and the effective sample
    # is far smaller than the number of repeats. Requiring mean > std is the blunt,
    # defensible version of that correction.
    #
    # One caveat that does not remove: the hyperparameters are searched once, on the
    # first split, and reused across the rest. Re-searching per split would be the clean
    # thing and costs 25 grid sweeps. Because later splits put some of the first split's
    # training rows into their test sets, both arms pick up a small optimistic bias --
    # equally, which is why the DELTA is still worth reading even though the absolute
    # numbers are a little flattering.
    promote = delta_binary > 0 and delta_harm <= 0
    if spread:
        promote = promote and delta_binary > spread["binary"]["stdDelta"]

    print("\n" + "=" * 66)
    print("VERDICT" + ("  (mean over {0} splits)".format(args.repeats)
                       if spread else "  (single split)"))
    print("=" * 66)
    print("4-way accuracy       {0:+.4f}".format(delta_four))
    print("KEEP/DROP accuracy   {0:+.4f}".format(delta_binary))
    print("IMPORTANT drop rate  {0:+.4f}  (negative is better)".format(delta_harm))
    if spread:
        print()
        print("std across splits    4-way {0:.4f}   keep/drop {1:.4f}   harm {2:.4f}".format(
            spread["accuracy"]["stdDelta"], spread["binary"]["stdDelta"],
            spread["harm"]["stdDelta"]))
        print("B beat A on keep/drop in {0}/{1} splits; "
              "deleted more IMPORTANT in {2}/{1}".format(
                  spread["binaryWins"], args.repeats, spread["harmWorseIn"]))
    print()
    if promote:
        print("Synthetic data helps. To adopt it:")
        print("  1. clear dataset/review_queue.csv by hand")
        print("  2. append the synthetic rows to dataset/phrases.csv with "
              "source=synthetic")
        print("  3. python train.py")
    else:
        print("Synthetic data does NOT demonstrably improve the decision the optimizer")
        print("makes. Production model left alone. phrases.csv unchanged.")
        if spread and delta_binary > 0:
            print("(KEEP/DROP moved the right way on average, but by less than the "
                  "spread across splits -- that is not evidence.)")

    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump({
            "testSet": {
                "rows": len(test_x),
                "source": "human-written phrases.csv, stratified 25% hold-out",
                "randomState": RANDOM_STATE,
            },
            "synthetic": {
                "rows": len(synthetic_x),
                "droppedAsLeakage": len(leaked),
                "usedForTraining": len(clean_x),
                "leakThreshold": LEAK_THRESHOLD,
            },
            "armA": {k: v for k, v in arm_a.items() if not k.startswith("_")},
            "armB": {k: v for k, v in arm_b.items() if not k.startswith("_")},
            "delta": {
                "note": ("mean over {0} held-out splits".format(args.repeats)
                         if spread else "single held-out split"),
                "accuracy": round(float(delta_four), 4),
                "binaryAccuracy": round(float(delta_binary), 4),
                "importantDropRate": round(float(delta_harm), 4),
            },
            "spread": spread,
            "promote": bool(promote),
            "note": "This script never writes utils/ml-model.js or metrics.json.",
        }, handle, indent=2)
    print("\nWrote " + os.path.relpath(OUT, HERE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
