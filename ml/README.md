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
