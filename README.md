# 🌿 PromptMeter — AI Sustainability Coach & Carbon Tracker

> A browser extension and analytics dashboard that tracks the environmental footprint (Electricity and CO₂ emissions) of your Large Language Model interactions on ChatGPT in real-time, offering instant prompt optimization and gamified coaching.

---

## 📑 Table of Contents

1. [Project Overview](#-project-overview)
2. [Quick Start & How-To Guide](#-quick-start--how-to-guide)
   - [Step 1: Install Dependencies & Build Dashboard](#step-1-install-dependencies--build-dashboard)
   - [Step 2: Load Extension into Chrome](#step-2-load-extension-into-chrome)
   - [Step 3: Test on ChatGPT](#step-3-test-on-chatgpt)
   - [Step 4: View Popup & Open Dashboard](#step-4-view-popup--open-dashboard)
3. [How It Works (System Architecture)](#-how-it-works-system-architecture)
4. [File & Directory Structure](#-file--directory-structure)
5. [Core Modules & Features](#-core-modules--features)
   - [1. Real-Time Prompt Optimization](#1-real-time-prompt-optimization)
   - [2. Multi-Modal & Attachment Tracking](#2-multi-modal--attachment-tracking)
   - [3. Environmental Footprint Calculator](#3-environmental-footprint-calculator)
   - [4. Local Storage Layer (Privacy-First)](#4-local-storage-layer-privacy-first)
   - [5. Recommendation & Coaching Engine](#5-recommendation--coaching-engine)
   - [6. Gamification & Streak Engine](#6-gamification--streak-engine)
   - [7. React Analytics Dashboard](#7-react-analytics-dashboard)
6. [Scientific Calculation Reference](#-scientific-calculation-reference)
7. [What Happened Each Time (Build Log & History)](#-what-happened-each-time-build-log--history)
8. [Troubleshooting & FAQs](#-troubleshooting--faqs)

---

## 🌟 Project Overview

When users query generative AI models (like ChatGPT), every token processed requires GPU computation, electricity, and carbon emission overhead. 

**PromptMeter** functions as a personal sustainability coach:
- **Monitors** your queries and responses on ChatGPT.
- **Analyzes** prompt efficiency (detecting redundant preambles, greetings, politeness fillers, and duplicate words).
- **Offers real-time suggestions** directly above the chat box to cut unnecessary tokens before submitting.
- **Calculates** real-time environmental metrics (Watt-hours, grams of CO₂).
- **Stores data locally** in your browser (`chrome.storage.local`) with zero external tracking.
- **Visualizes** your usage patterns and achievements in a React-based Dashboard.

---

## 🚀 Quick Start & How-To Guide

Follow these step-by-step instructions to get PromptMeter running locally on your computer.

### Step 1: Install Dependencies & Build Dashboard

The analytics dashboard is built with **React** and **Chart.js**, bundled using **esbuild**.

1. Open PowerShell / Command Prompt.
2. Navigate to the `dashboard` directory:
   ```bash
   cd c:\Users\gatha\OneDrive\Documents\Promptmeter\dashboard
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the production bundle (`dist/bundle.js`):
   ```bash
   npm run build
   ```

> **Note:** `node_modules/` is intentionally not committed. `npm install` rebuilds it exactly from `package-lock.json`.

---

### Step 1b: Run the Test Suites (Optional)

Four dependency-free suites, 714 checks in total. From the project root:

```bash
node tests/optimizer.test.js    # 285 - protected spans, meaning preservation, filler removal
node tests/grammar.test.js      # 109 - grammar corrections, and what must NOT be corrected
node tests/spelling.test.js     # 192 - typo correction, and what must NOT be corrected
node tests/ml-parity.test.js    # 128 - JavaScript reproduces scikit-learn exactly
```

Run the first after any edit to `utils/optimizer.js`, `utils/protect.js`, or
`utils/condense.js`; the second after editing `utils/grammar.js`; the third after
editing `utils/spelling.js`; the fourth after retraining (`cd ml && python train.py`).

`ml-parity.test.js` matters most after a retrain: `ml-classifier.js` reimplements the
fitted transform by hand, and a mistake there does not throw — it silently changes which
sentences the extension keeps.

---

### Step 2: Load Extension into Chrome

1. Open **Google Chrome** (or any Chromium browser like Brave, Edge).
2. Navigate to the Extensions management page:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** toggle in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. In the file picker, select the **root project folder**:
   ```text
   c:\Users\gatha\OneDrive\Documents\Promptmeter
   ```
6. Verify that **PromptMeter** (v1.0) appears in your extensions list.

---

### Step 3: Test on ChatGPT

1. Go to [https://chatgpt.com](https://chatgpt.com) (or `https://chat.openai.com`).
2. Open Chrome DevTools (`F12` or `Ctrl + Shift + I`) and click the **Console** tab. You should see:
   ```text
   ✅ PromptMeter Active on ChatGPT
   ```
3. In the ChatGPT prompt box, type a wordy prompt containing greetings and fillers:
   ```text
   Hello ChatGPT, could you please kindly write a python script to parse log files? thank you!
   ```
4. Notice the **PromptMeter Optimization Card** pop up above your text box, showing:
   - **Tokens Saved:** e.g., `-10 Tokens`
   - **CO₂ Saved:** e.g., `-0.004g CO₂`
   - **Before / After Diff Comparison**
5. Click **Accept Optimization** to automatically replace the prompt with the clean version:
   ```text
   Write a python script to parse log files
   ```
6. Send the prompt and wait for the response to finish generating. PromptMeter captures the turn and calculates the exact metrics!

---

### Step 4: View Popup, Toggle ON/OFF & Open Dashboard

1. Click the **Extensions puzzle icon** in your Chrome toolbar and pin **PromptMeter**.
2. Click the **PromptMeter icon**:
   - **Toggle On/Off:** Use the slider switch in the top-right corner to toggle PromptMeter active or paused at any time.
   - **Live Status:** Displays a status badge and monitor banner (Active vs. Paused).
   - **Stats Preview:** Displays a live quick-preview of your **Carbon Footprint** and **Average Efficiency**.
3. Click the **"Open Dashboard"** button:
   - Opens the full-page React Analytics Dashboard in a new browser tab.
   - Explore the **Overview**, **Queries Log**, and **Advisor Insights** tabs.

---

## 🏗️ How It Works (System Architecture)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ChatGPT Page (DOM)                              │
│                                                                        │
│   ┌─────────────────────┐              ┌───────────────────────────┐   │
│   │ Prompt Input Field  │              │  Assistant Response Box   │   │
│   └──────────┬──────────┘              └─────────────┬─────────────┘   │
└──────────────┼───────────────────────────────────────┼─────────────────┘
               │ (Typing Event / Attachments)          │ (MutationObserver Done)
               ▼                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      content.js (Content Script)                       │
│                                                                        │
│   1. Debounced Input Handler       6. Stream Finalization Detector     │
│   2. Attachment & Link Parser      7. Tokenizer (TikToken / Heuristic) │
│   3. Live Optimization Overlay     8. Calculator (Wh / CO₂)           │
└──────────────────────┬───────────────────────────────┬─────────────────┘
                       │                               │
                       ▼                               ▼
       ┌──────────────────────────────┐ ┌───────────────────────────────┐
       │   utils/optimizer.js         │ │   utils/storage.js            │
       │   - Regex NLP Rules          │ │   - chrome.storage.local      │
       │   - Politeness & Filler Strip│ │   - FIFO 500-Record Cap       │
       │   - Duplicate Detection      │ └──────────────┬────────────────┘
       │         ▼                    │                │
       │   utils/spelling.js          │                │
       │   - Skeletons / edit shape   │                │
       │         ▼                    │                │
       │   utils/grammar.js           │                │
       │   - Agreement / tense        │                │
       │   - Confusables / articles   │                │
       └──────────────────────────────┘                │
                                                       │
                       ┌───────────────────────────────┼───────────────────────────────┐
                       ▼                               ▼                               ▼
       ┌──────────────────────────────┐ ┌───────────────────────────────┐ ┌───────────────────────────┐
       │   popup.html / popup.js      │ │  utils/recommendations.js     │ │  utils/gamification.js    │
       │   - Fast stats preview       │ │  - Diagnostics Audit          │ │  - Streak Tracker         │
       │   - Open Dashboard trigger   │ │  - Personalized Action Items  │ │  - Badges & Milestones    │
       └──────────────────────────────┘ └──────────────┬────────────────┘ └─────────────┬─────────────┘
                                                       │                                │
                                                       ▼                                ▼
                                       ┌───────────────────────────────────────────────────────────────┐
                                       │              dashboard/ (React + Chart.js App)                │
                                       │  • Overview Tab (KPIs, Charts, Weekly Challenge, Streak)      │
                                       │  • Queries Log Tab (Search, Token / Carbon, Filter, Badges)   │
                                       │  • Advisor Insights Tab (Health Gauge, Milestones, Badges)    │
                                       └───────────────────────────────────────────────────────────────┘
```

---

## 📁 File & Directory Structure

```
Promptmeter/
├── manifest.json            # Chrome Extension Manifest (MV3, permissions, content scripts)
├── content.js               # Injects into ChatGPT: monitors typing, captures responses & attachments
├── content.css              # Styling for in-page optimization card & diff viewer
├── popup.html               # Extension action popup layout
├── popup.js                 # Fetches summary stats for popup & handles "Open Dashboard" click
├── style.css                # Styling for the extension popup window
├── .gitignore               # Excludes node_modules/ and OS cruft from version control
├── utils/                   # Core modular utility engines (load order set by manifest.json)
│   ├── theme.js             # Light/dark theme resolution shared by popup, content & dashboard
│   ├── protect.js           # Marks spans that must survive verbatim (code, URLs, paths, quotes)
│   ├── condense.js          # Sentence pruning + situational-preamble removal (exams, moods, backstory)
│   ├── spelling.js          # Open-ended typo correction (consonant skeletons + edit shape)
│   ├── grammar.js           # Grammar detection & repair (agreement, tense, confusables, articles)
│   ├── ml-classifier.js     # TF-IDF + logistic regression inference (runtime half of the ML component)
│   ├── ml-model.js          # GENERATED by ml/train.py — vocabulary, IDF weights, coefficients
│   ├── tokenizer.js         # Heuristic token counting
│   ├── calculator.js        # Environmental math: Electricity (Wh), Carbon (g CO₂)
│   ├── optimizer.js         # Rule-based NLP optimizer & scoring engine (0-100 score)
│   ├── recommendations.js   # Audits history to diagnose behavioral pitfalls & tips
│   ├── gamification.js      # Streak tracking, eco-badges, and weekly saving challenges
│   └── storage.js           # Chrome Local Storage wrapper with FIFO 500-item cap
├── tests/
│   ├── optimizer.test.js    # Optimizer regression suite (285 checks)
│   ├── grammar.test.js      # Grammar engine suite (109 checks) — corrections AND non-corrections
│   ├── spelling.test.js     # Spelling corrector suite (192 checks) — mostly non-corrections
│   ├── ml-parity.test.js    # JS/scikit-learn agreement (110 checks)
│   └── ml-parity.json       # GENERATED by ml/train.py — reference predictions
├── dashboard/               # Full-page React Analytics Dashboard
│   ├── index.html           # HTML container loading React app
│   ├── package.json         # Dashboard dependencies (React 18, Chart.js, esbuild)
│   ├── package-lock.json    # Pinned dependency tree — `npm install` reproduces node_modules/
│   ├── dist/                # Build output, committed so the extension loads without a build step
│   │   ├── bundle.js        # Compiled production JavaScript bundle
│   │   └── bundle.css       # Compiled dashboard stylesheet
│   └── src/
│       ├── index.js         # React DOM mounting entry point
│       ├── index.css        # Dashboard global styles and glassmorphism design tokens
│       └── App.jsx          # Complete 3-Tab Dashboard component (Overview, Queries, Insights)
└── README.md                # Project documentation, instructions & development log
```

---

## ⚙️ Core Modules & Features

### 1. Real-Time Prompt Optimization
- **Trigger:** Debounced (750ms) as you type in ChatGPT's message box (`#prompt-textarea`).
- **Rules (`optimizer.js`):**
  - Strips greetings (`hello`, `hi chatgpt`, `good morning`).
  - Removes polite conversational padding (`could you please`, `would you mind`, `thank you`).
  - Removes non-instructional preambles (`I am bored so I want to...`, `I was wondering if...`).
  - Simplifies wordy phrases — 87 one-for-many substitutions (`in order to` → `to`,
    `carry out an analysis of` → `analyze`, `on a daily basis` → `daily`,
    `has the ability to` → `can`). Replacing many words with one of the same meaning is
    the only rephrasing safe to automate: the words change, the request does not.
  - **Never lengthens.** Acronyms are case-normalised and never expanded, so `dsa` becomes
    `DSA`, not `Data Structures & Algorithms` (which cost 5 extra tokens). Universally
    understood abbreviations are already as short as the request gets.
  - Removes duplicate adjacent words (`write write` → `write`).
  - Removes hedged request wrappers whole (`I was thinking maybe you could possibly help me`
    → `help me`), so no hedge is left stranded in front of the instruction.
  - Expands SMS and chat abbreviations and corrects open-ended typos — see §1b. This is
    not cosmetic: the situational rules below are written against real English, so
    `tmrw is mi exm` and `i m havng exam on Monda` match none of them until the words are
    repaired first.
- **Grammar (`grammar.js`):** corrects agreement, tense, confusables, pronoun case, articles
  and contractions, and reports each correction. See §1c.
- **Situational preamble removal (`condense.js`):** strips the circumstances around a request
  — exams and deadlines, time pressure, mood, excuses, who assigned the work, where the user saw it,
  academic year — so `hey I have an exam tomorrow teach me ML` becomes `Teach me ML`.
  Two guards keep it safe: a request must survive the removal, and the subject must survive with it,
  so `I have an exam tomorrow` alone and `...exam in AI, help me to study` are both left intact.
  Clauses that shape the answer (`I am a beginner`) are kept deliberately.
- **ML assist (`ml-classifier.js`):** a TF-IDF + logistic regression classifier, trained offline
  with scikit-learn, labels each sentence `IMPORTANT` / `FILLER` / `REDUNDANT` / `REPETITIVE`.
  It is a **second opinion only** — it can veto a removal the rules wanted (≥ 0.75 confident the
  sentence is important) or propose one the rules missed (≥ 0.90 confident it is removable), but
  it is never shown a sentence the rules already identified as the request. See
  [`ml/README.md`](ml/README.md) for the dataset, metrics and retraining steps.
- **UI:** Overlays a clean card showing tokens saved, carbon saved, and an instant **Accept** button.
  The card is positioned against the live composer rectangle (measured via `ResizeObserver`), so it sits
  above the prompt box and shrinks/scrolls as the box grows instead of covering what you are typing.

### 1a. Code Is Never Touched — Including Its Indentation

`protect.js` masks anything that must survive byte for byte before any rewriting happens:
fenced blocks, indented blocks, tracebacks, URLs, paths, quoted material, identifiers.

Two cases needed work beyond that:

**Unfenced code.** The indented-block rule needs four spaces or a tab, so a two-space
style slipped past it. Nothing was masked, `isCodeSnippet()` then judged the *whole*
prompt to be code, and `optimizePrompt` returns code untouched — so the snippet was safe
but `"review this code plz"` and `"thanks a lot"` were never stripped. A proportional rule
now masks runs of consecutive mostly-code-shaped lines, so the prose around a snippet is
optimized while the snippet is preserved.

**Blocks keep their own line.** Several strippers end in `\s*`, which happily ate the
newline separating prose from a pasted snippet, welding code onto the end of a sentence.
For a language where a line break is syntax that changes the program. Any span that is
already multi-line is now guaranteed its own line; an inline path or identifier still sits
mid-sentence.

Indentation is asserted byte-for-byte for 4-space, tab, 2-space and YAML nesting styles.

### 1b. Spelling Correction

Two layers, because chat shorthand and ordinary typos fail differently.

**Known abbreviations** (`optimizer.js`) are a lookup: `tmrw` → `tomorrow`, `exm` → `exam`,
`coz` → `because`, `prof` → `professor`. The very short ones (`u`, `ur`, `mi`, `r`) carry
per-word context rules instead of being replaced on sight, because `solve for u`,
`y = mx + b`, `given r = 5` and `set mi = 0` are all real prompts this tool sees. `y` is
never expanded at all — `y is this slow` and `y is the vertical axis` are the same shape.

**Open-ended typos** (`spelling.js`) are the ones no table can list — `havng`, `shrt`,
`Monda`, `diffrence`. A general edit-distance corrector is the obvious design and a bad
one: at distance 1, `redis` reaches `reds` and `numpy` reaches `bumpy`. Precision comes
from two narrower signals instead:

1. **Consonant skeleton must match exactly.** People drop and transpose *vowels* and keep
   *consonants* — `havng`/`having` are both `hvng`, `recieve`/`receive` are both `rcv`.
   Runs of repeated letters collapse too, so `tomorow` still reaches `tomorrow`.
2. **The edit must be a shape people produce.** Sorting real typos by edit shape separates
   them from corruptions cleanly:

   | Shape | Examples | |
   | :--- | :--- | :--- |
   | Deletions | `havng`/`having`, `diffrence`/`difference` | accepted |
   | Insertions | `compleate`/`complete` | accepted |
   | Transposition | `teh`/`the`, `undrestand`/`understand` | accepted |
   | **Substitution** | `stack`/`stuck`, `heap`/`hope`, `leaf`/`life` | **rejected** |

   Every corruption an earlier version produced was a substitution — swapping one letter
   is what turns an unlisted technical word into a different real word. Refusing them
   costs recall (`spellong` → `spelling` is a substitution and is no longer caught) and
   buys the guarantee that unlisted vocabulary survives.

A third rule completes truncations (`Monda` → `Monday`) but refuses any completion whose
added letters form a productive suffix — otherwise `except` becomes `exception`, which
inverts `explain everything except the math part`. The edit budget is proportional to word
length, since three edits is a slip in a ten-letter word and a different word in a
five-letter one.

Two acknowledged limits: recall is bounded by the built-in dictionary (~2,100 words,
including technical vocabulary, since **a word it lists is never altered**), and a
capitalized word mid-sentence is left alone — `on Monda` is not corrected where
`on monda` is, because rewriting someone's name or library is worse than leaving a typo.

```
"i m havng exam on Monda teach me ml make it shrt"  →  "Teach me ML make it short"
"hey tmrw is mi exm teach me ML"                    →  "Teach me ML"
"plz explain teh diffrence betwen list and tuple"   →  "Explain the difference between list and tuple"
```

### 1c. Grammar Detection & Correction

`utils/grammar.js` finds and repairs the errors people make typing a prompt in a hurry, and
**reports each one** so the card can say what was wrong rather than silently rewriting the
user's words.

| Class | Caught | Example |
| :--- | :--- | :--- |
| Agreement | subject-verb, compound subjects | `i has` → `I have`, `he go` → `he goes` |
| Verb form | after modals, infinitives, do-support | `should has` → `should have`, `doesn't works` → `doesn't work` |
| Tense | with an explicit past-time marker | `yesterday he go` → `yesterday he went` |
| Confusables | their/there/they're, its/it's, your/you're, then/than, to/too, affect/effect | `Their is a problem` → `There is a problem` |
| Noun form | uncountables, irregular plurals | `datas` → `data`, `childs` → `children` |
| Pronoun case | object pronouns in subject position | `me and him was` → `he and I were` |
| Articles | a/an agreement, articles on uncountables | `a essay` → `an essay` |
| Contractions | missing apostrophes | `dont` → `don't` |
| Phrasing | verb frames, double negatives/comparatives | `explain me about X` → `explain X` |

Every rule follows one contract: **precision over recall**. A wrong "correction" corrupts the
user's meaning, which is worse than leaving an error in place, so rules fire on closed word
classes and decline anything ambiguous. Where a pattern has a legitimate reading, it is
narrowed until that reading is safe — the suite asserts all of these are left alone:

> `a bug that affects users` · `all it does is print the value` · `send it to many people`
> · `she read the book yesterday` · `an information system with a feedback loop`
> · `the works of Shakespeare` · `explain how it works and what is the difference`

Roughly half of `tests/grammar.test.js` tests what must **not** change.

### 1d. Machine Learning Component

A lightweight classifier that closes the blind spot in a pure blacklist: a sentence nobody
wrote a rule for. Trained on **621 labeled phrases**, with hyperparameters grid-searched on
every run (60 points) and scored by cross-validated **KEEP/DROP** accuracy — the only call
the optimizer actually makes.

| Metric | Four-class | KEEP vs DROP |
| :--- | ---: | ---: |
| Accuracy | 0.814 | **0.910** |
| Precision (macro) | 0.821 | 0.880 |
| Recall (macro) | 0.812 | 0.892 |
| F1-score (macro) | 0.813 | 0.886 |

5-fold CV accuracy **0.802 (± 0.025)**, computed over the whole pipeline including the
vectorizer. (It previously fit the vectorizer on every row before cross-validating the
classifier, leaking the test fold's vocabulary and IDF into training.)

The model exports to **130 KB** of vocabulary, IDF weights and coefficients, so inference is
one sparse dot product in JavaScript: no server, no WASM, and prompt text never leaves the
browser. The transform settings travel with the model in a `config` block that the JavaScript
reads, so the two implementations cannot drift apart — and `tests/ml-parity.test.js` proves
they agree. Setting both thresholds above 1.0 disables the assist and restores pure
rule-based behaviour, which the suite verifies.

The classifier is a **second opinion, never the decision maker**. A sentence that asks,
constrains, reports a problem, or holds protected content is never offered to it. The
thresholds are asymmetric and set from measured precision: proposing a removal needs
`0.90` (~99% precision, because it deletes the user's words), vetoing one needs `0.75`
(being wrong costs a few tokens). See `ml/README.md`, including a documented **negative
result** — expanding the corpus with generated phrases tripled the headline accuracy while
making the real decision slightly worse.

```
Prompt → protect → spelling → grammar → rules → ML classification → combined decision
       → optimized prompt → token / environment / dashboard system
```

### 1e. Scope Analysis — when a prompt has no filler and is still wasteful

Every rule above hunts for *wasted words*. Some prompts have none and are wasteful anyway:

> Create an AI-powered education platform that manages students, teachers, courses,
> attendance … and administrative controls. Explain every feature, database table, API
> endpoint … in detail and provide complete production-ready code for the frontend,
> backend, database, …

195 tokens, no greeting, no politeness, no hedging, no typos. The optimizer scored it
**100/100 and changed nothing** — and it was right that there is little to strip. The 39
features *are* the request. Compression can't help either: the three items appearing in
two lists (`database`, `APIs`, `authentication`) name a **feature** in one list and a
**code layer** in the other, so deduplicating them would delete the database layer from
the code request.

The waste is real but it isn't in the wording. Asking for forty subsystems plus complete
production code returns a shallow or truncated answer, and the user spends several more
turns recovering what one focused prompt would have produced. So `scopeIssues()` reports
it as advice rather than pretending to rewrite it:

| Signal | Threshold |
| :--- | :--- |
| Longest comma-separated enumeration | > 12 items |
| Distinct deliverable verbs (`explain`, `provide`, `implement`…) | > 3 |
| Exhaustiveness markers (`every`, `complete`, `in detail`) over a long list | ≥ 3 |

That prompt now scores **81** with a flag naming the problem, instead of a false 100.
Nothing in the enumeration is removed — only the user can decide what to drop.

### 2. Multi-Modal & Attachment Tracking
- **Images:** Identifies attached thumbnails and adds $+170\text{ tokens}$ per image.
- **Documents / PDFs:** Parses file bubbles and estimates tokens based on file size ($0.25\text{ tokens/byte}$, minimum $2000\text{ tokens}$).
- **Web URLs:** Scans prompt text for links ($+2000\text{ tokens}$ estimated browsing context).

### 3. Environmental Footprint Calculator
- Computes resource consumption for every conversation turn.
- Formulas based on published research (*Luccioni et al., 2023; Li et al., 2023*).

### 4. Local Storage Layer (Privacy-First)
- Uses `chrome.storage.local`. No data leaves your machine.
- Automatically maintains a rolling FIFO cache of the last 500 queries.
- Prevents duplicate turn logs using prompt-response hashing.

### 5. Recommendation & Coaching Engine
- Dynamically audits user history:
  - High filler token ratios → Generates warning to strip polite filler.
  - Repetitive queries / rapid regenerations → Flags prompt re-use.
  - High attachment usage → Suggests summarizing text before uploading.

### 6. Gamification & Streak Engine
- **Coaching Streak:** Counts consecutive days where prompt efficiency $\ge 90\%$.
- **Eco-Milestones & Badges:**
  - 🏅 *Green Starter* (Logged first query)
  - 🌱 *Eco Apprentice* (Saved $0.5\text{g CO}_2$)
  - ⚡ *Token Master* (Achieved 5 efficient queries)
  - 🔥 *Week Streak* (Maintained a 7-day efficiency streak)
  - 🌳 *Carbon Neutralizer* (Saved $5.0\text{g CO}_2$)
  - 🌟 *Sustainability Guru* (Achieved 20 efficient queries)
- **Weekly Challenge:** Interactive progress bar toward saving $2.0\text{g CO}_2$.

### 7. React Analytics Dashboard
- **Overview Tab:** Summary KPI cards, interactive Chart.js bar/line graph (daily, weekly, monthly views), streak counters, and weekly challenges.
- **Queries Log Tab:** Filterable and searchable table of all recorded prompts and responses with attachment tags, tokens, carbon, and efficiency scores.
- **Advisor Insights Tab:** Circular health gauge, sustainability prompter tier, categorized critical optimization warnings, and badge unlock showcase.

---

## 🔬 Scientific Calculation Reference

PromptMeter estimates inference footprint using peer-reviewed environmental research benchmarks:

| Metric | Formula | Constant / Research Baseline |
| :--- | :--- | :--- |
| **Electricity** | $\text{Tokens} \times 0.001\text{ Wh}$ | $1\text{ Wh per } 1,000\text{ tokens}$ (GPU inference average) |
| **Carbon Emissions** | $\text{Electricity (Wh)} \times 0.36\text{ g CO}_2$ | $360\text{ g CO}_2\text{/kWh}$ (US Grid Average) |

### Environmental Equivalents
- **LED Lightbulb:** $\text{Total Electricity} / 10\text{W}$ hours.
- **Car Driving:** $\text{Total Carbon} \times 8.3\text{ meters}$.

---

## 📜 What Happened Each Time (Build Log & History)

Here is a chronological record of how the PromptMeter codebase was structured and built:

### 🔹 Iteration 1: Initial Extension Setup & Manifest
- Configured Manifest V3 (`manifest.json`) targeting `https://chatgpt.com/*` and `https://chat.openai.com/*`.
- Configured storage permissions (`"permissions": ["storage"]`).
- Set up script injection order: tokenizer $\rightarrow$ calculator $\rightarrow$ storage $\rightarrow$ optimizer $\rightarrow$ recommendations $\rightarrow$ gamification $\rightarrow$ `content.js`.

### 🔹 Iteration 2: Real-Time DOM Capture & Streaming Detection
- Built `MutationObserver` in `content.js` to observe ChatGPT message stream completion.
- Implemented streaming status detector (`.result-streaming`, `Stop generating` button) with an 800ms debounce to ensure complete markdown rendering before saving.
- Added prompt-response pair finder (`findPrecedingUserPrompt`).

### 🔹 Iteration 3: Environmental Math & Optimization Engine
- Created `utils/calculator.js` to compute Wh and g CO₂.
- Created `utils/optimizer.js` with regex-based light NLP to detect greetings, politeness, preambles, and filler words.
- Created `utils/tokenizer.js` supporting TikToken BPE encoding with word-heuristic fallback.

### 🔹 Iteration 4: In-Page Live Optimization Card
- Implemented `showOptimizationCard` and `applyOptimization` in `content.js` and `content.css`.
- Displays real-time diff preview above the ChatGPT prompt box with token/carbon savings.
- Replaces prompt input text directly via DOM dispatch events when accepted.

### 🔹 Iteration 5: Multi-Modal Attachment Support
- Implemented `detectAttachments()` in `content.js` to detect uploaded image previews, PDF/doc pills, and URLs.
- Added token weighting for images (+170 tokens) and documents ($0.25\text{ tokens/byte}$).

### 🔹 Iteration 6: Gamification, Streaks & Advisor Engine
- Built `utils/gamification.js` to evaluate 6 badge criteria, compute consecutive day efficiency streaks, and track weekly goals.
- Built `utils/recommendations.js` to audit historical turns and provide actionable advice.

### 🔹 Iteration 7: Full-Page React Analytics Dashboard
- Initialized React 18 dashboard in `dashboard/` bundled with `esbuild`.
- Built 3 navigation views:
  1. **Overview:** KPI cards, Chart.js time-series graph, weekly challenge bar, streak tracker.
  2. **Queries Log:** Searchable turn-by-turn table with attachments badges and diff scores.
  3. **Advisor Insights:** Health gauge (0–100%), tier rating, critical warnings, and badge matrix.
- Added mock data fallback for previewing in standalone browser environments when Chrome storage is not present.

### 🔹 Iteration 8: Popup ON/OFF Toggle Switch & Runtime State Sync
- Added modern iOS-style toggle slider to `popup.html` and `style.css`.
- Synchronized `isEnabled` flag with `chrome.storage.local` across all tabs.
- Added live storage listeners in `content.js` to instantly pause/resume prompt optimization cards and turn footprint logging without requiring page reloads.

---

## ❓ Troubleshooting & FAQs

### 1. I edited code in `utils/` or `content.js`. Why aren't changes showing up on ChatGPT?
Content scripts are cached by the browser until reloaded:
1. Go to `chrome://extensions`.
2. Click the **Reload (circular arrow)** button on the PromptMeter card.
3. Refresh your ChatGPT browser tab (`Ctrl + F5` or `Cmd + Shift + R`).

### 2. I edited `dashboard/src/App.jsx`. Why didn't the dashboard update?
The React dashboard must be re-bundled after editing source files:
```bash
cd dashboard
npm run build
```
Then refresh your dashboard tab.

### 3. The dashboard shows sample mock data instead of my real queries.
If you open `dashboard/index.html` directly via `file://` or a local web server (instead of clicking "Open Dashboard" from the Chrome Extension popup), `chrome.storage.local` is unavailable, so the app automatically displays curated mock data for design preview. When opened through the extension popup, your real logged queries will appear.

### 4. How do I clear my stored history?
You can clear stored logs by opening Chrome DevTools on the extension popup or dashboard and executing:
```javascript
chrome.storage.local.set({ history: [] });
```

---

## 👥 Authors & License

- **Project:** PromptMeter — AI Sustainability Coach
- **License:** MIT
