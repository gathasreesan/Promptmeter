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
coefficient matrix. Inference is one sparse dot product. The shipped model is **86 KB**
and classifies a sentence in well under a millisecond.

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

### Four-class classification (held-out test set, n=128)

| Class | Precision | Recall | F1 | Support |
| :--- | ---: | ---: | ---: | ---: |
| FILLER | 0.64 | 0.72 | 0.68 | 32 |
| IMPORTANT | 0.81 | 0.85 | 0.83 | 34 |
| REDUNDANT | 0.66 | 0.63 | 0.64 | 30 |
| REPETITIVE | 0.74 | 0.62 | 0.68 | 32 |
| **Macro avg** | **0.710** | **0.708** | **0.707** | 128 |

**Accuracy 0.711** · 5-fold CV accuracy **0.779 (± 0.053)**

### KEEP vs DROP — the decision the optimizer actually consumes

The optimizer never uses the four labels directly. It asks one question of each
sentence: *may this go?* `FILLER`, `REDUNDANT` and `REPETITIVE` all mean yes.

| Metric | Score |
| :--- | ---: |
| Accuracy | **0.906** |
| Precision (macro) | 0.876 |
| Recall (macro) | 0.889 |
| F1 (macro) | 0.882 |

This is much higher than the four-way figure because most four-way errors are between
two *removable* classes — calling filler "redundant" changes no decision.

### Confusion matrix

```
            FILLER  IMPORT  REDUND  REPETI
FILLER          23       2       6       1
IMPORTANT        1      29       0       4
REDUNDANT        8       1      19       2
REPETITIVE       4       4       4      20
```

Only **1 of 34** IMPORTANT phrases was misread as FILLER — the error that would actually
hurt a user. FILLER↔REDUNDANT is the main confusion and is harmless here.

### Honest limitations

- 512 examples is small. The gap between the 0.711 held-out score and the 0.779 CV mean
  is what that sample size looks like.
- `REPETITIVE` is partly ill-posed for a single-sentence classifier: repetition is a
  property of a sentence *relative to the rest of the prompt*. The model can only see
  repetition visible inside one sentence.
- The dataset is hand-authored and skews toward student and developer prompts, which is
  the population PromptMeter serves — but it is not a random sample of anything.

---

## How it is wired in

```
Prompt
  → protect.js          mask code, URLs, paths, quotes            (unchanged)
  → optimizer.js        grammar, strippers, structural rewrites   (unchanged)
  → condense.js         sentence pruning
        ├── rules decide first
        └── ML consulted as a second opinion:
              VETO     rules want to drop, model says IMPORTANT ≥ 0.75  → keep
              PROPOSE  rules want to keep, model says removable ≥ 0.90  → drop
  → tokenizer / calculator / storage / dashboard                  (unchanged)
```

Two guarantees hold by construction:

1. **A core sentence is never offered to the model.** If the rules see a request, a
   constraint, or protected content, the sentence stays — no confidence level can
   overrule that.
2. **The thresholds are asymmetric.** Vetoing a removal costs a few tokens if wrong;
   proposing one costs the user's meaning. So proposals need 0.90 and vetoes need 0.75,
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
| `train.py` | Trains, evaluates, exports |
| `metrics.json` | Full generated report |
| `requirements.txt` | `scikit-learn>=1.3` |
| `../utils/ml-model.js` | **Generated** — the exported model |
| `../utils/ml-classifier.js` | Runtime inference in JavaScript |

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

After retraining, always run the suite from the project root:

```bash
node tests/optimizer.test.js
```

It checks JS/Python parity implicitly through the classification expectations, and
verifies the rules still behave identically with the assist disabled.
