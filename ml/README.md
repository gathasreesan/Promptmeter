# PromptMeter — Machine Learning Component

A phrase classifier that helps the existing rule-based optimizer decide what can be
removed from a prompt without losing the request.

It **does not replace** the rules. It is consulted as a second opinion in two specific
places, and it can be switched off entirely without changing any other behaviour.

---

## The problem it solves

The rule engine is a blacklist: it removes phrases it recognises. That works for
`thanks in advance` and fails for a sentence nobody wrote a rule for.

The sentence pruner in `utils/condense.js` covers some of that gap with a vocabulary
heuristic — *a sentence introducing no new content words is backstory* — but the
heuristic has a blind spot, and it is exactly the kind of sentence students write:

> My hostel roommate kept playing loud music throughout the entire evening yesterday.

Seven content words the prompt has never seen, so the rule keeps it. It says nothing
the model can act on. A classifier trained on labeled phrases catches this; a blacklist
never will.

---

## Why TF-IDF + Logistic Regression

The model runs inside a Chrome content script, on a debounce timer, while the user is
typing. That rules out anything needing a server round trip (the extension's whole
premise is that no data leaves the machine), and anything needing a multi-megabyte
runtime download.

A linear model over TF-IDF features exports to three arrays — vocabulary, IDF weights,
coefficient matrix. Inference is one sparse dot product. The shipped model is **113 KB**
and classifies a sentence in well under a millisecond.

The features are word unigrams and bigrams, with **different document-frequency floors**
for each. Unigrams are kept at `df >= 1` and bigrams must appear at least twice. A single
floor cannot serve both: raising it to 2 to cut the long tail of once-seen bigrams also
discards two thirds of the unigrams, and those are what give the model any purchase on a
sentence full of words the corpus has never seen — at `min_df=2` it reads *"my hostel
roommate kept playing loud music"* as IMPORTANT at 0.77 confidence, because almost
nothing in the sentence is in its vocabulary. Splitting the floor keeps 1,395 features
instead of 3,443, which is both a smaller download and a slightly better model.

---

## Labels

| Label | Meaning | Example |
| :--- | :--- | :--- |
| `IMPORTANT` | The instruction, its constraints, its subject matter | *The output must be valid JSON* |
| `FILLER` | Greetings, mood, backstory, sign-offs | *I have an exam tomorrow and I am really stressed* |
| `REDUNDANT` | Wordy wrappers and tautologies that say nothing alone | *I would like you to please go ahead and* |
| `REPETITIVE` | Restates something the prompt already said | *The report must include the data and the report must include the charts* |

---

## Results

Trained on **621 labeled phrases** — 512 hand-written originals plus 109 curated
additions — stratified 75/25. Hyperparameters are grid-searched on every run (60 points
over n-gram range, sublinear TF, bigram floor and `C`) and scored by cross-validated
**KEEP/DROP** accuracy, not four-way accuracy. That choice changes which model wins: the
optimizer never acts on the four labels, so a grid point that trades a FILLER/REDUNDANT
confusion for a correct KEEP/DROP call is better for this application and worse on the
four-way number.

Selected: `TfidfVectorizer(ngram=1-2, sublinear_tf=True, bigram_min_df=2)` +
`LogisticRegression(C=4.0, balanced)` · 1,281 features · 130 KB shipped

### Four-class classification (held-out test set, n=156)

| Class | F1 |
| :--- | ---: |
| FILLER | 0.83 |
| IMPORTANT | 0.83 |
| REDUNDANT | 0.82 |
| REPETITIVE | 0.77 |

**Accuracy 0.814** · 5-fold CV accuracy **0.802 (± 0.025)**

The CV figure is computed over the **whole pipeline**, vectorizer included. It previously
fit the vectorizer on every row before cross-validating the classifier over that matrix,
which leaked the test fold's vocabulary and IDF weights into training.

### KEEP vs DROP — the decision the optimizer actually consumes

`FILLER`, `REDUNDANT` and `REPETITIVE` all mean *yes, this may go*.

| Metric | Score |
| :--- | ---: |
| Accuracy | **0.910** |
| Precision (macro) | 0.880 |
| Recall (macro) | 0.892 |
| F1 (macro) | 0.886 |

Higher than the four-way figure because most four-way errors are between two *removable*
classes — calling filler "redundant" changes no decision.

### Where the thresholds come from

