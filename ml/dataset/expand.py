"""
Dataset expansion for the PromptMeter phrase classifier -- AN EXPERIMENT THAT DID NOT
PAY OFF. Kept so the negative result is on the record rather than rediscovered.

The idea was that the hand-written seed set (512 rows) was too small, and that composing
more rows from word banks would lift a four-class linear model above its ~79% held-out
accuracy. Expanding to 1680 rows appears to do exactly that: four-way accuracy jumps to
0.95 and KEEP/DROP to 0.97.

Those numbers are an illusion, and the way to see it is to score only on rows a human
wrote. Two measurements say so:

    Trained on generated rows alone, tested on all 512 hand-written rows:
        4-way 0.584, KEEP/DROP 0.721 -- far below the headline.

    Five-fold CV scored ONLY on held-out hand-written rows:
        seed only          4-way 0.787   KEEP/DROP 0.910
        seed + generated   4-way 0.797   KEEP/DROP 0.904

Adding 1168 generated rows moves four-way accuracy by +0.01 (inside the fold-to-fold
spread) and moves the KEEP/DROP decision -- the only call the optimizer actually
consumes -- slightly the wrong way. The apparent gain was the test set grading the model
on rows that share a skeleton with its training data.

So phrases.csv ships as the hand-written set alone. The genuine improvement that run
found was in train.py's hyperparameter search, not here: searching ngram_range,
sublinear_tf, min_df and C moved held-out four-way accuracy from 0.711 to about 0.79 on
the same 512 rows.

If you want to grow the dataset, write real phrases. Generating them from templates
teaches the model the templates.

Run (writes phrases.csv with a `source` column; train.py reads it and will report the
generated-to-hand-written generalisation gap):
    python expand.py --dry-run
    python expand.py
"""

import argparse
import csv
import io
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "phrases.csv")
SEED_PATH = os.path.join(HERE, "seed.csv")

RANDOM_SEED = 20260923
TARGET_PER_CLASS = 420


# ---------------------------------------------------------------------------
# Word banks. Kept as plain lists so a new example means a new word, not new code.
# ---------------------------------------------------------------------------

SUBJECTS = [
    "binary search", "recursion", "the OSI model", "quicksort", "dynamic programming",
    "hash tables", "linked lists", "graph traversal", "the event loop", "closures",
    "garbage collection", "virtual memory", "deadlocks", "normalization", "indexing",
    "transactions", "REST APIs", "GraphQL", "OAuth", "JWT tokens", "CORS",
    "dependency injection", "unit testing", "CI pipelines", "containers",
    "load balancing", "caching strategies", "sharding", "replication", "consensus",
    "gradient descent", "backpropagation", "overfitting", "regularization",
    "cross validation", "feature scaling", "decision trees", "random forests",
    "support vector machines", "k-means clustering", "PCA", "attention mechanisms",
    "transformers", "tokenization", "embeddings", "the French Revolution",
    "photosynthesis", "cellular respiration", "Newton's laws", "thermodynamics",
    "supply and demand", "opportunity cost", "inflation", "compound interest",
    "the water cycle", "plate tectonics", "natural selection", "Mendelian genetics",
]

ARTIFACTS = [
    "a Python script", "a JavaScript function", "a SQL query", "a shell script",
    "a React component", "a unit test", "a regex", "a Dockerfile", "a CSV parser",
    "a REST endpoint", "a migration", "a config file", "a class diagram",
    "a summary", "an outline", "a study plan", "a lesson plan", "a cover letter",
    "a bug report", "a commit message", "a README", "a changelog", "a test matrix",
]

ASK_VERBS = ["Write", "Explain", "Summarize", "Compare", "Describe", "Outline",
             "Generate", "Refactor", "Debug", "Optimize", "Review", "Implement",
             "Convert", "Translate", "Analyze", "Derive", "Prove", "Draft"]

CONSTRAINTS = [
    "Keep it under {n} words", "Use exactly {n} bullet points",
    "Format the answer as a markdown table", "Return valid JSON only",
    "Do not include code examples", "Use only the standard library",
    "Target a {n}th grade reading level", "Cite your sources inline",
    "Answer in {n} sentences or fewer", "Use British spelling throughout",
    "Show the intermediate steps", "Assume the reader is a beginner",
    "Avoid any external dependencies", "Write it in the past tense",
    "Include a worked example", "Limit the response to {n} paragraphs",
    "Use snake_case for all identifiers", "Sort the results by date descending",
    "Handle the empty input case", "Round every figure to {n} decimal places",
]

