"""
Reference corpus ingestion for PromptMeter.

    python ingest.py --source bpo --limit 300        # small sample, no auth needed
    python ingest.py --source bpo                    # all three BPO splits
    python ingest.py --source lmsys --limit 2000     # needs HF auth, see below
    python ingest.py --stats                         # describe what is on disk

Writes Parquet shards to ml/corpus/ plus a checkpoint, so an interrupted run resumes
instead of re-downloading. Nothing here touches dataset/phrases.csv, metrics.json or the
shipped model.

WHAT THE TWO SOURCES ARE FOR, AND WHAT THEY ARE NOT FOR
-------------------------------------------------------
zai-org/BPO ships (prompt, optimized_prompt) pairs. It is tempting to read that as
training data for PromptMeter's optimizer. It is not, and the measurement says so: on the
validation split, 70% of BPO's optimized prompts are LONGER than the original, median
1.29x and mean 2.08x. BPO optimizes for the quality of the model's RESPONSE, largely by
adding specificity and constraints. PromptMeter optimizes for tokens spent, and its one
rule is that the user's meaning survives. Fitting one objective to the other would teach
the optimizer to pad prompts, which is the behaviour the project exists to remove.

So BPO is used here for what it can honestly support:

  * real, diverse, human-written prompts (the `prompt` side)
  * an independent opinion that a given prompt was worth rewriting, which the quality
    scorer can be measured against -- see evaluate_corpus.py
  * a preservation test: run the optimizer over BPO originals and check that constraints,
    numbers, operators and code survive

lmsys/lmsys-chat-1m supplies the first human turn of a million real conversations. It is
used for DIVERSITY and GENERALISATION only: how the scorer behaves on prompts nobody
wrote for a benchmark. It carries no optimization target of any kind.

NO QUALITY LABELS ARE INVENTED. Neither dataset ships a verified prompt-quality score,
so none is written. The heuristic_* columns are clearly named, are the extension's own
rule output, and are evidence about the scorer rather than ground truth for it.

AUTHENTICATION
--------------
LMSYS is gated ("gated: auto" on the Hub): it needs a Hugging Face account, acceptance of
its terms on the dataset page, and a token. No token is ever read from or written to this
repository. Provide one the standard way:

    huggingface-cli login
    # or
    export HF_TOKEN=hf_...

If no token is present this module says so and exits cleanly rather than failing
half-way through a download.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_DIR = os.path.join(HERE, "corpus")
CHECKPOINT = os.path.join(CORPUS_DIR, "ingest_state.json")

BPO_BASE = "https://huggingface.co/datasets/zai-org/BPO/resolve/main/"
BPO_SPLITS = ("train.json", "val.json", "test.json")
LMSYS_ID = "lmsys/lmsys-chat-1m"

# Prompts outside this band are not useful reference material: below the floor there is
# nothing to score, above the ceiling the row is usually a pasted document rather than a
# prompt, and it would dominate every length statistic in the corpus.
MIN_CHARS = 8
MAX_CHARS = 8000

SCHEMA_VERSION = 3


# ---------------------------------------------------------------------------
# Cleaning
# ---------------------------------------------------------------------------

# Spans that must survive cleaning untouched. Redacting inside a fenced block would
# corrupt exactly the technical syntax this corpus exists to test the optimizer against.
FENCE_RX = re.compile(r"```.*?```|`[^`\n]+`", re.S)

# Personal data worth removing. Deliberately narrow: an over-eager rule here would eat
# version numbers, matrix dimensions, hex colours and monetary amounts, and a corpus that
# has lost its numbers cannot test whether the optimizer preserves them.
PII_PATTERNS = [
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"), "[EMAIL]"),
    (re.compile(r"\b(?:sk-|ghp_|gho_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}"), "[API_KEY]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}"), "Bearer [TOKEN]"),
    # 13-19 digits in groups: card-shaped. A bare long integer is left alone because it
    # is far more often an id, a timestamp or a maths problem.
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN]"),
]


def redact(text):
    """
    Removes personal data from prose while leaving code and inline spans alone.

    @returns (cleaned text, number of redactions)
    """
    spans = []

    def stash(match):
        spans.append(match.group(0))
        return "\x00%d\x00" % (len(spans) - 1)

    masked = FENCE_RX.sub(stash, text)

    hits = 0
    for pattern, replacement in PII_PATTERNS:
        masked, n = pattern.subn(replacement, masked)
        hits += n

    restored = re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], masked)
    return restored, hits


def normalise(text):
    """Key used for exact-duplicate detection. Never written to the corpus."""
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"\s+", " ", text).strip()


def fingerprint(text):
    """Stable id for a prompt, so re-runs and shards agree on what is a duplicate."""
    return hashlib.sha1(normalise(text).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Derived fields
#
# These are DESCRIPTIVE, not judgements. Nothing below decides whether a prompt is good.
# ---------------------------------------------------------------------------

CATEGORY_RULES = [
    # Order is the priority order: a prompt asking to debug Python is code, not a
    # how-to, even though it also says "how do I".
    ("code", re.compile(r"```|\bdef \w|\bclass \w|\bimport \w|\bfunction\b|\bSELECT\b|"
                        r"\bjavascript\b|\bpython\b|\bcompile\b|\bdebug\b|\bAPI\b|"
                        r"\bregex\b|\bSQL\b|\bHTML\b|\bCSS\b|\bcode\b", re.I)),
    ("math", re.compile(r"\b(?:solve|equation|integral|derivative|theorem|probability|"
                        r"matrix|calculate|factorial|logarithm)\b|[=+\-*/^]\s*\d|"
                        r"\b\d+\s*[+\-*/^]\s*\d", re.I)),
    ("writing", re.compile(r"\b(?:write|draft|compose|essay|story|poem|screenplay|blog|"
                           r"article|rewrite|paraphrase|summari[sz]|translate|joke|"
                           r"letter|email)\b", re.I)),
    ("analysis", re.compile(r"\b(?:analyse|analyze|compare|evaluate|critique|review|"
                            r"pros and cons|rate|rank)\b", re.I)),
    ("roleplay", re.compile(r"\b(?:you are|act as|pretend|roleplay|imagine you)\b", re.I)),
    ("explain", re.compile(r"\b(?:explain|describe|teach me|tell me about|what is|"
                           r"what are|what was|what were|how does|why does|why do|"
                           r"why are|why is)\b", re.I)),
    # "how do I" is a different request from "how does it work": one wants steps, the
    # other wants a model. Keeping them apart is the point of having categories at all.
    ("howto", re.compile(r"\bhow (?:do|can|would|should) (?:i|we|you)\b|\bhow to\b|"
                         r"\b(?:steps|ways|methods) to\b|\bhow come\b|\bhow (?:much|many)\b",
                         re.I)),
    # Anything still unclassified but phrased as a question.
    ("factual", re.compile(r"^\s*(?:who|what|when|where|which|why|is|are|does|did|can|"
                           r"could|should|would|name|list|give)\b|\?\s*$", re.I | re.M)),
]


def categorise(text):
    """First matching rule wins. 'other' is a real answer, not a failure."""
    for name, pattern in CATEGORY_RULES:
        if pattern.search(text):
            return name
    return "other"


def estimate_tokens(text):
    """
    Mirrors PromptMeterTokenizer.estimate() in utils/tokenizer.js.

    Deliberately the same arithmetic as the extension rather than a better tokenizer:
    the corpus is here to describe what PromptMeter sees. A count from a real BPE
    encoder would be more accurate and would describe a different program.
    """
    clean = text.strip()
    chars = len(clean)
    words = len(clean.split())
    char_estimate = round(chars / 4)
    if words == 0 or chars / words > 20:
        return max(1, char_estimate)
    return max(1, round((round(words * 1.33) + char_estimate) / 2))


def make_record(prompt, optimized, source, split, optimized_origin, meta=None):
    """
    One corpus row.

    `optimized_origin` records WHO produced the rewrite -- "model" for BPO's pairs,
    None when there is no rewrite. Provenance is a column rather than an assumption,
    because a human edit and a model edit are not the same evidence and a later
    evaluation has to be able to separate them.
    """
    meta = meta or {}
    return {
        "id": fingerprint(prompt),
        "prompt": prompt,
        "optimized_prompt": optimized,
        "optimized_origin": optimized_origin,
        "source": source,
        "split": split,
        # LMSYS ships a `language` column. Taking it rather than guessing from the text
        # matters because the quality rules are English-only, and a fair reading of how
        # the scorer behaves on other languages needs to know which rows those are.
        # BPO has no such column, so this is None there rather than a guess.
        "language": meta.get("language"),
        # True when the SOURCE dataset says it already removed personal data. Not a
        # claim that this pipeline found none -- the two are different facts and
        # collapsing them would overstate what is known.
        "source_redacted": meta.get("redacted"),
        "task_category": categorise(prompt),
        "char_length": len(prompt),
        "word_count": len(prompt.split()),
        "token_estimate": estimate_tokens(prompt),
        "optimized_token_estimate": estimate_tokens(optimized) if optimized else None,
        "has_code": bool(re.search(r"```|\bdef \w|\bimport \w|[{};]\s*$", prompt, re.M)),
        "has_math": bool(re.search(r"[=<>+*/^]\s*\d|\b\d+\s*[+\-*/^]", prompt)),
        "has_url": bool(re.search(r"https?://", prompt)),
        "is_multiline": "\n" in prompt,
        # No quality score. Neither dataset ships a verified one, so none is written.
        "quality_label": None,
        "quality_label_origin": None,
        "ingested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "schema_version": SCHEMA_VERSION,
    }


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def fetch_bpo_split(filename, cache_dir):
    """Downloads one BPO split once and caches the raw JSON beside the corpus."""
    os.makedirs(cache_dir, exist_ok=True)
    local = os.path.join(cache_dir, filename)
    if os.path.exists(local):
        print("  cached  " + filename)
    else:
        print("  fetching " + filename + " ...")
        urllib.request.urlretrieve(BPO_BASE + filename, local)
    with open(local, encoding="utf-8") as handle:
        return json.load(handle)


def read_bpo(limit=None):
    """
    Yields records from BPO.

    Schema, verified against the live files rather than assumed:
        prompt, optimized_prompt, good_res, bad_res

    good_res/bad_res are model RESPONSES. They are deliberately dropped: this corpus is
    about prompts, and carrying two long completions per row would multiply its size for
    something nothing here reads.
    """
    cache = os.path.join(CORPUS_DIR, "raw", "bpo")
    produced = 0

    for filename in BPO_SPLITS:
        try:
            rows = fetch_bpo_split(filename, cache)
        except Exception as err:                        # noqa: BLE001 - network or HTTP
            print("  ! could not fetch %s: %s" % (filename, err))
            continue

        split = filename.replace(".json", "")
        for row in rows:
            if limit is not None and produced >= limit:
                return
            if not isinstance(row, dict):
                continue

            prompt = (row.get("prompt") or "").strip()
            optimized = (row.get("optimized_prompt") or "").strip()
            if not prompt:
                continue

            # Six-tuple like read_lmsys, with an empty metadata dict: BPO carries no
            # language or redaction column, and absent is not the same as unknown.
            yield (prompt, optimized or None, "bpo", split,
                   ("model" if optimized else None), {})
            produced += 1


def read_lmsys(limit=None):
    """
    Yields the first human turn of each LMSYS conversation.

    Streaming, not a full download: lmsys-chat-1m is several GB and this only ever needs
    the opening prompt. streaming=True pulls shards lazily, so --limit 2000 costs one
    shard rather than the dataset.

    Only the FIRST user turn is taken. Later turns are replies to the model and are not
    standalone prompts -- "yes, do that one" tells the scorer nothing about prompt
    quality and would pollute every length and category statistic.
    """
    try:
        from datasets import load_dataset
    except ImportError:
        print("  ! the `datasets` package is not installed: pip install datasets")
        return

    token = (os.environ.get("HF_TOKEN")
             or os.environ.get("HUGGING_FACE_HUB_TOKEN")
             or os.environ.get("HUGGINGFACEHUB_API_TOKEN"))
    if not token:
        # huggingface_hub.get_token() is the current accessor and reads whatever
        # `huggingface-cli login` stored. HfFolder.get_token() was the old one and was
        # removed in huggingface_hub 1.0, so it is only tried as a fallback for people
        # still on 0.x -- calling it directly raises AttributeError on a current install.
        try:
            import huggingface_hub
            if hasattr(huggingface_hub, "get_token"):
                token = huggingface_hub.get_token()
            elif hasattr(huggingface_hub, "HfFolder"):
                token = huggingface_hub.HfFolder.get_token()
        except Exception:                               # noqa: BLE001
            token = None

    if not token:
        print("  ! %s is gated and no Hugging Face token was found." % LMSYS_ID)
        print("    Accept the terms at https://huggingface.co/datasets/%s" % LMSYS_ID)
        print("    then run `huggingface-cli login` or set HF_TOKEN.")
        print("    No token is read from or stored in this repository.")
        return

    try:
        stream = load_dataset(LMSYS_ID, split="train", streaming=True)
    except Exception as err:                            # noqa: BLE001 - auth or network
        print("  ! could not open %s: %s" % (LMSYS_ID, err))
        print("    A 401/403 here means the license has not been accepted on the Hub.")
        return

    produced = 0
    for row in stream:
        if limit is not None and produced >= limit:
            return

        conversation = row.get("conversation") or []
        # The first USER turn, by index, so the matching moderation entry can be found.
        index = next((i for i, turn in enumerate(conversation)
                      if (turn.get("role") or "").lower() == "user"), None)
        if index is None:
            continue

        prompt = (conversation[index].get("content") or "").strip()
        if not prompt:
            continue

        # LMSYS ships per-turn OpenAI moderation results. Using the dataset's own
        # labels to drop flagged turns is better than any keyword rule this file could
        # write, and it keeps material nobody wants in a reference corpus out of it.
        # A missing or differently-shaped entry means "not flagged": the corpus should
        # degrade to keeping a row, not crash on a schema that moved.
        moderation = row.get("openai_moderation") or []
        if index < len(moderation):
            entry = moderation[index] or {}
            categories = entry.get("categories") if isinstance(entry, dict) else None
            if isinstance(categories, dict) and any(bool(v) for v in categories.values()):
                continue

        yield prompt, None, "lmsys", "train", None, {
            "language": row.get("language"),
            "redacted": row.get("redacted"),
        }
        produced += 1


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_state():
    if not os.path.exists(CHECKPOINT):
        return {"seen": [], "shards": [], "counts": {}}
    with open(CHECKPOINT, encoding="utf-8") as handle:
        return json.load(handle)


def save_state(state):
    os.makedirs(CORPUS_DIR, exist_ok=True)
    with open(CHECKPOINT, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)


def write_shard(records, source, index):
    """One Parquet shard per batch, so a long run is resumable and nothing is rewritten."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    os.makedirs(CORPUS_DIR, exist_ok=True)
    path = os.path.join(CORPUS_DIR, "%s-%04d.parquet" % (source, index))
    pq.write_table(pa.Table.from_pylist(records), path, compression="snappy")
    return path


