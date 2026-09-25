"""
PromptMeter synthetic dataset generation.

Produces new labeled phrases for the four-class classifier (IMPORTANT / FILLER /
REDUNDANT / REPETITIVE) and puts every row through the same validation regardless of
where it came from.

    python generate_synthetic.py --provider anthropic --target 10000
    python generate_synthetic.py --provider manual          # author batches by hand
    python generate_synthetic.py --validate-only            # re-run QC on the checkpoint

Three providers:

    anthropic   Claude, via the `anthropic` package and ANTHROPIC_API_KEY.
    openai      Any OpenAI-compatible endpoint, via OPENAI_API_KEY.
    manual      Reads dataset/manual_batches/*.jsonl. Used when no API key is
                configured, and for rows written by a human or by an assistant in
                the loop. Those rows take exactly the same validation path.

Nothing here writes to dataset/phrases.csv, ../utils/ml-model.js or metrics.json. The
production model is changed only by train.py, and only after evaluate_synthetic.py says
the new data helps.

WHY A CHECKPOINT: generation is the expensive half and validation is the cheap half.
Every row is appended to dataset/.synthetic_raw.jsonl as it arrives, so a crashed or
rate-limited run resumes instead of re-paying for what it already has, and
--validate-only can re-score the whole corpus after the guidelines change without
calling the API at all.
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(HERE, "dataset")
ORIGINAL = os.path.join(DATASET_DIR, "phrases.csv")
CHECKPOINT = os.path.join(DATASET_DIR, ".synthetic_raw.jsonl")
MANUAL_DIR = os.path.join(DATASET_DIR, "manual_batches")
OUT_CSV = os.path.join(DATASET_DIR, "synthetic_10000.csv")
REVIEW_CSV = os.path.join(DATASET_DIR, "review_queue.csv")
REPORT = os.path.join(DATASET_DIR, "quality_report.json")

LABELS = ("IMPORTANT", "FILLER", "REDUNDANT", "REPETITIVE")

# Rows shorter or longer than this are almost always a generation accident -- a bare
# word, or a whole prompt pasted in where a single span was asked for.
MIN_CHARS = 8
MAX_CHARS = 320

# Cosine similarity over character 3-5 grams above which two rows count as
# near-duplicates. Chosen by eye on the seed corpus: 0.90 lets "explain recursion to me"
# and "explain recursion for me" both through, 0.80 starts rejecting genuinely different
# sentences that happen to share a stock opening.
NEAR_DUP_THRESHOLD = 0.85


# ---------------------------------------------------------------------------
# Labeling guidelines
#
# These are the definition of the task. They go into the generation prompt, into the
# blind verification prompt, and into the quality report, so that the rule a row was
# generated under, the rule it was checked against, and the rule a human reads while
# clearing the review queue cannot drift apart.
# ---------------------------------------------------------------------------

GUIDELINES = """\
Each example is ONE sentence or clause taken from a prompt written to an AI assistant.

IMPORTANT  The request itself, its subject matter, or any constraint on the answer:
           format, length, language, library or version, audience, exclusions, the
           shape of the output. Detail that LOOKS like small talk but actually
           constrains the answer is IMPORTANT, not FILLER -- "running Python 3.8" rules
           out newer syntax, "I am a complete beginner" sets the register of the
           explanation, "it has to fit on one slide" is a length constraint. If
           removing the span could turn a correct answer into a wrong one, it is
           IMPORTANT.

FILLER     Social or emotional content that constrains nothing: greetings, sign-offs,
           thanks, apologies, the mood of the asker, and backstory no correct answer
           depends on. "My roommate played loud music all night" is FILLER even though
           every word in it is new.

REDUNDANT  On-topic wording that carries no information once removed -- wrappers,
           hedges and tautologies. "I would like to ask you if you could possibly",
           "in order to be able to", "as you probably already know". The span is about
           the task; it just says nothing about it.

REPETITIVE Restates something the prompt has ALREADY said. The repetition is the whole
           reason for the label, so a repetitive span is only recognisable next to what
           it repeats -- see the `context` field.

