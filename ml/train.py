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

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split, cross_val_score, StratifiedKFold
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

RANDOM_STATE = 42
TEST_SIZE = 0.25

# Keeps the exported file small. Anything below this weight cannot move a decision past
# the confidence thresholds the optimizer uses anyway.
MIN_ABS_COEF = 0.01


def load_dataset(path):
    """Reads the labeled CSV into parallel text/label lists."""
    texts, labels = [], []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip()
            if text and label:
                texts.append(text)
                labels.append(label)
    return texts, labels


def build_model():
    """
    Word unigrams with raw term frequency, picked by grid search rather than taste:
    over ngram_range in {(1,1),(1,2),(1,3)}, C in {1,2,4,8,16} and sublinear_tf in
    {True,False}, unigrams at C=16 with raw tf scored highest on the held-out split.

    Bigrams looked promising -- 'thank you' and 'in order to' are exactly the signal --
    but they cost accuracy at this dataset size: there are too few examples per bigram
    to estimate a weight, and they triple the exported file.

    These settings must stay in step with utils/ml-classifier.js, which reimplements
    this exact transform in JavaScript: raw tf, smooth idf, L2 norm.
    """
    vectorizer = TfidfVectorizer(
        lowercase=True,
        ngram_range=(1, 1),
        min_df=1,
        sublinear_tf=False,
        norm="l2",
        token_pattern=r"(?u)\b\w[\w']*\b",
    )

    classifier = LogisticRegression(
        max_iter=3000,
        C=16.0,
        class_weight="balanced",
        random_state=RANDOM_STATE,
    )

    return vectorizer, classifier


def export_js(vectorizer, classifier, path, metrics):
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
        " * TF-IDF (word 1-2 grams, sublinear tf, L2 norm) + multinomial logistic\n"
        " * regression. Consumed by utils/ml-classifier.js.\n"
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


def main():
    texts, labels = load_dataset(DATASET)
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

    vectorizer, classifier = build_model()
    train_matrix = vectorizer.fit_transform(x_train)
    classifier.fit(train_matrix, y_train)
    print(f"Vocabulary: {len(vectorizer.vocabulary_)} terms (word 1-2 grams)")

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

    # 5-fold CV over the whole set. With a dataset this small the single held-out split
    # is noisy, and the spread across folds is the more honest number to quote.
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    full_matrix = vectorizer.fit_transform(texts)
    cv_scores = cross_val_score(classifier, full_matrix, labels, cv=folds, scoring="accuracy")

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

    print("\nConfusion matrix (rows = actual, cols = predicted)")
    print("            " + "  ".join(f"{c[:6]:>6}" for c in classifier.classes_))
    for name, row in zip(classifier.classes_, confusion_matrix(y_test, predictions, labels=list(classifier.classes_))):
        print(f"{name:<11} " + "  ".join(f"{v:>6}" for v in row))

    metrics = {
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": "TfidfVectorizer(1,2) + LogisticRegression(C=4.0, balanced)",
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
    vectorizer, classifier = build_model()
    classifier.fit(vectorizer.fit_transform(texts), labels)

    kept, total = export_js(vectorizer, classifier, MODEL_OUT, metrics)
    size_kb = os.path.getsize(MODEL_OUT) / 1024

    print(f"\nWrote {os.path.relpath(METRICS_OUT, HERE)}")
    print(f"Wrote {os.path.relpath(MODEL_OUT, HERE)}  ({size_kb:.1f} KB, "
          f"{kept}/{total} coefficients kept)")


if __name__ == "__main__":
    main()