def ingest(source, limit, batch_size, resume):
    reader = {"bpo": read_bpo, "lmsys": read_lmsys}[source]

    state = load_state() if resume else {"seen": [], "shards": [], "counts": {}}
    seen = set(state["seen"])
    rejected = {"duplicate": 0, "too_short": 0, "too_long": 0, "empty": 0}
    redactions = 0

    batch, written, shard_index = [], 0, len(
        [s for s in state["shards"] if s.startswith(source)])

    print("Reading %s ..." % source)
    for prompt, optimized, src, split, origin, meta in reader(limit):
        if not prompt.strip():
            rejected["empty"] += 1
            continue
        if len(prompt) < MIN_CHARS:
            rejected["too_short"] += 1
            continue
        if len(prompt) > MAX_CHARS:
            rejected["too_long"] += 1
            continue

        key = fingerprint(prompt)
        if key in seen:
            rejected["duplicate"] += 1
            continue
        seen.add(key)

        prompt, hits = redact(prompt)
        redactions += hits
        if optimized:
            optimized, more = redact(optimized)
            redactions += more

        batch.append(make_record(prompt, optimized, src, split, origin, meta))

        if len(batch) >= batch_size:
            path = write_shard(batch, source, shard_index)
            state["shards"].append(os.path.basename(path))
            state["seen"] = sorted(seen)
            save_state(state)
            written += len(batch)
            print("  shard %s  (%d rows, %d total)" % (
                os.path.basename(path), len(batch), written))
            batch, shard_index = [], shard_index + 1

    if batch:
        path = write_shard(batch, source, shard_index)
        state["shards"].append(os.path.basename(path))
        written += len(batch)
        print("  shard %s  (%d rows, %d total)" % (
            os.path.basename(path), len(batch), written))

    state["seen"] = sorted(seen)
    state["counts"][source] = state["counts"].get(source, 0) + written
    save_state(state)

    print()
    print("%s: %d rows written, %d redactions" % (source, written, redactions))
    for reason, count in rejected.items():
        if count:
            print("  rejected %-12s %d" % (reason, count))
    return written