The boundary got wrong most often: FILLER is off-task, REDUNDANT is on-task but empty.
"Thanks so much!" is FILLER. "I was wondering if you would be able to" is REDUNDANT.
"""

# Axes the generator samples from, so that consecutive batches are not variations of one
# another. The combination goes into the prompt; it is not stored as a feature.
DOMAINS = [
    "software engineering", "debugging a failing program", "mathematics homework",
    "university coursework", "school-level science", "academic research",
    "business and operations", "marketing copy", "creative writing", "data analysis",
    "devops and infrastructure", "web frontend work", "mobile app development",
    "machine learning", "databases and SQL", "system design interviews",
    "legal or policy questions", "medical or health questions", "cooking and recipes",
    "travel planning", "personal finance", "job applications and CVs",
    "language learning", "game development", "hardware and electronics",
    "spreadsheet formulas", "everyday trivia", "technical troubleshooting",
    "exam preparation", "product management", "teaching and lesson planning",
    "scientific writing",
]

REGISTERS = [
    "formal written English",
    "casual conversational English",
    "text-message style with abbreviations (u, pls, tmrw, rn)",
    "hurried English with typos and missing apostrophes",
    "English written by a fluent non-native speaker, with article and tense slips",
    "English influenced by Indian English phrasing",
    "developer shorthand, heavy on jargon and acronyms",
    "polite over-formal corporate email English",
    "lowercase, no punctuation, stream of thought",
    "student English written under time pressure",
]

DIFFICULTIES = [
    "straightforward and unambiguous",
    "straightforward and unambiguous",
    "HARD: the span looks like small talk or backstory but is actually a real "
    "constraint on the answer, so the correct label is IMPORTANT",
    "HARD: the span contains real technical vocabulary, a number, a URL or a code "
    "fragment, but is still removable",
    "HARD: sits close to the boundary between two labels and needs the guidelines to "
    "settle",
]


def build_prompt(label, count, domain, register, difficulty, avoid):
    """
    The generation prompt for one batch.

    `avoid` is a sample of rows already held. Without it the model returns its own
    favourite sentences over and over: a batch asking for FILLER produces "thanks in
    advance" in nearly every call. Showing it what already exists moves the output into
    unused space, which is far cheaper than generating duplicates and deleting them.
    """
    context_rule = ""
    if label == "REPETITIVE":
        context_rule = (
            "\nBecause REPETITIVE only means anything next to what it repeats, give "
            "each example a `context` field holding the earlier part of the prompt that "
            "`text` restates. `text` must be the repeating span alone.\n"
        )

    avoid_block = ""
    if avoid:
        shown = "\n".join("- " + item for item in avoid)
        avoid_block = (
            "\nThese already exist. Do not repeat them and do not paraphrase them; go "
            "somewhere else in the space:\n" + shown + "\n"
        )

    context_field = ', "context": "..."' if label == "REPETITIVE" else ""

    return (
        GUIDELINES
        + "\nWrite {n} NEW examples labeled {label}.\n\n".format(n=count, label=label)
        + "Domain: {0}\nVoice: {1}\nDifficulty: {2}\n".format(domain, register, difficulty)
        + context_rule
        + avoid_block
        + "\nRules:\n"
          "- Vary length, structure and vocabulary between examples. No shared template.\n"
          "- Keep code, URLs, numbers, version strings and technical terms intact and\n"
          "  realistic.\n"
          "- Write what a real person types, not a textbook sentence about prompting.\n"
          "- Every example must genuinely satisfy the {label} definition above.\n\n"
          "Return ONLY a JSON array, no prose around it:\n"
          '[{{"text": "...", "label": "{label}"{ctx}}}]\n'.format(label=label, ctx=context_field)
    )


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

def call_anthropic(prompt, model):
    import anthropic  # imported lazily: only this provider needs the package
    client = anthropic.Anthropic()
    message = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(block.text for block in message.content if block.type == "text")


def call_openai(prompt, model):
    from openai import OpenAI
    client = OpenAI()
    response = client.chat.completions.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content


def parse_rows(raw, label):
    """
    Pulls the JSON array out of a model response.

    Models wrap the array in a fence or a sentence often enough that requiring the whole
    response to parse would throw away good batches, so the first '[' through the last
    ']' is taken instead.
    """
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        items = json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        return []

    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = (item.get("text") or "").strip()
        if text:
            rows.append({
                "text": text,
                "label": (item.get("label") or label).strip().upper(),
                "context": (item.get("context") or "").strip(),
            })
    return rows


# ---------------------------------------------------------------------------
# Checkpoint
# ---------------------------------------------------------------------------

def load_checkpoint():
    if not os.path.exists(CHECKPOINT):
        return []
    rows = []
    with open(CHECKPOINT, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def append_checkpoint(rows):
    with open(CHECKPOINT, "a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_manual_batches():
    """
    Reads hand-authored batches from dataset/manual_batches/*.jsonl.

    One JSON object per line: {"text": ..., "label": ..., "context": ..., "batch": ...}.
    This is the path used when no API key is configured. Those rows are not trusted any
    further than generated ones -- they go through the identical validator.
    """
    rows = []
    if not os.path.isdir(MANUAL_DIR):
        return rows
    for name in sorted(os.listdir(MANUAL_DIR)):
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(MANUAL_DIR, name), encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError as err:
                    print("  ! {0}:{1} is not JSON ({2}); skipped".format(name, number, err))
                    continue
                item.setdefault("batch", os.path.splitext(name)[0])
                rows.append(item)
    return rows


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def normalise(text):
    """Casefolded, punctuation-stripped form, used for exact-duplicate comparison only."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


CODE_LIKE = re.compile(r"https?://|`|\bdef \w|\bSELECT\b|\bimport \w|\w+\(\)|[{};]\s*$")
CONSTRAINT_LIKE = re.compile(
    r"\b\d+\s*(words?|characters?|lines?|pages?|slides?|minutes?|rows?|bullets?|steps?)\b"
    r"|\bpython\s*[23]\.\d"
    r"|\bno\s+(external|third.party)\b"
    r"|\bonly\s+use\b"
    r"|\bmust\s+(be|not)\b",
    re.I,
)
GREETING_ONLY = re.compile(
    r"(hi|hello|hey|thanks|thank you|cheers|please)\b.{0,20}$", re.I
)

SUFFIXES = ("ation", "ing", "ion", "ness", "ed", "ly", "es", "s", "e")


def stem(word):
    """Crudest possible stemmer: enough to see that `document` and `documented` are the
    same word, not enough to be a linguistic claim. Used only by the check below."""
    for suffix in SUFFIXES:
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[:-len(suffix)]
    return word


def repeats_internally(text):
    """
    True when a content word occurs twice inside the span itself.

    A REPETITIVE span normally needs the earlier text it restates, but not always:
    "debug it, find the bug and fix the bug" carries its own evidence, and that
    self-contained kind is most of what the seed corpus holds -- which matters, because
    the browser classifier is handed one span with no context and can only ever learn
    this kind. Rows like these are not ambiguous and should not go to review.
    """
    stems = [stem(word) for word in re.findall(r"[a-z]{3,}", text.lower())]
    counts = Counter(stems)
    return any(count > 1 for count in counts.values())


def heuristic_flags(row):
    """
    Cheap rule-based disagreement checks. They do not decide a label -- they decide
    whether a human should look at it.

    The expensive mistake in this dataset is a row that teaches the model to delete a
    constraint, so the checks are deliberately one-sided: they fire on a removable label
    attached to text that looks load-bearing, and not the other way round.
    """
    flags = []
    text, label = row["text"], row["label"]

    if label != "IMPORTANT":
        if CODE_LIKE.search(text):
            flags.append("removable-label-on-code-or-url")
        if CONSTRAINT_LIKE.search(text):
            flags.append("removable-label-on-explicit-constraint")
    if label == "REPETITIVE" and not row.get("context") and not repeats_internally(text):
        flags.append("repetitive-with-nothing-to-repeat")
    if label == "IMPORTANT" and GREETING_ONLY.match(text.strip()):
        flags.append("important-label-on-greeting")
    return flags


def near_duplicate_pairs(texts, threshold=NEAR_DUP_THRESHOLD):
    """
    Finds rows that are near-duplicates of an earlier row.

    Character 3-5 grams rather than words, because the duplicates that matter here are
    the ones a word-level check misses: "explain recursion simply" and "explain recursion
    simple" share no bigram but are the same example. Compared in blocks, so a
    10,000-row corpus never needs a 10,000 x 10,000 dense matrix in memory at once.

    @returns dict of {duplicate index: index of the earlier row it duplicates}
    """
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import linear_kernel
    import numpy as np

    if len(texts) < 2:
        return {}

    matrix = TfidfVectorizer(
        analyzer="char_wb", ngram_range=(3, 5), min_df=1
    ).fit_transform(texts)

    duplicates = {}
    block = 512
    for start in range(0, matrix.shape[0], block):
        stop = min(start + block, matrix.shape[0])
        similarity = linear_kernel(matrix[start:stop], matrix[:stop])
        for offset in range(stop - start):
            index = start + offset
            earlier = similarity[offset][:index]        # compare against earlier rows only
            if earlier.size and earlier.max() >= threshold:
                duplicates[index] = int(np.argmax(earlier))
    return duplicates


def load_original_texts():
    if not os.path.exists(ORIGINAL):
        return set()
    with open(ORIGINAL, newline="", encoding="utf-8") as handle:
        return {normalise(row["text"]) for row in csv.DictReader(handle) if row.get("text")}


def validate(rows):
    """
    Applies every quality gate and splits the corpus three ways.

    @returns (accepted, review, rejection reason counter). Review rows are
             accepted-but-flagged: they go to review_queue.csv rather than being
             silently trusted or silently dropped.
    """
    original = load_original_texts()
    reasons = Counter()
    kept, rejected, seen = [], [], {}

    for row in rows:
        text = (row.get("text") or "").strip()
        label = (row.get("label") or "").strip().upper()
        reason = None

        if not text or label not in LABELS:
            reason = "bad-schema"
        elif len(text) < MIN_CHARS:
            reason = "too-short"
        elif len(text) > MAX_CHARS:
            reason = "too-long"
        else:
            key = normalise(text)
            if key in original:
                reason = "duplicate-of-original-dataset"
            elif key in seen:
                reason = "exact-duplicate"
            else:
                seen[key] = len(kept)

        if reason:
            reasons[reason] += 1
            rejected.append(dict(row, reason=reason))
        else:
            kept.append({
                "text": text,
                "label": label,
                "context": (row.get("context") or "").strip(),
                "batch": row.get("batch", ""),
            })

    # Near-duplicates are found across the whole surviving corpus at once, not per batch:
    # the same sentence arriving in batch 3 and again in batch 40 is the case that
    # matters, and a per-batch check would never see it.
    duplicates = near_duplicate_pairs([row["text"] for row in kept])
    survivors = []
    for index, row in enumerate(kept):
        if index in duplicates:
            reasons["near-duplicate"] += 1
        else:
            survivors.append(row)

    accepted, review = [], []
    for row in survivors:
        flags = heuristic_flags(row)
        if flags:
            review.append(dict(row, flags=",".join(flags)))
        else:
            accepted.append(row)

    return accepted, review, reasons


VERIFY_PROMPT = """{guidelines}
Label this span. Answer with one word only: IMPORTANT, FILLER, REDUNDANT or REPETITIVE.
{context_line}Span: {text}
"""


def verify(rows, call, model, sample=None):
    """
    Second-pass blind labeling.

    The generator was told the label before it wrote the text, so its label is an
    instruction rather than a judgement -- the row is only evidence that a model can
    write something it believes fits. Asking a fresh call to label the span with the
    label withheld is a real check, and the rows where the two disagree are exactly the
    ambiguous ones a human should see.

    @returns (agreed rows, disagreed rows, agreement rate)
    """
    subject = rows if sample is None else random.sample(rows, min(sample, len(rows)))
    agreed, disagreed = [], []

    for index, row in enumerate(subject, 1):
        context_line = ""
        if row.get("context"):
            context_line = "Earlier in the same prompt: {0}\n".format(row["context"])
        prompt = VERIFY_PROMPT.format(
            guidelines=GUIDELINES, context_line=context_line, text=row["text"]
        )
        try:
            answer = call(prompt, model).strip().upper()
        except Exception as err:                        # noqa: BLE001 - any API error
            print("  ! verification call failed at {0}: {1}".format(index, err))
            break
        predicted = next((label for label in LABELS if label in answer), None)
        if predicted == row["label"]:
            agreed.append(row)
        else:
            disagreed.append(dict(
                row, flags="blind-label-disagreed:" + (predicted or "unparsed")
            ))
        if index % 50 == 0:
            print("  verified {0}/{1}".format(index, len(subject)))

    checked = len(agreed) + len(disagreed)
    # Rows never reached because the API failed part-way stay accepted; they were not
    # checked, and treating unchecked as failed would silently delete good data.
    unchecked = [row for row in rows if row not in subject] + subject[checked:]
    return agreed + unchecked, disagreed, (len(agreed) / checked if checked else 0.0)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_csv(path, rows, fields, source):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            record = {"text": row["text"], "label": row["label"], "source": source}
            if "context" in fields:
                record["context"] = row.get("context", "")
            if "flags" in fields:
                record["flags"] = row.get("flags", "")
            writer.writerow(record)


def generate(args, rows, call):
    """Fills the corpus up to --target, one batch per call, label-balanced."""
    produced = Counter(row["label"] for row in rows)
    per_label = args.target // len(LABELS)

    while any(produced[label] < per_label for label in LABELS):
        label = min(LABELS, key=lambda name: produced[name])
        pool = [row["text"] for row in rows if row["label"] == label]
        prompt = build_prompt(
            label, args.batch_size,
            random.choice(DOMAINS), random.choice(REGISTERS), random.choice(DIFFICULTIES),
            random.sample(pool, min(12, len(pool))),
        )
        try:
            batch = parse_rows(call(prompt, args.model), label)
        except Exception as err:                        # noqa: BLE001 - any API error
            print("  ! generation call failed: {0}".format(err))
            print("  stopping; the checkpoint keeps everything produced so far")
            break
        if not batch:
            print("  ! batch returned nothing usable; continuing")
            continue
        append_checkpoint(batch)
        rows += batch
        produced[label] += len(batch)
        print("  {0:<11} +{1:<3} (raw total {2}/{3})".format(
            label, len(batch), sum(produced.values()), args.target))
    return rows


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--provider", choices=("anthropic", "openai", "manual"),
                        default="manual")
    parser.add_argument("--model", default="claude-opus-5")
    parser.add_argument("--target", type=int, default=10000,
                        help="total accepted rows wanted")
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--verify", action="store_true",
                        help="blind re-label every accepted row (doubles API cost)")
    parser.add_argument("--verify-sample", type=int, default=None,
                        help="blind re-label only this many rows")
    parser.add_argument("--validate-only", action="store_true",
                        help="re-run QC over the checkpoint without generating")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    call = {"anthropic": call_anthropic, "openai": call_openai}.get(args.provider)

    rows = load_checkpoint()
    print("Checkpoint holds {0} raw rows".format(len(rows)))

    if args.provider == "manual":
        manual = load_manual_batches()
        known = {normalise(row.get("text") or "") + "|" + (row.get("label") or "")
                 for row in rows}
        fresh = [row for row in manual
                 if normalise(row.get("text") or "") + "|" + (row.get("label") or "")
                 not in known]
        if fresh:
            append_checkpoint(fresh)
            rows += fresh
        print("Read {0} rows from manual_batches ({1} new)".format(len(manual), len(fresh)))

    elif not args.validate_only:
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")):
            print("No API key in the environment. "
                  "See 'Configuring a generation provider' in ml/README.md.")
            return 1
        rows = generate(args, rows, call)

    accepted, review, reasons = validate(rows)

    agreement = None
    if args.verify or args.verify_sample:
        if not call:
            print("--verify needs an API provider; skipped")
        else:
            print("\nBlind verification of {0} rows...".format(
                args.verify_sample or len(accepted)))
            accepted, disagreed, agreement = verify(
                accepted, call, args.model, args.verify_sample)
            review += disagreed

    write_csv(OUT_CSV, accepted, ["text", "label", "source", "context"], "synthetic")
    write_csv(REVIEW_CSV, review,
              ["text", "label", "source", "context", "flags"], "synthetic-review")

    per_label = Counter(row["label"] for row in accepted)
    lengths = sorted(len(row["text"]) for row in accepted) or [0]
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "provider": args.provider,
        "model": args.model if args.provider != "manual" else None,
        "requested": args.target,
        "rawRows": len(rows),
        "accepted": len(accepted),
        "flaggedForReview": len(review),
        "rejected": sum(reasons.values()),
        "shortfall": max(0, args.target - len(accepted)),
        "labelCounts": {label: per_label.get(label, 0) for label in LABELS},
        "rejectionReasons": dict(reasons),
        "reviewFlagCounts": dict(Counter(
            flag for row in review for flag in row["flags"].split(",")
        )),
        "blindVerification": (
            {"note": "accepted rows re-labeled with the label withheld",
             "agreementRate": round(agreement, 4)}
            if agreement is not None else
            {"note": "not run -- needs an API provider", "agreementRate": None}
        ),
        "length": {
            "minChars": lengths[0],
            "maxChars": lengths[-1],
            "medianChars": lengths[len(lengths) // 2],
        },
        "withContext": sum(1 for row in accepted if row.get("context")),
        "nearDuplicateThreshold": NEAR_DUP_THRESHOLD,
        "guidelines": GUIDELINES,
        "outputs": {
            "dataset": os.path.relpath(OUT_CSV, HERE),
            "reviewQueue": os.path.relpath(REVIEW_CSV, HERE),
        },
    }
    with open(REPORT, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)

    print("\n" + "=" * 62)
    print("raw {0}  ->  accepted {1}   review {2}   rejected {3}".format(
        len(rows), len(accepted), len(review), sum(reasons.values())))
    for label in LABELS:
        print("  {0:<11} {1}".format(label, per_label.get(label, 0)))
    if reasons:
        print("rejected because:")
        for reason, count in reasons.most_common():
            print("  {0:<34} {1}".format(reason, count))
    if report["shortfall"]:
        print("\nSHORTFALL: {0} rows short of the {1} requested.".format(
            report["shortfall"], args.target))
    print("\nWrote " + os.path.relpath(OUT_CSV, HERE))
    print("Wrote " + os.path.relpath(REVIEW_CSV, HERE))
    print("Wrote " + os.path.relpath(REPORT, HERE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
