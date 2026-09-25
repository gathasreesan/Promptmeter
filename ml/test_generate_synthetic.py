"""
Self-check for the synthetic generation pipeline.

    python test_generate_synthetic.py

No framework on purpose -- plain asserts, matching the assert-based JavaScript suites in
tests/. What is checked here is the part that can fail silently: the validator. A broken
duplicate check or a mislabelled flag does not raise, it just quietly lets bad rows into
training data, and the damage only shows up as a model that deletes things it should
keep.
"""

import random
import sys

from generate_synthetic import (
    build_prompt,
    heuristic_flags,
    near_duplicate_pairs,
    normalise,
    parse_rows,
    repeats_internally,
    validate,
    verify,
)

passed = failed = 0


def check(name, condition):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL  " + name)


def row(text, label, context=""):
    return {"text": text, "label": label, "context": context}


# --- normalise ------------------------------------------------------------------
check("normalise casefolds and strips punctuation",
      normalise("Explain, PLEASE!") == "explain please")
check("normalise collapses whitespace",
      normalise("a   b\n c") == "a b c")

# --- parse_rows -----------------------------------------------------------------
check("parse_rows digs the array out of a fenced response",
      len(parse_rows('here you go:\n```json\n[{"text":"aaa bbb","label":"FILLER"}]\n```',
                     "FILLER")) == 1)
check("parse_rows survives unparseable output",
      parse_rows("sorry, I cannot do that", "FILLER") == [])
check("parse_rows defaults a missing label to the requested one",
      parse_rows('[{"text":"some phrase here"}]', "REDUNDANT")[0]["label"] == "REDUNDANT")

# --- repeats_internally ---------------------------------------------------------
check("sees a bare repeated word",
      repeats_internally("debug it, find the bug and fix the bug"))
check("sees a repeat across an inflection",
      repeats_internally("document it, add documentation, documented properly"))
check("sees compare/comparison as one stem",
      repeats_internally("compare them, give me a comparison, compare the two"))
check("does not fire on an ordinary sentence",
      not repeats_internally("i repeat it is postgres not mysql"))

# --- heuristic_flags ------------------------------------------------------------
check("flags a url under a removable label",
      "removable-label-on-code-or-url"
      in heuristic_flags(row("see https://example.com for the spec", "FILLER")))
check("flags an explicit constraint under a removable label",
      "removable-label-on-explicit-constraint"
      in heuristic_flags(row("keep it under 500 words", "REDUNDANT")))
check("leaves a plain IMPORTANT row alone",
      heuristic_flags(row("write a python script that reads a csv", "IMPORTANT")) == [])
check("flags REPETITIVE with neither context nor internal repetition",
      "repetitive-with-nothing-to-repeat"
      in heuristic_flags(row("i repeat it is postgres not mysql", "REPETITIVE")))
check("accepts REPETITIVE carrying its own repetition",
      heuristic_flags(row("test it, write tests, I want tests", "REPETITIVE")) == [])
check("accepts REPETITIVE carrying context",
      heuristic_flags(row("again, no gpu", "REPETITIVE", "We have no gpu.")) == [])
# The one-sided design: a constraint under IMPORTANT is the safe direction and must
# not be flagged, or the queue fills with the rows that are most obviously correct.
check("does not flag a constraint under IMPORTANT",
      heuristic_flags(row("the essay must be under 500 words", "IMPORTANT")) == [])

# --- near_duplicate_pairs -------------------------------------------------------
pairs = near_duplicate_pairs([
    "explain recursion to me simply",
    "explain recursion for me simply",
    "write a sql query that joins two tables",
])
check("catches a one-word paraphrase", 1 in pairs)
check("keeps an unrelated row", 2 not in pairs)
check("keeps the first of a duplicate pair", 0 not in pairs)

# --- validate -------------------------------------------------------------------
accepted, review, reasons = validate([
    row("write a python function that parses iso dates", "IMPORTANT"),
    row("write a python function that parses iso dates", "IMPORTANT"),   # exact dup
    row("ok", "FILLER"),                                                 # too short
    row("this row has a label nobody defined", "URGENT"),                # bad schema
    row("x" * 400, "FILLER"),                                            # too long
    row("thanks so much for all of your help today", "FILLER"),
])
check("accepts the two good rows", len(accepted) == 2)
check("catches the exact duplicate", reasons["exact-duplicate"] == 1)
check("catches the short row", reasons["too-short"] == 1)
check("catches the unknown label", reasons["bad-schema"] == 1)
check("catches the overlong row", reasons["too-long"] == 1)
check("nothing spurious in review", review == [])

# Rows already in the shipped dataset must never be re-added as "new" data.
duped, _, dupe_reasons = validate([row("Explain how binary search works with an example",
                                       "IMPORTANT")])
check("rejects a row already in phrases.csv",
      dupe_reasons.get("duplicate-of-original-dataset") == 1 and duped == [])

# --- build_prompt ---------------------------------------------------------------
repetitive = build_prompt("REPETITIVE", 5, "coding", "casual", "easy", [])
filler = build_prompt("FILLER", 5, "coding", "casual", "easy", ["thanks in advance"])
# The guidelines block names the context field for every label, so the distinguishing
# string is the instruction to populate it, not the mention of it.
check("asks for context only on REPETITIVE",
      "give each example a `context` field" in repetitive
      and "give each example a `context` field" not in filler)
check("passes the avoid list through", "thanks in advance" in filler)
check("names the requested label", "labeled FILLER" in filler)

# --- verify ---------------------------------------------------------------------
# The rule that matters: a row the blind pass never reached must survive. Losing
# unchecked rows would silently shrink the corpus every time the API rate-limited.
corpus = [row("alpha one two three", "FILLER"),
          row("beta four five six", "IMPORTANT"),
          row("gamma seven eight nine", "REDUNDANT"),
          row("delta ten eleven twelve", "FILLER")]

kept, disagreed, rate = verify(corpus, lambda prompt, model: "FILLER", "stub")
check("blind pass keeps what it agrees with", len(kept) == 2)
check("blind pass rejects what it disagrees with", len(disagreed) == 2)
check("agreement rate is the checked fraction", rate == 0.5)

random.seed(0)
kept, disagreed, _ = verify(corpus, lambda prompt, model: "FILLER", "stub", sample=2)
check("sampling loses nothing", len(kept) + len(disagreed) == len(corpus))


def explode(prompt, model):
    raise RuntimeError("rate limited")


kept, disagreed, rate = verify(corpus, explode, "stub")
check("an API failure keeps every row", len(kept) == len(corpus))
check("an API failure flags nothing", disagreed == [])
check("an API failure reports no agreement", rate == 0.0)

print("{0} passed, {1} failed".format(passed, failed))
sys.exit(1 if failed else 0)