`ML_KEEP_VETO` and `ML_DROP_PROPOSE` in `condense.js` are set from measured precision and
**re-derived on every refit**. Taking 5-fold cross-validated probabilities and asking, at
each cut-off, how often the rule that fires is actually right:

| PROPOSE (`removable ≥ t`) | fires | precision | | VETO (`keep ≥ t`) | fires | precision |
| ---: | ---: | ---: | :-- | ---: | ---: | ---: |
| 0.85 | 314 | 0.978 | | 0.70 | 68 | 0.941 |
| 0.88 | 274 | 0.985 | | 0.75 | 52 | **0.962** |
| 0.90 | 229 | **0.991** | | 0.80 | 45 | 0.956 |
| 0.92 | 172 | 0.994 | | 0.85 | 35 | 0.943 |

Both moved when the corpus grew. **PROPOSE is 0.90** (was 0.92): it deletes the user's own
words, so it is still held to ~99% precision, but the better-fitted model reaches that at
0.90 and fires 57 more times for it. **VETO is 0.75** (was 0.80) — better on both axes at
once, higher precision *and* more firings.

### A negative result worth recording

`dataset/expand.py` grows the corpus to 1,680 rows by composing phrases from word banks.
It makes the headline numbers look excellent — four-way 0.95, KEEP/DROP 0.97 — and those
numbers are an illusion. Scored only on rows a human wrote:

| | 4-way | KEEP/DROP |
| :--- | ---: | ---: |
| trained on generated rows only, tested on all 512 hand-written rows | 0.584 | 0.721 |
| 5-fold CV, seed rows only, scored on held-out seed rows | 0.787 | **0.910** |
| 5-fold CV, seed + generated, scored on held-out seed rows | 0.797 | **0.904** |

Adding 1,168 generated rows moves four-way accuracy by +0.01 — inside the fold-to-fold
spread — and moves the KEEP/DROP decision slightly the *wrong* way. The apparent gain was
the test set grading the model on rows sharing a skeleton with its training data. So the
shipped dataset is the hand-written set alone. If you want more data, **write real
phrases**; generating them from templates teaches the model the templates.

### Honest limitations

- 512 examples is small. The gap between the 0.711 held-out score and the 0.799 CV mean
  is what that sample size looks like, and the held-out split is only 128 rows (±4%).
- `REPETITIVE` is partly ill-posed for a single-sentence classifier: repetition is a
  property of a sentence *relative to the rest of the prompt*. The model can only see
  repetition visible inside one sentence.
- The dataset is hand-authored and skews toward student and developer prompts, which is
  the population PromptMeter serves — but it is not a random sample of anything.
- `REDUNDANT` precision (0.59) is the weakest class. Most of its errors go to FILLER,
  which changes no decision, so the KEEP/DROP figure absorbs them.

---

## How it is wired in

```
Prompt
  → protect.js          mask code, URLs, paths, quotes            (unchanged)
  → spelling.js         open-ended typo correction (skeletons + edit shape)
  → grammar.js          agreement, tense, confusables, articles
  → optimizer.js        vocabulary, strippers, structural rewrites
  → condense.js         sentence pruning
        ├── rules decide first
        └── ML consulted as a second opinion:
              VETO     rules want to drop, model says IMPORTANT ≥ 0.80  → keep
              PROPOSE  rules want to keep, model says removable ≥ 0.92  → drop
  → tokenizer / calculator / storage / dashboard                  (unchanged)
```

Two guarantees hold by construction:

1. **A core sentence is never offered to the model.** If the rules see a request, a
   constraint, or protected content, the sentence stays — no confidence level can
   overrule that.
2. **The thresholds are asymmetric.** Vetoing a removal costs a few tokens if wrong;
   proposing one costs the user's meaning. So proposals need 0.92 and vetoes need 0.80,
   and the existing guards (an ask must survive, a topic must survive) still apply on
   top of every ML proposal.

Setting both thresholds above 1.0 disables the assist completely and restores pure
rule-based behaviour. The test suite does exactly that to prove the rules still stand
on their own.

---

## Files

