"""
PromptMeter phrase classifier -- training and export.

Classifies one sentence or clause of a prompt into four categories:

    IMPORTANT   the instruction, its constraints, its subject matter
    FILLER      greetings, mood, backstory, sign-offs -- no information for the model
    REDUNDANT   wordy wrappers and tautologies that say nothing on their own
    REPETITIVE  restates something the prompt has already said

Why TF-IDF + Logistic Regression, and not something larger: the model has to run inside
a Chrome content script on every keystroke. A linear model over character/word n-grams
exports to a vocabulary, an IDF vector and a coefficient matrix -- a few hundred KB of
plain JSON that JavaScript can evaluate with one sparse dot product, no runtime, no
network call, no WASM. Anything heavier would either need a server round trip (defeating
the extension's privacy-first design) or a multi-megabyte download.

Run:
    pip install -r requirements.txt
    python train.py

Outputs:
    metrics.json            accuracy / precision / recall / F1, per class and overall
    ../utils/ml-model.js    the exported model, loaded by the extension
"""

import json
import os
import csv
from datetime import datetime, timezone

from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
from sklearn.base import BaseEstimator, TransformerMixin
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split, cross_val_score, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.metrics import make_scorer
from sklearn.metrics import (
    accuracy_score,
    precision_recall_fscore_support,
    classification_report,
    confusion_matrix,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(HERE, "dataset", "phrases.csv")
METRICS_OUT = os.path.join(HERE, "metrics.json")
MODEL_OUT = os.path.join(HERE, "..", "utils", "ml-model.js")
# Reference predictions the JavaScript classifier is checked against. The two
# implementations of the transform can only be kept honest by comparing their output.
PARITY_OUT = os.path.join(HERE, "..", "tests", "ml-parity.json")

# Must match the tokenizer in utils/ml-classifier.js exactly.
TOKEN_PATTERN = r"(?u)\b\w[\w']*\b"

RANDOM_STATE = 42
TEST_SIZE = 0.25

# Keeps the exported file small. Anything below this weight cannot move a decision past
# the confidence thresholds the optimizer uses anyway.
MIN_ABS_COEF = 0.01


def load_dataset(path):
    """
    Reads the labeled CSV into parallel text/label/source lists.

    `source` records where a row came from: "seed" for the hand-written originals,
    "generated" for rows composed by dataset/expand.py. It is not a feature -- it exists
    so the run can report how well a model trained only on generated phrases does on the
    human-written ones, which is the number that says whether the expansion taught the
    model anything real. Files without the column are treated as all-seed.
    """
    texts, labels, sources = [], [], []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip()
            if text and label:
                texts.append(text)
                labels.append(label)
                sources.append((row.get("source") or "seed").strip() or "seed")
    return texts, labels, sources


def cross_source_score(texts, labels, sources, params):
    """
    Trains on the generated rows alone and scores on the hand-written ones.

    Generated data can flatter a model badly: if every test row shares a skeleton with a
    training row, cross-validation measures memorisation of the generator rather than
    understanding of the task. Holding out the entire hand-written set removes that
    shortcut -- nothing in training shares a template with anything in the test set --
    so this is the figure that says whether the expansion helped.

    @returns tuple of (accuracy, binary accuracy, number of test rows) or None when the
             dataset has no generated rows to train on.
    """
    train_x = [t for t, src in zip(texts, sources) if src == "generated"]
    train_y = [y for y, src in zip(labels, sources) if src == "generated"]
    test_x = [t for t, src in zip(texts, sources) if src != "generated"]
    test_y = [y for y, src in zip(labels, sources) if src != "generated"]

    if not train_x or not test_x:
        return None

    vectorizer, classifier = build_model(params)
    classifier.fit(vectorizer.fit_transform(train_x), train_y)
    predicted = classifier.predict(vectorizer.transform(test_x))

    to_binary = lambda values: ["KEEP" if v == "IMPORTANT" else "DROP" for v in values]
    return (
        accuracy_score(test_y, predicted),
        accuracy_score(to_binary(test_y), to_binary(predicted)),
        len(test_x),
    )


class TieredTfidf(BaseEstimator, TransformerMixin):
    """
    TF-IDF where unigrams and bigrams get different document-frequency floors.

    A single min_df cannot serve both. Raising it to 2 to cut the long tail of bigrams
    seen exactly once also throws away two thirds of the unigrams, and those are what
    give the model any purchase on a sentence full of words the corpus never saw -- with
    min_df=2 the model reads "my hostel roommate kept playing loud music" as IMPORTANT,
    because almost nothing in it is in the vocabulary. Lowering it to 1 keeps the
    unigrams but ships every once-seen bigram: 3443 features, most of them dead weight
    in a file the extension loads on every page.

    Splitting the floor keeps what each n-gram order is good for. Unigrams stay at df>=1
    for coverage; bigrams must earn their place by appearing at least `bigram_min_df`
    times. On the current corpus that is 1395 features instead of 3443 -- a model roughly
    a third the size that also scores slightly better, because the discarded bigrams were
    noise.

    The vocabulary is selected inside fit(), so cross-validation reselects it per fold
    and the choice cannot see the test fold.
    """

    def __init__(self, ngram_range=(1, 2), sublinear_tf=True, bigram_min_df=2,
                 token_pattern=None):
        self.ngram_range = ngram_range
        self.sublinear_tf = sublinear_tf
        self.bigram_min_df = bigram_min_df
        self.token_pattern = token_pattern or TOKEN_PATTERN

    def fit(self, raw_documents, y=None):
        self.fit_transform(raw_documents, y)
        return self

    def fit_transform(self, raw_documents, y=None):
        if self.ngram_range[1] > 1 and self.bigram_min_df > 1:
            counter = CountVectorizer(
                ngram_range=self.ngram_range, min_df=1, lowercase=True,
                token_pattern=self.token_pattern,
            )
            counter.fit(raw_documents)
            frequency = np.asarray(
                (counter.transform(raw_documents) > 0).sum(axis=0)
            ).ravel()
            vocabulary = sorted(
                term for term, df in zip(counter.get_feature_names_out(), frequency)
                if term.count(" ") == 0 or df >= self.bigram_min_df
            )
            selected = {term: index for index, term in enumerate(vocabulary)}
        else:
            selected = None

        self._inner = TfidfVectorizer(
            vocabulary=selected, ngram_range=self.ngram_range, min_df=1,
            sublinear_tf=self.sublinear_tf, norm="l2", lowercase=True,
            token_pattern=self.token_pattern,
        )
        matrix = self._inner.fit_transform(raw_documents)
        self.vocabulary_ = self._inner.vocabulary_
        self.idf_ = self._inner.idf_
        return matrix

    def transform(self, raw_documents):
        return self._inner.transform(raw_documents)


# Hyperparameter grid. Searched for real on every run rather than asserted in a
# docstring: the dataset changes, and a setting that won on 512 rows is not
# automatically the setting that wins on 1680.
PARAM_GRID = {
    "ngram_range": [(1, 1), (1, 2)],
    "sublinear_tf": [False, True],
    "bigram_min_df": [1, 2, 3],
    "C": [1.0, 2.0, 4.0, 8.0, 16.0],
}


def build_model(params):
    """
    Builds the vectorizer/classifier pair for one point in the grid.

    Why TF-IDF over a linear model and nothing heavier: the result has to run inside a
    Chrome content script on every keystroke. This exports to a vocabulary, an IDF
    vector and a coefficient matrix -- plain JSON that JavaScript evaluates with one
    sparse dot product. Anything larger would need a server round trip, which would
    defeat the extension's privacy-first design, or a multi-megabyte WASM download.

    The settings chosen here travel to the browser inside the exported model, and
    utils/ml-classifier.js reads them from there. They are deliberately not hard-coded
    on the JavaScript side: the transform must match the fitted model exactly, and a
    constant duplicated across two languages is a constant that silently drifts.
    """
    vectorizer = TieredTfidf(
        ngram_range=params["ngram_range"],
        sublinear_tf=params["sublinear_tf"],
        bigram_min_df=params["bigram_min_df"],
        token_pattern=TOKEN_PATTERN,
    )

    classifier = LogisticRegression(
        max_iter=3000,
        C=params["C"],
        class_weight="balanced",
        random_state=RANDOM_STATE,
    )

    return vectorizer, classifier


def keep_drop_accuracy(y_true, y_pred):
    """Accuracy of the only call the optimizer makes: may this sentence go?"""
    to_binary = [("KEEP" if v == "IMPORTANT" else "DROP") for v in y_true]
    predicted = [("KEEP" if v == "IMPORTANT" else "DROP") for v in y_pred]
    return accuracy_score(to_binary, predicted)


def search_params(texts, labels):
    """
    Grid-searches the settings above by cross-validated KEEP/DROP accuracy.

    Scoring the binary collapse rather than four-way accuracy is deliberate, and it
    changes which model wins. The optimizer never acts on the four labels: it asks
    whether a sentence may be removed, and FILLER, REDUNDANT and REPETITIVE all mean
    yes. A grid point that trades a FILLER/REDUNDANT confusion for a correct KEEP/DROP
    call is strictly better for this application and strictly worse on the four-way
    number, so selecting on four-way accuracy optimises a metric nothing consumes.

    The document-frequency floors are searched through TieredTfidf, which explains why
    unigrams and bigrams need different ones.

    Scoring on CV rather than on the held-out split is also deliberate. The split is
    used once, at the end, to report a number no decision was made against; choosing
    hyperparameters on it would leak it into the model.

    @returns tuple of (best params dict, list of (params, mean, std) sorted best first)
    """
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    results = []

    for ngram in PARAM_GRID["ngram_range"]:
        for sublinear in PARAM_GRID["sublinear_tf"]:
            for min_df in PARAM_GRID["bigram_min_df"]:
                for c in PARAM_GRID["C"]:
                    params = {
                        "ngram_range": ngram, "sublinear_tf": sublinear,
                        "bigram_min_df": min_df, "C": c,
                    }
                    vectorizer, classifier = build_model(params)
                    pipeline = make_pipeline(vectorizer, classifier)
                    scores = cross_val_score(
                        pipeline, texts, labels, cv=folds,
                        scoring=make_scorer(keep_drop_accuracy),
                    )
                    results.append((params, scores.mean(), scores.std()))

    # Ties are common and meaningless at this dataset size -- the top few grid points
    # routinely sit inside a thousandth of each other, well under the fold-to-fold
    # spread. Rank on accuracy rounded to three decimals, then break ties on grounds
    # that matter in deployment: the steadier model first (lower variance across folds),
    # then the smaller one (a higher bigram floor means fewer features to ship), then
    # the less aggressively fitted one (lower C). Without this the winner is whichever
    # grid point the loops happened to visit first.
    results.sort(key=lambda row: (
        -round(row[1], 3),
        row[2],
        -row[0]["bigram_min_df"],
        row[0]["C"],
    ))
    return results[0][0], results


def describe(params):
    """One-line human description of a grid point, for the banner and metrics file."""
    low, high = params["ngram_range"]
    return (
        f"TfidfVectorizer(ngram={low}-{high}, sublinear_tf={params['sublinear_tf']}, "
        f"bigram_min_df={params['bigram_min_df']}) + LogisticRegression(C={params['C']}, balanced)"
    )


def export_js(vectorizer, classifier, path, metrics, description):
    """
    Writes the fitted model as a JavaScript module.

    A .js file rather than .json on purpose: a content script can load it synchronously
    by listing it in the manifest, whereas JSON would need fetch() plus a
    web_accessible_resources entry and an async boundary the optimizer cannot wait for.
    """
    vocabulary = {term: int(index) for term, index in vectorizer.vocabulary_.items()}
    idf = [round(float(value), 6) for value in vectorizer.idf_]

    # Drop coefficients too small to matter, so the shipped file stays lean.
    coefficients = []
    kept, total = 0, 0
    for row in classifier.coef_:
        sparse = {}
        for index, weight in enumerate(row):
            total += 1
            if abs(weight) >= MIN_ABS_COEF:
                sparse[str(index)] = round(float(weight), 5)
                kept += 1
        coefficients.append(sparse)

    payload = {
        "labels": list(classifier.classes_),
        # The JavaScript classifier reads these instead of hard-coding them, so the
        # browser-side transform cannot drift away from the fitted model.
        "config": {
            "ngramMin": int(vectorizer.ngram_range[0]),
            "ngramMax": int(vectorizer.ngram_range[1]),
            "sublinearTf": bool(vectorizer.sublinear_tf),
        },
        "vocabulary": vocabulary,
        "idf": idf,
        "coefficients": coefficients,
        "intercepts": [round(float(value), 5) for value in classifier.intercept_],
        "trainedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "accuracy": metrics["accuracy"],
        "samples": metrics["samples"]["total"],
    }

    banner = (
        "/**\n"
        " * PromptMeter ML model -- GENERATED FILE, DO NOT EDIT BY HAND.\n"
        " *\n"
        " * Produced by ml/train.py from ml/dataset/phrases.csv.\n"
        " * Regenerate with:  cd ml && python train.py\n"
        " *\n"
        f" * Trained {payload['trainedAt']} on {payload['samples']} labeled phrases.\n"
        f" * Held-out accuracy: {payload['accuracy']:.3f}\n"
        " *\n"
        f" * {description}\n"
        " * L2-normalised, multinomial. Consumed by utils/ml-classifier.js, which reads\n"
        " * the transform settings from the exported `config` block rather than\n"
        " * hard-coding them, so the two sides cannot drift apart.\n"
        " */\n"
    )

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(banner)
        handle.write("const PromptMeterModel = ")
        handle.write(json.dumps(payload, separators=(",", ":")))
        handle.write(";\n\n")
        handle.write("// Export for global (content script) and bundler environments\n")
        handle.write("if (typeof window !== 'undefined') {\n")
        handle.write("    window.PromptMeterModel = PromptMeterModel;\n")
        handle.write("}\n")
        handle.write("if (typeof module !== 'undefined' && module.exports) {\n")
        handle.write("    module.exports = { PromptMeterModel };\n")
        handle.write("}\n")

    return kept, total


def write_parity_fixture(vectorizer, classifier, texts, path):
    """
    Records this model's predictions for a sample of phrases, so tests/ml-parity.test.js
    can check that utils/ml-classifier.js reproduces them.

    The JavaScript side reimplements the fitted transform by hand. A mistake there -- a
    wrong n-gram order, a missed sublinear tf, a tokenizer that splits differently --
    produces no error, just quietly different probabilities, and the extension starts
    making decisions the measured accuracy never described. This fixture turns that
    silent class of bug into a failing test.
    """
    probe = texts[::17][:40] + [
        "thanks so much in advance for your help",
        "write a python script that reads a csv file",
        "i am really stressed about my exam tomorrow",
        "the essay needs to have an introduction",
    ]
    proba = classifier.predict_proba(vectorizer.transform(probe))

    fixture = {
        "note": "Generated by ml/train.py. Expected output of utils/ml-classifier.js.",
        "labels": [str(label) for label in classifier.classes_],
        "cases": [
            {"text": text, "scores": [round(float(p), 6) for p in row]}
            for text, row in zip(probe, proba)
        ],
    }

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=2)
    return len(probe)