PROBLEMS = [
    "The build fails with an out of memory error",
    "The request times out after {n} seconds",
    "The test passes locally but fails in CI",
    "The query returns duplicate rows",
    "The component re-renders on every keystroke",
    "The migration locks the table for {n} minutes",
    "Memory usage grows until the process is killed",
    "The login redirect loops forever",
    "The parser chokes on unicode input",
    "The cache never invalidates",
    "Sorting is unstable for equal keys",
    "The webhook fires twice for one event",
]

# FILLER: greeting, mood, backstory, sign-off. Carries nothing the model can act on.
FILLER_OPENERS = [
    "Hello there", "Hi", "Hey", "Good morning", "Good evening", "Greetings",
    "Hey there friend", "Yo", "Howdy", "Dear assistant",
]
FILLER_TAILS = [
    "hope you are doing well", "how are you today", "hope your day is going great",
    "I hope this finds you well", "sorry to bother you", "hope you don't mind me asking",
    "thanks so much in advance", "any help would be appreciated",
    "thanks a ton for your time", "much appreciated", "cheers", "best regards",
    "looking forward to your reply", "thanks again seriously",
]
FILLER_STATES = [
    "I am really stressed about this", "I have been panicking all night",
    "I am completely lost here", "I feel so dumb asking this",
    "I am exhausted and running on coffee", "my brain has stopped working",
    "I am freaking out a little", "I have zero motivation today",
    "I am so bored right now", "I am kind of desperate at this point",
    "my exam is tomorrow and I have not studied", "I only have two days left",
    "my professor gave us a huge syllabus", "I missed all the lectures",
    "I was scrolling and saw a video about this", "I googled it but understood nothing",
    "I have been learning this for three months", "I am in my final year",
    "I am new here and posting for the first time", "I skipped class last week",
]

# REDUNDANT: wordy wrappers and tautologies that say nothing on their own.
REDUNDANT_PHRASES = [
    "I would like you to please go ahead and",
    "what I am trying to say here is that",
    "the thing that I wanted to ask about is",
    "in order to be able to properly do this",
    "due to the fact that this happens to be the case",
    "at this particular point in time right now",
    "for all intents and purposes basically speaking",
    "it is important to note the fact that",
    "I want you to know that I need you to",
    "can you please go ahead and kindly",
    "I was wondering if you could possibly maybe",
    "is there any chance that you might be able to",
    "if it is not too much trouble could you",
    "I would really appreciate it if you would",
    "what I mean to say by that is",
    "the reason why I am asking is because",
    "in the event that it turns out that",
    "with regard to the matter of",
    "for the purpose of being able to",
    "it goes without saying that obviously",
    "needless to say it should be mentioned",
    "as a matter of fact it is actually true that",
    "I just wanted to quickly reach out and ask",
    "allow me to take a moment to explain that",
    "let me start by first saying that",
    "before I begin I should probably mention",
    "to give you a little bit of background context",
    "just so you know ahead of time",
    "I will try my best to explain what I mean",
    "hopefully that makes at least some sense",
]

# REPETITIVE: restates something already said, or stacks synonyms.
REPEAT_STACKS = [
    ("detailed", "comprehensive", "thorough", "in-depth"),
    ("simple", "easy", "basic", "straightforward"),
    ("quick", "fast", "rapid", "speedy"),
    ("clear", "understandable", "plain", "obvious"),
    ("complete", "full", "entire", "whole"),
    ("short", "brief", "concise", "succinct"),
    ("accurate", "correct", "precise", "exact"),
    ("careful", "meticulous", "rigorous", "painstaking"),
]
REPEAT_TEMPLATES = [
    "The {noun} needs to have {item}",
    "Make sure the {noun} includes {item}",
    "I want the {noun} to contain {item}",
    "Do not forget that the {noun} requires {item}",
    "Remember the {noun} should have {item}",
]
REPEAT_NOUNS = ["essay", "report", "answer", "summary", "document", "slide deck",
                "presentation", "article", "response", "write-up"]
REPEAT_ITEMS = ["an introduction", "a body paragraph", "a conclusion", "references",
                "a title page", "a bibliography", "an abstract", "headings",
                "a table of contents", "page numbers", "citations", "a summary section"]