| File | Role |
| :--- | :--- |
| `dataset/phrases.csv` | 621 labeled phrases, human-written — **the only training data that ships** |
| `dataset/expand.py` | Corpus generator — **an experiment that did not pay off**; see above |
| `train.py` | Trains, evaluates, exports |
| `metrics.json` | Full generated report |
| `ingest.py` | Reference corpus ingestion from LMSYS and BPO |
| `evaluate_corpus.js` | Measures the scorer and optimizer against the corpus |
| `test_ingest.py` | Self-check for ingestion, offline |
| `corpus_eval.json` | **Generated** — the corpus measurement |
| `corpus/` | **Generated, gitignored** — Parquet shards |
| `generate_synthetic.py` | Synthetic corpus pipeline — generate, validate, report |
| `evaluate_synthetic.py` | Compares original vs original+synthetic; never writes the model |
| `test_generate_synthetic.py` | Self-check for the validator |
| `dataset/manual_batches/*.jsonl` | Hand-authored batches, input to the pipeline |
| `dataset/synthetic_10000.csv` | **Generated** — the validated synthetic corpus |
| `dataset/review_queue.csv` | **Generated** — rows flagged as ambiguous, for a human |
| `dataset/quality_report.json` | **Generated** — counts, duplicates, validation results |
| `eval_synthetic.json` | **Generated** — the A/B comparison |
| `requirements.txt` | `scikit-learn>=1.3` |
| `../utils/ml-model.js` | **Generated** — the exported model |
| `../utils/ml-classifier.js` | Runtime inference in JavaScript |
| `../tests/ml-parity.json` | **Generated** — reference predictions for the parity test |

## Synthetic data

`generate_synthetic.py` produces new labeled phrases and validates them;
`evaluate_synthetic.py` decides whether they are worth training on. Neither script
touches `phrases.csv`, `metrics.json` or the exported model. **The shipped model is
still trained on the 621 human-written rows alone** — see *The verdict* below for why.

### Running it

```bash
python generate_synthetic.py --provider manual      # no API key needed
python test_generate_synthetic.py                   # self-check for the validator
python evaluate_synthetic.py --repeats 25           # does it help?
```

### Configuring a generation provider

There is no API key in this environment, so the corpus that exists was authored by hand
into `dataset/manual_batches/*.jsonl` and fed through the `manual` provider. To generate
at scale, set one variable and pick the matching provider:

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python generate_synthetic.py --provider anthropic --model claude-opus-5 \
    --target 10000 --batch-size 25 --verify
