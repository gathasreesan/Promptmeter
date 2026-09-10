# 🌿 PromptMeter — AI Sustainability Coach & Carbon Tracker

> A browser extension and analytics dashboard that tracks the environmental footprint (Electricity, CO₂ emissions, Water) of your Large Language Model interactions on ChatGPT in real-time, offering instant prompt optimization and gamified coaching.

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

When users query generative AI models (like ChatGPT), every token processed requires GPU computation, electricity, cooling water, and carbon emission overhead. 

**PromptMeter** functions as a personal sustainability coach:
- **Monitors** your queries and responses on ChatGPT.
- **Analyzes** prompt efficiency (detecting redundant preambles, greetings, politeness fillers, and duplicate words).
- **Offers real-time suggestions** directly above the chat box to cut unnecessary tokens before submitting.
- **Calculates** real-time environmental metrics (Watt-hours, grams of CO₂, milliliters of water).
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

### Step 1b: Run the Optimizer Test Suite (Optional)

The optimizer has a dependency-free regression suite (131 checks) that verifies protected spans come back
byte-for-byte, instruction words survive, and filler is stripped. From the project root:

```bash
node tests/optimizer.test.js
```

Run it after any edit to `utils/optimizer.js`, `utils/protect.js`, or `utils/condense.js`.

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
│   3. Live Optimization Overlay     8. Calculator (Wh / CO₂ / Water)    │
└──────────────────────┬───────────────────────────────┬─────────────────┘
                       │                               │
                       ▼                               ▼
       ┌──────────────────────────────┐ ┌───────────────────────────────┐
       │   utils/optimizer.js         │ │   utils/storage.js            │
       │   - Regex NLP Rules          │ │   - chrome.storage.local      │
       │   - Politeness & Filler Strip│ │   - FIFO 500-Record Cap       │
       │   - Duplicate Detection      │ └──────────────┬────────────────┘
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
│   ├── tokenizer.js         # Heuristic token counting
│   ├── calculator.js        # Environmental math: Electricity (Wh), Carbon (g CO₂), Water (mL)
│   ├── optimizer.js         # Rule-based NLP optimizer & scoring engine (0-100 score)
│   ├── recommendations.js   # Audits history to diagnose behavioral pitfalls & tips
│   ├── gamification.js      # Streak tracking, eco-badges, and weekly saving challenges
│   └── storage.js           # Chrome Local Storage wrapper with FIFO 500-item cap
├── tests/
│   └── optimizer.test.js    # Dependency-free optimizer regression suite (node tests/optimizer.test.js)
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
  - Simplifies wordy phrases (`in order to` → `to`, `due to the fact that` → `because`).
  - Removes duplicate adjacent words (`write write` → `write`).
- **Situational preamble removal (`condense.js`):** strips the circumstances around a request
  — exams and deadlines, time pressure, mood, excuses, who assigned the work, where the user saw it,
  academic year — so `hey I have an exam tomorrow teach me ML` becomes `Teach me ML`.
  Two guards keep it safe: a request must survive the removal, and the subject must survive with it,
  so `I have an exam tomorrow` alone and `...exam in AI, help me to study` are both left intact.
  Clauses that shape the answer (`I am a beginner`) are kept deliberately.
- **UI:** Overlays a clean card showing tokens saved, carbon saved, and an instant **Accept** button.
  The card is positioned against the live composer rectangle (measured via `ResizeObserver`), so it sits
  above the prompt box and shrinks/scrolls as the box grows instead of covering what you are typing.

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
| **Water Consumption** | $\text{Electricity (Wh)} \times 1.5\text{ mL}$ | $1.5\text{ L/kWh}$ (Data center cooling + power plant thermal cooling) |

### Environmental Equivalents
- **LED Lightbulb:** $\text{Total Electricity} / 10\text{W}$ hours.
- **Car Driving:** $\text{Total Carbon} \times 8.3\text{ meters}$.
- **Water Sips:** $\text{Total Water} / 10\text{ mL}$.

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
- Created `utils/calculator.js` to compute Wh, g CO₂, and mL water.
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