def important_rows(rng, count):
    """Instructions, constraints, subject matter and problem statements."""
    out = set()
    while len(out) < count:
        pick = rng.random()
        n = rng.choice([3, 5, 100, 200, 300, 500, 8, 10, 2, 20])
        if pick < 0.30:
            out.add(f"{rng.choice(ASK_VERBS)} {rng.choice(SUBJECTS)}")
        elif pick < 0.50:
            out.add(f"{rng.choice(ASK_VERBS)} {rng.choice(ARTIFACTS)} that handles "
                    f"{rng.choice(SUBJECTS)}")
        elif pick < 0.70:
            out.add(rng.choice(CONSTRAINTS).format(n=n))
        elif pick < 0.85:
            out.add(rng.choice(PROBLEMS).format(n=n))
        else:
            out.add(f"{rng.choice(ASK_VERBS)} how {rng.choice(SUBJECTS)} works "
                    f"and why it matters")
    return sorted(out)


def filler_rows(rng, count):
    """Greetings, moods, backstory and sign-offs."""
    out = set()
    while len(out) < count:
        pick = rng.random()
        if pick < 0.25:
            out.add(f"{rng.choice(FILLER_OPENERS)} {rng.choice(FILLER_TAILS)}")
        elif pick < 0.45:
            out.add(rng.choice(FILLER_TAILS).capitalize())
        elif pick < 0.80:
            out.add(rng.choice(FILLER_STATES))
        else:
            out.add(f"{rng.choice(FILLER_STATES)} and {rng.choice(FILLER_TAILS)}")
    return sorted(out)


def redundant_rows(rng, count):
    """Wordy wrappers that carry no instruction of their own."""
    out = set()
    joiners = ["and", "so", "but", "which is why", "meaning that"]
    while len(out) < count:
        pick = rng.random()
        if pick < 0.55:
            out.add(rng.choice(REDUNDANT_PHRASES))
        else:
            a, b = rng.sample(REDUNDANT_PHRASES, 2)
            out.add(f"{a} {rng.choice(joiners)} {b}")
    return sorted(out)


def repetitive_rows(rng, count):
    """Restatements and stacked synonyms."""
    out = set()
    while len(out) < count:
        pick = rng.random()
        if pick < 0.40:
            stack = rng.choice(REPEAT_STACKS)
            k = rng.randint(3, 4)
            out.add("I want it to be " + " and ".join(stack[:k]))
        elif pick < 0.75:
            template = rng.choice(REPEAT_TEMPLATES)
            out.add(template.format(noun=rng.choice(REPEAT_NOUNS),
                                    item=rng.choice(REPEAT_ITEMS)))
        else:
            verb = rng.choice(["explain", "describe", "summarize", "list", "write"])
            out.add(f"Please {verb} it and then {verb} it again properly")
    return sorted(out)


BUILDERS = {
    "IMPORTANT": important_rows,
    "FILLER": filler_rows,
    "REDUNDANT": redundant_rows,
    "REPETITIVE": repetitive_rows,
}


def load_seed(path):
    """Reads the existing dataset, preserving order."""
    rows = []
    with io.open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip()
            if text and label:
                rows.append((text, label))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rng = random.Random(RANDOM_SEED)
    seed_rows = load_seed(SEED_PATH)
    seen = {text.lower() for text, _ in seed_rows}

    print(f"Seed set: {len(seed_rows)} rows (from {os.path.basename(SEED_PATH)})")

    additions = []
    for label in sorted(BUILDERS):
        have = sum(1 for _, existing in seed_rows if existing == label)
        need = max(0, TARGET_PER_CLASS - have)
        # Over-generate, then keep only rows the seed set does not already contain.
        candidates = BUILDERS[label](rng, need + 120)
        rng.shuffle(candidates)

        kept = 0
        for text in candidates:
            if kept >= need:
                break
            if text.lower() in seen:
                continue
            seen.add(text.lower())
            additions.append((text, label))
            kept += 1
        print(f"  {label:<11} have {have:>3}  added {kept:>3}  -> {have + kept}")

    print(f"\nTotal after expansion: {len(seed_rows) + len(additions)} rows")

    if args.dry_run:
        print("Dry run: nothing written.")
        return

    with io.open(CSV_PATH, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["text", "label", "source"])
        for text, label in seed_rows:
            writer.writerow([text, label, "seed"])
        for text, label in additions:
            writer.writerow([text, label, "generated"])

    print(f"Wrote {os.path.relpath(CSV_PATH, HERE)}")


if __name__ == "__main__":
    main()