```

or, for any OpenAI-compatible endpoint:

```bash
export OPENAI_API_KEY=...
python generate_synthetic.py --provider openai --model gpt-4o --target 10000
```

`--target` is a goal, not a promise. The run generates until each label reaches its
share, appending every row to `dataset/.synthetic_raw.jsonl` as it arrives, so a run
killed by a rate limit resumes where it stopped rather than re-paying for what it has.
Expect to lose roughly 10–20% of raw rows to the duplicate checks at scale; the
shortfall is printed and recorded in `quality_report.json`.

`--verify` is the expensive option and the one that matters. The generator is *told* the
label before it writes the text, so its label is an instruction, not a judgement.
`--verify` asks a fresh call to label each span with the label withheld and sends every
disagreement to `review_queue.csv`. Without it, nothing in the pipeline has independently
checked that a row means what its label says — the heuristic flags below are a
substitute, not an equivalent.

### What the validator rejects, and what it merely flags

Rejected outright, counted by reason in `quality_report.json`:

- unknown label, empty text, under 8 or over 320 characters
- exact duplicates, after casefolding and stripping punctuation
- anything already in `phrases.csv` — re-adding shipped rows as "new data" would
  inflate the corpus with nothing in it
- near-duplicates: cosine similarity ≥ 0.85 over character 3–5 grams, compared across
  the **whole** corpus rather than per batch, because the same sentence arriving in two
  distant batches is exactly the case a per-batch check cannot see. Characters rather
  than words: *explain recursion simply* and *explain recursion simple* share no word
  bigram and are the same example.

Flagged for human review, kept out of the accepted set but not thrown away:

- a removable label (`FILLER`/`REDUNDANT`/`REPETITIVE`) on text containing a URL, code,
  or an explicit constraint such as a word count or a version pin
- `REPETITIVE` with neither context nor any word repeated inside the span itself
- `IMPORTANT` on what is only a greeting
- with `--verify`, any row the blind second pass labeled differently

The flags are deliberately **one-sided**: they fire on a removable label attached to
load-bearing text, and never on the reverse. A row that teaches the model to delete a
constraint is the expensive mistake here; a row that teaches it to keep a pleasantry
costs a few tokens.

### The REPETITIVE problem, and what the CSV cannot represent

`REPETITIVE` means *restates something the prompt already said*. That is a property of a
span **and its context**, and the schema is one row per span. Two spans with identical
text are correctly labeled differently depending on what came before them, so the CSV as
it stands cannot express the label it claims to hold.

The existing corpus quietly sidesteps this by only containing the self-contained kind —
*explain recursion, explain recursion again* — where the repetition is visible inside the
span. Those are learnable. The other kind (*and again, no external dependencies*, which
is only repetitive because the prompt said it earlier) is not learnable from the span
alone, and the classifier will guess.

**Backward-compatible solution, implemented in the generator, not yet in training.**
`synthetic_10000.csv` carries a fourth column, `context`, holding the earlier text the
span restates. It is backward-compatible in both directions: `train.py`'s
`load_dataset()` reads by key and ignores unknown columns, so the new file loads
unchanged, and `phrases.csv` without the column loads unchanged too.

Training on it is **deliberately not done**, and this is the reason:
`utils/ml-classifier.js` is handed one span at a time and has no earlier text to give the
model. A model trained on `context + text` would score better here and be a different
model from the one the extension can run. Using the column would require the content
script to supply preceding spans at inference time — a real change to
`utils/condense.js`, not a training flag — and that should be measured before it is
built. Until then the column is recorded so the data is not lost, and
`evaluate_synthetic.py` documents that it reads it and does not use it.

### The verdict

1,007 rows were authored and validated (of 1,024 raw; 11 rejected, 6 flagged for
review). That is **1,007, not the 10,000 requested** — see *Known limitations*.

`evaluate_synthetic.py` holds out a stratified 25% of the human rows, drops synthetic
rows too similar to any test row, searches hyperparameters separately for each arm, and
repeats the whole comparison over 25 different splits:

| | Arm A: original | Arm B: + synthetic | Δ (mean of 25 splits) |
| :--- | ---: | ---: | ---: |
| Training rows | 465 | 1,468 | |
| Four-class accuracy | 0.808 | 0.833 | **+0.029** (σ 0.020) |
| KEEP/DROP accuracy | 0.904 | 0.910 | +0.009 (σ 0.022) |
| IMPORTANT wrongly deleted | 7/41 | 9/41 | −0.026 (σ 0.057) |

Arm B retuned itself to `bigram_min_df=3, C=16.0` — with three times the data it wants a
higher bigram floor and a looser fit. Without that retune (`--no-search`) the four-class
gain shrinks to +0.016 and the harm metric moves the *wrong* way, so most of the
measured benefit comes from letting the larger corpus pick its own settings.

**The model was not promoted.** Four-class accuracy improves by more than the
split-to-split spread, and four-class accuracy is not what the optimizer consumes. The
number that governs behaviour is KEEP/DROP, and +0.009 against σ 0.022 — with arm B
ahead in 14 of 25 splits — is a coin flip, not a result. The harm metric is worse in 9
of 25 splits. `promote` therefore requires the KEEP/DROP gain to exceed the spread, and
it does not.

That threshold is blunt on purpose. The 25 splits are re-draws from the same 621 rows,
so they are nowhere near independent, and the standard error computed as if they were
would understate the uncertainty substantially.

### Known limitations

- **1,007 rows, not 10,000.** No LLM API is configured here, so every row was written
  by hand through the `manual` provider. The pipeline generates the rest once a key is
  set; it has not been run at that scale, and nothing in this repository should be read
  as a claim that 10,000 rows exist.
- **No blind verification has been run.** `--verify` needs an API provider. Every
  accepted label currently rests on the author plus the one-sided heuristic flags.
  `quality_report.json` records `agreementRate: null` rather than implying a check that
  did not happen.
- **The review queue has not been cleared.** Six rows sit in `review_queue.csv` awaiting
  a human; they are excluded from the accepted set, so this affects recall of the
  corpus, not its correctness.
- **1,007 hand-written rows cannot cover the axes claimed.** The domain, register and
  difficulty lists in `generate_synthetic.py` describe what the pipeline samples at
  scale. At this size the coverage of, say, multilingual-influenced English is thin.
- **The test set is 156 rows, 41 of them IMPORTANT.** One row changing side moves the
  harm metric by 2.4 points. That is why the verdict averages over splits, and why the
  promotion threshold is conservative.

---

## Reference corpus (LMSYS + BPO)

A corpus of real prompts, used to measure the scorer and the optimizer against input
nobody wrote for a unit test. It is **evaluation data**. Nothing in it trains the shipped
model, and nothing in it is treated as a verified quality score.

```bash
pip install -r requirements.txt

