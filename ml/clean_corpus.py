"""
Applies ml/ingest.py's cleaning pass to a corpus that was ingested before it existed.

    python ml/clean_corpus.py --dry-run     # report only, writes nothing
    python ml/clean_corpus.py               # rewrite the shards and re-export the sample

WHY THIS EXISTS RATHER THAN A RE-INGEST. Re-ingesting from Hugging Face would produce
the same result and is the better path when the sources are reachable, but it needs a
gated-dataset token, and re-downloading 31,499 rows to remove 40 invisible characters is
not a trade worth making. This runs the SAME functions -- ingest.sanitise and
ingest.dedupe_key -- over the shards already on disk, so the two paths cannot disagree
about what clean means.

WHAT IT DOES NOT DO, and this is most of the point. It is not a content filter. It does
not drop a prompt for being short, rude, badly spelled, in another language, a jailbreak
attempt, arithmetic, or an attempt to smuggle text past a filter as an array of ASCII
codes. Every one of those is a real thing a real person typed, and several are exactly
the cases the optimizer most needs to be measured against -- 22% of this corpus is not
in a Latin script, and the whole reason it is here is to prove the rules do not mangle
it. An audit that flags 7% of a corpus is usually an audit with bad heuristics, and the
first version of this one flagged 754 Chinese, Russian, Arabic and Persian prompts as
"no letters at all", 15 maths prompts the same way, and 16 legitimate roleplay prompts
as "assistant refusals". None of those are removed. What is removed is characters nobody
can see, and prompts that are already in the corpus twice.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ingest  # noqa: E402  -- the path has to be set first

CORPUS_DIR = os.path.join(HERE, "corpus")
SAMPLE = os.path.join(CORPUS_DIR, "sample.jsonl")


def measured_fields(row):
    """
    Re-derives every field computed FROM the text.

    Sanitising without this leaves char_length, word_count and the token estimates
    describing a string that is no longer in the file -- a quieter kind of noise than
    the one being removed, and a worse one, because a stale number looks like a
    measurement.
    """
    prompt = row["prompt"]
    row["char_length"] = len(prompt)
    row["word_count"] = len(prompt.split())
    row["token_estimate"] = ingest.estimate_tokens(prompt)
    row["is_multiline"] = "\n" in prompt
    optimized = row.get("optimized_prompt")
    row["optimized_token_estimate"] = (
        ingest.estimate_tokens(optimized) if optimized else None)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change and write nothing")
    args = parser.parse_args()

    import pyarrow as pa
    import pyarrow.parquet as pq

    shards = sorted(f for f in os.listdir(CORPUS_DIR) if f.endswith(".parquet"))
    if not shards:
        print("No shards in %s" % CORPUS_DIR)
        return 1

    seen = set()
    stats = {
        "rows_in": 0,
        "rows_out": 0,
        "invisible_chars_removed": 0,
        "rows_sanitised": 0,
        "rows_dropped_duplicate": 0,
        "rows_dropped_empty": 0,
        "optimized_is_copy": 0,
    }
    per_shard = []

    for name in shards:
        path = os.path.join(CORPUS_DIR, name)
        table = pq.read_table(path)
        rows = table.to_pylist()
        stats["rows_in"] += len(rows)

        kept = []
        for row in rows:
            prompt, removed = ingest.sanitise(row["prompt"])
            if removed:
                stats["invisible_chars_removed"] += removed
                stats["rows_sanitised"] += 1
            if not prompt.strip():
                stats["rows_dropped_empty"] += 1
                continue

            optimized = row.get("optimized_prompt")
            if optimized:
                optimized, more = ingest.sanitise(optimized)
                if more:
                    stats["invisible_chars_removed"] += more
                row["optimized_prompt"] = optimized

            key = ingest.dedupe_key(prompt)
            if key in seen:
                stats["rows_dropped_duplicate"] += 1
                continue
            seen.add(key)

            row["prompt"] = prompt
            # A rewrite identical to the prompt is not noise and is not removed -- BPO
            # genuinely contains pairs it decided needed no change. But it can only ever
            # land in "same score", so a direction metric that does not know which rows
            # those are reports a denominator it has not earned. 1,315 of 14,351 BPO
            # pairs, which is 9% of that split.
            if not optimized:
                # No rewrite at all, which is not the same fact as "the rewrite is a
                # copy". None says the question does not apply to this row.
                row["optimized_is_copy"] = None
            elif ingest.dedupe_key(optimized) == key:
                row["optimized_is_copy"] = True
                stats["optimized_is_copy"] += 1
            else:
                row["optimized_is_copy"] = False
            kept.append(measured_fields(row))

        per_shard.append((name, len(rows), len(kept)))
        stats["rows_out"] += len(kept)

        if not args.dry_run:
            if kept:
                pq.write_table(pa.Table.from_pylist(kept), path)
            else:
                # A shard emptied entirely by deduplication would otherwise be left
                # holding its old contents.
                os.remove(path)

    print("%-28s %8s %8s" % ("shard", "in", "out"))
    for name, before, after in per_shard:
        mark = "" if before == after else "  <-"
        print("%-28s %8d %8d%s" % (name, before, after, mark))
    print()
    for key in ("rows_in", "rows_out", "rows_sanitised", "invisible_chars_removed",
                "rows_dropped_duplicate", "rows_dropped_empty", "optimized_is_copy"):
        print("%-26s %8d" % (key, stats[key]))
    print()

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0

    ingest.export_jsonl(SAMPLE)
    with open(os.path.join(CORPUS_DIR, "clean_report.json"), "w",
              encoding="utf-8") as handle:
        json.dump(stats, handle, indent=2)
    print("Wrote %s" % os.path.join(CORPUS_DIR, "clean_report.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
