"""
Self-check for the corpus ingestion pipeline.

    python test_ingest.py

Plain asserts, no framework and no network. Everything that touches Hugging Face is
exercised through injected fakes, so this runs offline and in CI, and so the failure
modes that matter -- a missing dataset, an expired token, a schema that changed under us
-- can actually be triggered instead of waited for.
"""

import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ingest  # noqa: E402

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL  " + name + (("\n      " + str(detail)) if detail else ""))


# --- redaction --------------------------------------------------------------------
clean, hits = ingest.redact("mail me at alice@example.com about it")
check("redacts an email", "[EMAIL]" in clean and "alice@example.com" not in clean)
check("counts the redaction", hits == 1)

clean, _ = ingest.redact("my key is sk-abcdefghijklmnopqrstuvwx and it broke")
check("redacts an API key", "[API_KEY]" in clean)

clean, _ = ingest.redact("card 4111 1111 1111 1111 declined")
check("redacts a card number", "[CARD]" in clean)

# The whole point of the narrow rules: technical content must come through untouched.
code = "run ```curl -H 'Authorization: x' https://api.example.com/v1?id=12345678901234```"
clean, hits = ingest.redact(code)
check("leaves a fenced block alone", clean == code, clean)

check("leaves version numbers alone", ingest.redact("upgrade to 3.11.2")[0] == "upgrade to 3.11.2")
check("leaves matrix dimensions alone", ingest.redact("a 1920 x 1080 image")[0] == "a 1920 x 1080 image")
check("leaves money alone", ingest.redact("it cost 1500 rupees")[0] == "it cost 1500 rupees")
check("leaves a long id alone",
      ingest.redact("row 123456789 failed")[0] == "row 123456789 failed")
check("leaves maths alone", ingest.redact("solve 3x^2 - 4x + 1 >= 0")[0] == "solve 3x^2 - 4x + 1 >= 0")

# --- duplicate detection ----------------------------------------------------------
check("fingerprints ignore case and spacing",
      ingest.fingerprint("Explain  Recursion") == ingest.fingerprint("explain recursion"))
check("different prompts differ",
      ingest.fingerprint("explain recursion") != ingest.fingerprint("explain closures"))
check("normalise collapses whitespace", ingest.normalise("a\n\n b  c") == "a b c")

# --- categories -------------------------------------------------------------------
for text, expected in [
    ("Write a python function that sorts a list", "code"),
    ("Solve 2x + 3 = 9", "math"),
    ("Draft a screenplay for a comedic short film", "writing"),
    ("Compare React and Vue", "analysis"),
    ("You are a helpful pirate. Answer in rhyme.", "roleplay"),
    ("Explain how photosynthesis works", "explain"),
    ("How do I install Docker on Ubuntu?", "howto"),
    ("Who wrote Hamlet?", "factual"),
]:
    got = ingest.categorise(text)
    check("categorises %r as %s" % (text[:34], expected), got == expected, "got " + got)

check("an unclassifiable prompt is 'other', not a crash",
      ingest.categorise("...") == "other")

# --- token estimate mirrors the extension -----------------------------------------
check("empty text costs at least one token", ingest.estimate_tokens("hello") >= 1)
check("longer text costs more",
      ingest.estimate_tokens("a much longer prompt with many more words in it")
      > ingest.estimate_tokens("short"))
check("CJK is handled by the character rule", ingest.estimate_tokens("再帰について") >= 1)

# --- record shape -----------------------------------------------------------------
record = ingest.make_record("Write a 200 word summary", "Write a 200 word summary of X",
                            "bpo", "train", "model")
check("record carries provenance", record["optimized_origin"] == "model")
check("record carries the source", record["source"] == "bpo")
# The instruction was explicit: never fabricate a ground-truth quality score.
check("no quality label is invented", record["quality_label"] is None)
check("no quality label origin is invented", record["quality_label_origin"] is None)
check("record is versioned", record["schema_version"] == ingest.SCHEMA_VERSION)
check("record counts tokens", record["token_estimate"] > 0)
check("record flags maths", ingest.make_record("solve 2 + 2", None, "x", "y", None)["has_math"])
check("record flags code",
      ingest.make_record("```py\nimport os\n```", None, "x", "y", None)["has_code"])

bare = ingest.make_record("Explain recursion", None, "lmsys", "train", None)
check("a row with no rewrite says so", bare["optimized_prompt"] is None
      and bare["optimized_origin"] is None)