python ingest.py --source bpo                 # 14,351 rows, no auth needed
python ingest.py --export-jsonl corpus/sample.jsonl --export-limit 4000
node ../ml/evaluate_corpus.js                 # writes ml/corpus_eval.json
python test_ingest.py                         # 52 checks, offline
```

`ml/corpus/` is gitignored: it is 29 MB and regenerating it is one command.

### What each dataset is allowed to be used for

| | `zai-org/BPO` | `lmsys/lmsys-chat-1m` |
| :--- | :--- | :--- |
| Ships | `prompt`, `optimized_prompt`, `good_res`, `bad_res` | full conversations |
| Used for | evaluation, preservation tests, prompt diversity | diversity and generalisation |
| **Not** used for | training the optimizer | anything supervised |
| Auth | none | HF token + licence acceptance |

**BPO is not a rewrite target, and this is the most important thing in this section.**
Measured on its validation split, **70% of BPO's optimized prompts are LONGER than the
original** (median 1.29x, mean 2.08x). BPO optimizes the quality of the model's
*response*, largely by adding specificity and constraints. PromptMeter optimizes tokens
spent, under the rule that the user's meaning survives. Fitting one objective to the
other would teach the optimizer to pad prompts, which is the behaviour this project
exists to remove.

So BPO is used for what it can honestly support: real prompts, an independent opinion
that a given prompt was worth rewriting, and a corpus to check that the optimizer does
not destroy constraints.

### Authentication

BPO is public. LMSYS is gated (`gated: auto` on the Hub) and needs three things:

1. a Hugging Face account,
2. the terms accepted at <https://huggingface.co/datasets/lmsys/lmsys-chat-1m>,
3. a token, supplied the standard way:

```bash
huggingface-cli login      # or: export HF_TOKEN=hf_...
python ingest.py --source lmsys --limit 2000
```

**No token is read from, or written to, this repository.** `ingest.py` looks at
`HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACEHUB_API_TOKEN` and the CLI's own
store, in that order. With no token it prints what to do and exits cleanly rather than
failing part-way through a download. LMSYS is read with `streaming=True`, so
`--limit 2000` costs one shard rather than the several GB of the full dataset.

**Status: LMSYS has now been ingested.** 1,782 rows from a 2,000-row sample (71
duplicates, 147 under the length floor). The reader worked against the live schema on
the first run, which is what the faked-stream tests below predicted but could not prove.

**What is verified, and what is not.** The LMSYS field names are taken from its public
dataset card, which is readable without accepting the gate:

    conversation_id, model, conversation[{content, role}], turn, language,
    openai_moderation[{categories{...}, category_scores{...}, flagged}], redacted
    -- 1,000,000 rows, 2.6 GB, one train split

`test_ingest.py` exercises the reader against a faked stream in exactly that shape:
first user turn taken, later user turns and assistant turns ignored, a leading system
turn skipped past, a moderation-flagged turn dropped, a short moderation list survived.
That proves the extraction, which is the half holding the logic. It does **not** prove
the download, because the live dataset has never been reached from here. Until somebody
runs it with a token, treat the LMSYS path as tested-in-principle only.

Rows the dataset's own OpenAI moderation marks in any category are skipped. Using its
labels beats any keyword rule this pipeline could write, and keeps material nobody wants
in a reference corpus out of it.

### Corpus schema

One Parquet shard per batch, with a checkpoint so an interrupted run resumes.

| Column | Meaning |
| :--- | :--- |
| `id` | fingerprint of the normalised prompt; the duplicate key |
| `prompt`, `optimized_prompt` | the pair, or `null` when there is no rewrite |
| `optimized_origin` | **who** rewrote it: `model` for BPO, `null` otherwise |
| `source`, `split` | provenance |
| `language` | LMSYS ships this; `null` for BPO, which has no such column |
| `source_redacted` | the SOURCE dataset says it removed personal data — not a claim this pipeline found none |
| `task_category` | code / math / writing / analysis / roleplay / explain / howto / factual / other |
| `char_length`, `word_count`, `token_estimate` | descriptive only |
| `has_code`, `has_math`, `has_url`, `is_multiline` | what the row contains |
| `quality_label`, `quality_label_origin` | **always null** — see below |
| `schema_version` | bumped when the columns change |

`quality_label` exists and is always empty on purpose. Neither dataset ships a verified
prompt-quality score, so none is written. Human, model and heuristic judgements are kept
in separate columns precisely so that a later reader cannot mistake one for another —
`optimized_origin` says a *model* wrote that rewrite, and the extension's own rule output
lives in `ml/corpus_eval.json`, never in the corpus.

### Cleaning

Exact duplicates are dropped by fingerprint. Prompts under 8 or over 8,000 characters
are dropped. Personal data is redacted with deliberately narrow rules — emails, API
keys, bearer tokens, card-shaped digit runs, SSNs — and **never inside a fenced or
inline code span**, because a corpus that has lost its technical syntax cannot test
whether the optimizer preserves it. Version numbers, dimensions, money and long ids are
left alone. `test_ingest.py` asserts all of that.

---

## What the corpus found

### The optimizer was deleting the data prompts operate on

The preservation check runs the optimizer over every prompt and compares what went in
against what came out. On the first run it lost **numbers in 2.02%** of prompts and
**operators in 1.43%**:

```
"Output the 3rd and 7th element of the following list:\n[1, 5, 8, 11, 15, 20, 24, 30]"
  ->  "Output the 3rd and 7th element of the following list"