def main():
    texts, labels, sources = load_dataset(DATASET)
    print(f"Loaded {len(texts)} labeled phrases from {os.path.relpath(DATASET, HERE)}")

    distribution = {label: labels.count(label) for label in sorted(set(labels))}
    for label, count in distribution.items():
        print(f"  {label:<11} {count}")

    x_train, x_test, y_train, y_test = train_test_split(
        texts, labels,
        test_size=TEST_SIZE,
        random_state=RANDOM_STATE,
        stratify=labels,
    )
    print(f"\nTrain {len(x_train)} / Test {len(x_test)} (stratified)")

    print()
    print("Searching hyperparameters (5-fold CV, scored on KEEP/DROP)...")
    best_params, search_results = search_params(texts, labels)
    for params, mean, std in search_results[:5]:
        print(f"  {mean:.4f} +/- {std:.4f}   {describe(params)}")
    print()
    print(f"Chosen: {describe(best_params)}")

    vectorizer, classifier = build_model(best_params)
    train_matrix = vectorizer.fit_transform(x_train)
    classifier.fit(train_matrix, y_train)
    low, high = best_params["ngram_range"]
    print(f"Vocabulary: {len(vectorizer.vocabulary_)} terms (word {low}-{high} grams)")

    predictions = classifier.predict(vectorizer.transform(x_test))

    accuracy = accuracy_score(y_test, predictions)
    macro = precision_recall_fscore_support(y_test, predictions, average="macro", zero_division=0)
    weighted = precision_recall_fscore_support(y_test, predictions, average="weighted", zero_division=0)
    per_class = precision_recall_fscore_support(
        y_test, predictions, labels=list(classifier.classes_), zero_division=0
    )

    # The optimizer never acts on the four labels directly. It asks one question of each
    # sentence -- "may this go?" -- and FILLER, REDUNDANT and REPETITIVE all mean yes.
    # That collapsed view is the accuracy which actually governs behaviour, and it runs
    # far higher than the four-way figure, because most four-way mistakes are between
    # two removable classes and change no decision.
    to_binary = lambda values: ["KEEP" if v == "IMPORTANT" else "DROP" for v in values]
    binary_accuracy = accuracy_score(to_binary(y_test), to_binary(predictions))
    binary_macro = precision_recall_fscore_support(
        to_binary(y_test), to_binary(predictions), average="macro", zero_division=0
    )

    # 5-fold CV over the whole set. The single held-out split is noisy, and the spread
    # across folds is the more honest number to quote.
    #
    # The WHOLE pipeline is cross-validated, vectorizer included. Fitting the vectorizer
    # on every row first and cross-validating only the classifier over that matrix leaks
    # the test fold's vocabulary and IDF weights into training, which inflates the score
    # -- that is what made the previous CV figure read higher than the held-out one.
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    cv_vectorizer, cv_classifier = build_model(best_params)
    cv_scores = cross_val_score(
        make_pipeline(cv_vectorizer, cv_classifier),
        texts, labels, cv=folds, scoring="accuracy",
    )

    print("\n" + "=" * 62)
    print("HELD-OUT TEST RESULTS")
    print("=" * 62)
    print(classification_report(y_test, predictions, zero_division=0))

    print(f"Accuracy            {accuracy:.4f}")
    print(f"Precision (macro)   {macro[0]:.4f}")
    print(f"Recall    (macro)   {macro[1]:.4f}")
    print(f"F1-score  (macro)   {macro[2]:.4f}")
    print(f"F1-score  (weighted){weighted[2]:.4f}")
    print(f"\n5-fold CV accuracy  {cv_scores.mean():.4f} (+/- {cv_scores.std() * 2:.4f})")

    print("\n" + "-" * 62)
    print("KEEP vs DROP  (the decision the optimizer actually consumes)")
    print("-" * 62)
    print(f"Accuracy            {binary_accuracy:.4f}")
    print(f"Precision (macro)   {binary_macro[0]:.4f}")
    print(f"Recall    (macro)   {binary_macro[1]:.4f}")
    print(f"F1-score  (macro)   {binary_macro[2]:.4f}")

    # Generalisation from generated phrases to the hand-written ones.
    cross = cross_source_score(texts, labels, sources, best_params)
    if cross:
        print()
        print("-" * 62)
        print("GENERATED -> HAND-WRITTEN  (trained without seeing any seed row)")
        print("-" * 62)
        print(f"4-way accuracy      {cross[0]:.4f}  over {cross[2]} hand-written rows")
        print(f"KEEP/DROP accuracy  {cross[1]:.4f}")

    print("\nConfusion matrix (rows = actual, cols = predicted)")
    print("            " + "  ".join(f"{c[:6]:>6}" for c in classifier.classes_))
    for name, row in zip(classifier.classes_, confusion_matrix(y_test, predictions, labels=list(classifier.classes_))):
        print(f"{name:<11} " + "  ".join(f"{v:>6}" for v in row))

    metrics = {
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": describe(best_params),
        "searchedGridPoints": len(search_results),
        "samples": {
            "total": len(texts),
            "train": len(x_train),
            "test": len(x_test),
            "perClass": distribution,
        },
        "accuracy": round(float(accuracy), 4),
        "macro": {
            "precision": round(float(macro[0]), 4),
            "recall": round(float(macro[1]), 4),
            "f1": round(float(macro[2]), 4),
        },
        "weighted": {
            "precision": round(float(weighted[0]), 4),
            "recall": round(float(weighted[1]), 4),
            "f1": round(float(weighted[2]), 4),
        },
        "perClass": {
            label: {
                "precision": round(float(per_class[0][i]), 4),
                "recall": round(float(per_class[1][i]), 4),
                "f1": round(float(per_class[2][i]), 4),
                "support": int(per_class[3][i]),
            }
            for i, label in enumerate(classifier.classes_)
        },
        "binary": {
            "note": "IMPORTANT = KEEP, the other three = DROP; the call the optimizer makes",
            "accuracy": round(float(binary_accuracy), 4),
            "precision": round(float(binary_macro[0]), 4),
            "recall": round(float(binary_macro[1]), 4),
            "f1": round(float(binary_macro[2]), 4),
        },
        "crossSource": ({
            "note": "trained on generated rows only, tested on the hand-written seed set",
            "accuracy": round(float(cross[0]), 4),
            "binaryAccuracy": round(float(cross[1]), 4),
            "testRows": cross[2],
        } if cross else None),
        "crossValidation": {
            "folds": 5,
            "meanAccuracy": round(float(cv_scores.mean()), 4),
            "stdAccuracy": round(float(cv_scores.std()), 4),
            "scores": [round(float(s), 4) for s in cv_scores],
        },
    }

    with open(METRICS_OUT, "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2)

    # Refit on everything before exporting: the split existed to measure, and the
    # shipped model should learn from every labeled example available.
    vectorizer, classifier = build_model(best_params)
    classifier.fit(vectorizer.fit_transform(texts), labels)

    kept, total = export_js(vectorizer, classifier, MODEL_OUT, metrics,
                            describe(best_params))
    probes = write_parity_fixture(vectorizer, classifier, texts, PARITY_OUT)
    size_kb = os.path.getsize(MODEL_OUT) / 1024

    print(f"\nWrote {os.path.relpath(METRICS_OUT, HERE)}")
    print(f"Wrote {os.path.relpath(MODEL_OUT, HERE)}  ({size_kb:.1f} KB, "
          f"{kept}/{total} coefficients kept)")
    print(f"Wrote {os.path.relpath(PARITY_OUT, HERE)}  ({probes} reference predictions)")


if __name__ == "__main__":
    main()