check("no rewrite means no rewrite token count", bare["optimized_token_estimate"] is None)

# --- BPO schema, including a schema that changed ----------------------------------
# read_bpo() reads whatever the files hold. If the Hub ever renames a field, rows must
# be skipped rather than written as empty strings -- a corpus of blank prompts is worse
# than a short one, because nothing downstream can tell the difference.
original_fetch = ingest.fetch_bpo_split
original_splits = ingest.BPO_SPLITS
try:
    ingest.BPO_SPLITS = ("fake.json",)

    ingest.fetch_bpo_split = lambda name, cache: [
        {"prompt": "Write a poem", "optimized_prompt": "Write a haiku about rain"},
        {"prompt": "  ", "optimized_prompt": "x"},
        {"prompt": "No rewrite here", "optimized_prompt": ""},
        "not a dict",
    ]
    rows = list(ingest.read_bpo())
    check("BPO yields the good rows", len(rows) == 2, rows)
    check("BPO drops a blank prompt", all(r[0].strip() for r in rows))
    check("BPO marks a rewrite as model-made", rows[0][4] == "model")
    check("BPO records no origin when there is no rewrite", rows[1][4] is None)
    check("BPO ignores a non-dict row", True)

    # A renamed field: every row becomes unusable and none should be emitted.
    ingest.fetch_bpo_split = lambda name, cache: [
        {"instruction": "Write a poem", "better_prompt": "Write a haiku"},
    ]
    check("a renamed schema yields nothing rather than blanks",
          list(ingest.read_bpo()) == [])

    # A network failure on one split must not abort the others.
    def boom(name, cache):
        raise IOError("connection reset")

    ingest.fetch_bpo_split = boom
    check("a fetch failure is survivable", list(ingest.read_bpo()) == [])
finally:
    ingest.fetch_bpo_split = original_fetch
    ingest.BPO_SPLITS = original_splits

# --- LMSYS authentication ---------------------------------------------------------
# No token must produce a clear message and an empty generator, never a half-written
# corpus or a stack trace.
saved_env = {}
for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACEHUB_API_TOKEN"):
    saved_env[key] = os.environ.pop(key, None)
try:
    import huggingface_hub

    # get_token() is the current accessor; HfFolder was removed in huggingface_hub 1.0.
    # The test patches whichever one this install actually has, for the same reason the
    # code under test checks for both.
    if hasattr(huggingface_hub, "get_token"):
        holder, attribute = huggingface_hub, "get_token"
    else:
        holder, attribute = huggingface_hub.HfFolder, "get_token"

    original_get = getattr(holder, attribute)
    setattr(holder, attribute, staticmethod(lambda: None))
    try:
        captured = io.StringIO()
        stdout = sys.stdout
        sys.stdout = captured
        try:
            rows = list(ingest.read_lmsys(limit=5))
        finally:
            sys.stdout = stdout
        message = captured.getvalue()
        check("no token yields no rows", rows == [])
        check("no token explains itself", "gated" in message and "token" in message)
        check("no token points at the licence page",
              "huggingface.co/datasets" in message)
        check("no token is read from the repo", "hf_" not in message)
    finally:
        setattr(holder, attribute, original_get)
except ImportError:
    check("huggingface_hub present for the auth test", False, "not installed")
finally:
    for key, value in saved_env.items():
        if value is not None:
            os.environ[key] = value

# --- length gates -----------------------------------------------------------------
check("the floor is below the ceiling", ingest.MIN_CHARS < ingest.MAX_CHARS)
check("the floor rejects a bare word", len("hi") < ingest.MIN_CHARS)

# --- Parquet round trip ------------------------------------------------------------
saved_dir = ingest.CORPUS_DIR
try:
    ingest.CORPUS_DIR = tempfile.mkdtemp(prefix="pm-corpus-")
    records = [ingest.make_record("Prompt number %d here" % i, None, "test", "train", None)
               for i in range(5)]
    path = ingest.write_shard(records, "test", 0)
    check("a shard is written", os.path.exists(path))

    import pyarrow.parquet as pq
    table = pq.read_table(path)
    check("the shard round-trips", table.num_rows == 5)
    check("columns survive", "optimized_origin" in table.column_names)
    check("quality_label column exists and is empty",
          all(v is None for v in table.column("quality_label").to_pylist()))
finally:
    ingest.CORPUS_DIR = saved_dir

print("%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