```

The request survived; the data it operates on did not, leaving a prompt that cannot be
answered. Root cause: `condense.js` decides what to prune from `contentWords()`, which
matches `[a-z]+` only — so a line of numbers, a bracketed list or a `Label: value` row
has *zero* content words and read as empty backstory. The `wordCount <= 3` fragment test
then finished off short list items like `C++`.

Fixed by teaching `classify()` what a data segment is, and treating one as core (never
droppable). Line structure is now preserved too: everything used to be rejoined with
spaces, which flattened `Item: X\nQuantity: 3` into one garbled run.

**Numbers lost: 2.02% → 0.05%. Operators: 1.43% → 0.60%.**

### The scorer could not see the things it claims to measure

Over 4,000 real prompts, **86.6% scored a perfect 100**. The rules only knew about
waste — padding, slang, typos, repetition — and most real prompts are not padded, they
are *under-specified*. Six quality rules were added, each documenting its own metric:

| id | Fires when | Penalty |
| :--- | :--- | ---: |
| `missing-output-format` | a generative request states no length, format or structure | 8 |
| `dangling-reference` | points at code/files/data that are not in the prompt | 12 |
| `contradiction` | opposing requirements in one prompt ("detailed but brief") | 10 |
| `vague-specification` | unquantified quality words carry the whole spec | 4 each, cap 12 |
| `no-clear-request` | no question, no imperative verb, no stated want | 15 |
| `truncated-instruction` | ends on a conjunction, colon or comma | 10 |

**Perfect scores: 86.6% → 57.7%. Mean 98.89 → 95.53. p10 95 → 85.**

Prompt length is deliberately *not* a rule. A short prompt is not a bad prompt, and
`quality.test.js` asserts that padding a prompt never raises its score.

### Other bugs the corpus surfaced

- **An empty prompt scored 100/100** — the one input that cannot be good scored best,
  and every empty box pulled the dashboard average up. `analyzePrompt` now returns
  `score: null, scored: false`, and the four places that consume the score were checked
  for a `null`. Two were wrong: `storage.js` treated null as a number and averaged it as
  zero, and the dashboard's history row would throw on `rating.color`.
- **`"What could it be"` became `"What could it is"`** — a modal takes the bare
  infinitive, and inverted questions put the subject between the modal and its verb.
- **`"around 1 1/2 years old"` became `"around 1/2 years old"`** — the repeated-word
  collapser treated two adjacent numbers as a doubled word.

### The scorer was penalising non-English prompts for being non-English

The first evaluation across both sources found a gap that had nothing to do with prompt
quality:

| | mean score | quality flags per prompt |
| :--- | ---: | ---: |
| English | 92.3 | 0.46 |
| Portuguese | 85.0 | 0.71 |
| Chinese | 86.7 | 0.89 |
| Japanese | 83.0 | 1.00 |

Two rules fire on the **absence** of an English cue: `no-clear-request` looks for an
English imperative verb, and `missing-output-format` for English words describing a
format. Given a Japanese prompt they find neither, and report a perfectly clear request
as having no clear request. The rules failing to read was being scored as the user
writing badly.

Those two now carry `requiresEnglish: true` and are skipped on text the scorer cannot
read. Rules that fire on the **presence** of an English phrase need no gate — they
simply stay quiet.

Detecting English is done against the spelling dictionary rather than a function-word
list, because Latin script decides nothing (Portuguese and German were penalised as
hard as Japanese) and short function words are shared across Romance languages — "a"
appears in both "a summary" and "a recursividade". Recognising a third of a prompt's
words as English is a deliberately low bar: calling English text non-English only
silences two rules, while the reverse reintroduces the bias.

| | mean score | quality flags per prompt |
| :--- | ---: | ---: |
| English | 92.5 | 0.45 |
| Portuguese | 95.6 | 0.00 |
| Chinese | 100 | 0.00 |
| Japanese | 95.0 | 0.20 |

**This is not multilingual support.** The quality rules are English-only and now admit
it by staying silent instead of guessing. A non-English prompt gets the waste rules —
typos, padding, repetition — and nothing else. Saying little is the honest position;
the previous behaviour said a lot and was wrong.

### Agreement with BPO

BPO's pairs are an independent opinion that a prompt was worth rewriting. The only claim
made from them is directional: if the scorer sees real weakness, the original should not
out-score the rewrite.

On the subset where BPO's rewrite is **no longer than** the original — the only fair
comparison, since PromptMeter does not reward length — the scorer now agrees **63/37**
(131 vs 77), up from 57/43 before the quality rules. This is weak evidence and is
reported as such: it is one directional signal, not a validated metric.

---

## Was retraining needed? No.

**The shipped classifier was not retrained, and neither dataset can justify retraining
it.** The model assigns one of four labels — IMPORTANT, FILLER, REDUNDANT, REPETITIVE —
to a phrase. Neither LMSYS nor BPO carries those labels, or anything convertible into
them:

- BPO tells you a *whole prompt* was rewritten. It does not say which *span* was filler.
- LMSYS carries no annotation at all.

Deriving four-class labels from either would mean inventing them, then training on them
as though they were verified — which is exactly what the brief forbids, and what
`ml/README.md` already records going wrong once with `dataset/expand.py`.

What the corpus is good for is measuring, and it has now paid for itself twice over: two
meaning-destroying optimizer bugs and a blind scorer, none of which the 1,095 hand-written
unit tests had caught, because all of them were written by the same person who wrote the
rules.

---

## Retraining

```bash
cd ml
pip install -r requirements.txt
python train.py
```

Prints the full classification report, rewrites `metrics.json`, and regenerates
`../utils/ml-model.js`. Reload the extension afterwards.

To add training data, append rows to `dataset/phrases.csv` in `text,label` form and
retrain. Duplicate texts are ignored.

### After retraining

Run all three suites from the project root:

```bash
node tests/optimizer.test.js    # rules, protection, end-to-end rewrites
node tests/grammar.test.js      # grammar corrections, and what must NOT be corrected
node tests/spelling.test.js     # typo corrections, and what must NOT be corrected
node tests/ml-parity.test.js    # JavaScript reproduces scikit-learn
node tests/regressions.test.js  # bugs found in real use, pinned to their prompt
node tests/quality.test.js      # prompt-quality scoring and the shapes that break it
node tests/tokens.test.js       # the design-token contract

python ml/test_generate_synthetic.py   # the synthetic validator
python ml/test_ingest.py               # corpus ingestion, offline
```

`ml-parity.test.js` is the one that matters most after a retrain. `ml-classifier.js`
reimplements the fitted transform by hand — tokenizer, n-gram order, sublinear TF, IDF,
L2 norm, softmax — and a mistake there does not throw. It produces slightly different
probabilities, the extension starts keeping and dropping different sentences, and the
accuracy above quietly stops describing what ships. The test compares against reference
predictions `train.py` writes at export time, and additionally asserts that no case lands
on a different side of `ML_KEEP_VETO` or `ML_DROP_PROPOSE`.

The transform settings travel to the browser inside the exported model, in a `config`
block that `ml-classifier.js` reads. They are deliberately not hard-coded in JavaScript:
a constant duplicated across two languages is a constant that silently drifts.

Then re-derive the thresholds — see *Where the thresholds come from* — since they
describe the model that was just replaced.