def export_jsonl(path, limit=None, seed=13):
    """
    Writes a random sample of the corpus as JSON Lines.

    The scorer and optimizer are JavaScript and live in utils/. Node cannot read Parquet
    without pulling in a dependency, and the corpus does not need to be in memory twice,
    so the evaluation reads a flat sample instead. Sampled rather than truncated: the
    shards are in dataset order, and scoring the first N rows would measure one slice of
    one split.
    """
    import random
    import pyarrow.parquet as pq

    shards = sorted(f for f in os.listdir(CORPUS_DIR) if f.endswith(".parquet"))
    rows = []
    for name in shards:
        table = pq.read_table(os.path.join(CORPUS_DIR, name), columns=[
            "id", "prompt", "optimized_prompt", "optimized_origin", "source",
            "task_category", "token_estimate", "has_code", "has_math"])
        rows.extend(table.to_pylist())

    random.Random(seed).shuffle(rows)
    if limit:
        rows = rows[:limit]

    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + chr(10))
    print("Wrote %s (%d rows)" % (path, len(rows)))
    return len(rows)


def stats():
    """Describes the corpus on disk without loading it all into memory."""
    import pyarrow.parquet as pq

    if not os.path.isdir(CORPUS_DIR):
        print("No corpus yet. Run: python ingest.py --source bpo --limit 300")
        return 1

    shards = sorted(f for f in os.listdir(CORPUS_DIR) if f.endswith(".parquet"))
    if not shards:
        print("No shards in %s" % CORPUS_DIR)
        return 1

    total = 0
    by_source, by_category, with_optimized = {}, {}, 0
    for name in shards:
        table = pq.read_table(os.path.join(CORPUS_DIR, name),
                              columns=["source", "task_category", "optimized_prompt"])
        total += table.num_rows
        for value in table.column("source").to_pylist():
            by_source[value] = by_source.get(value, 0) + 1
        for value in table.column("task_category").to_pylist():
            by_category[value] = by_category.get(value, 0) + 1
        with_optimized += sum(1 for v in table.column("optimized_prompt").to_pylist() if v)

    print("Corpus: %d rows across %d shards" % (total, len(shards)))
    print("  with an optimized_prompt: %d" % with_optimized)
    print("  by source:")
    for key, value in sorted(by_source.items()):
        print("    %-10s %d" % (key, value))
    print("  by task category:")
    for key, value in sorted(by_category.items(), key=lambda kv: -kv[1]):
        print("    %-10s %d" % (key, value))
    return 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", choices=("bpo", "lmsys", "all"))
    parser.add_argument("--limit", type=int, default=None,
                        help="stop after this many rows (use it for the small-sample run)")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--no-resume", action="store_true",
                        help="ignore the checkpoint and start clean")
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--export-jsonl", metavar="PATH",
                        help="write a random sample of the corpus for the JS evaluator")
    parser.add_argument("--export-limit", type=int, default=4000)
    args = parser.parse_args()

    if args.export_jsonl:
        export_jsonl(args.export_jsonl, args.export_limit)
        return 0
    if args.stats:
        return stats()
    if not args.source:
        parser.print_help()
        return 1

    os.makedirs(CORPUS_DIR, exist_ok=True)
    sources = ("bpo", "lmsys") if args.source == "all" else (args.source,)
    for source in sources:
        ingest(source, args.limit, args.batch_size, not args.no_resume)
        print()
    return stats()


if __name__ == "__main__":
    sys.exit(main())
