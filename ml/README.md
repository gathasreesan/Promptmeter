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

Trained on **512 labeled phrases**, stratified 75/25 train/test split.
Hyperparameters are grid-searched on every run — 60 points over n-gram range, sublinear
TF, bigram floor and `C` — and scored by cross-validated **KEEP/DROP** accuracy, not
four-way accuracy. That choice is deliberate and it changes which model wins: the
optimizer never acts on the four labels, so a grid point that trades a FILLER/REDUNDANT
confusion for a correct KEEP/DROP call is better for this application and worse on the
four-way number.

Selected: `TfidfVectorizer(ngram=1-2, sublinear_tf=True, bigram_min_df=2)` +
`LogisticRegression(C=8.0, balanced)`

### Four-class classification (held-out test set, n=128)

| Class | Precision | Recall | F1 | Support |
| :--- | ---: | ---: | ---: | ---: |
| FILLER | 0.66 | 0.72 | 0.69 | 32 |
| IMPORTANT | 0.81 | 0.88 | 0.85 | 34 |
| REDUNDANT | 0.59 | 0.63 | 0.61 | 30 |
| REPETITIVE | 0.79 | 0.59 | 0.68 | 32 |
| **Macro avg** | **0.713** | **0.707** | **0.706** | 128 |

**Accuracy 0.711** · 5-fold CV accuracy **0.799 (± 0.037)**

The CV figure is now computed over the **whole pipeline**, vectorizer included. It
previously fit the vectorizer on every row before cross-validating the classifier over
that matrix, which leaked the test fold's vocabulary and IDF weights into training — and
is why the old CV number (0.779) read *higher* than it should have relative to the
held-out score.

### KEEP vs DROP — the decision the optimizer actually consumes

The optimizer never uses the four labels directly. It asks one question of each
sentence: *may this go?* `FILLER`, `REDUNDANT` and `REPETITIVE` all mean yes.

| Metric | Score |
| :--- | ---: |
| Accuracy | **0.914** |
| Precision (macro) | 0.883 |
| Recall (macro) | 0.904 |
| F1 (macro) | 0.893 |

This is much higher than the four-way figure because most four-way errors are between
two *removable* classes — calling filler "redundant" changes no decision.

### Confusion matrix

```
            FILLER  IMPORT  REDUND  REPETI
FILLER          23       2       6       1
IMPORTANT        1      30       1       2
REDUNDANT        8       1      19       2
REPETITIVE       3       4       6      19
```

Only **1 of 34** IMPORTANT phrases was misread as FILLER — the error that would actually
hurt a user. FILLER↔REDUNDANT is the main confusion and is harmless here.

### Where the thresholds come from

`ML_KEEP_VETO` and `ML_DROP_PROPOSE` in `condense.js` are set from measured precision,
not taste. Taking 5-fold cross-validated probabilities over the corpus and asking, at
each cut-off, how often the rule that fires is actually right:

| PROPOSE (`removable ≥ t`) | fires | precision | | VETO (`keep ≥ t`) | fires | precision |
| ---: | ---: | ---: | :-- | ---: | ---: | ---: |
| 0.85 | 299 | 0.973 | | 0.70 | 79 | 0.911 |
| 0.88 | 281 | 0.975 | | 0.75 | 71 | 0.916 |
| 0.90 | 259 | 0.981 | | 0.80 | 58 | **0.931** |
| 0.92 | 231 | **0.991** | | 0.85 | 45 | 0.978 |

PROPOSE sits at **0.92**, because it deletes the user's own words and is held to ~99%
precision. VETO sits at **0.80**, where precision improves meaningfully over 0.75 while
still firing often; being wrong there only costs a few tokens.

**Re-derive these after retraining.** They describe a particular fitted model, not a
property of the approach.

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
| `dataset/phrases.csv` | 512 labeled phrases |
| `dataset/expand.py` | Corpus generator — **an experiment that did not pay off**; see above |
| `train.py` | Trains, evaluates, exports |
| `metrics.json` | Full generated report |
| `requirements.txt` | `scikit-learn>=1.3` |
| `../utils/ml-model.js` | **Generated** — the exported model |
| `../utils/ml-classifier.js` | Runtime inference in JavaScript |
| `../tests/ml-parity.json` | **Generated** — reference predictions for the parity test |

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
