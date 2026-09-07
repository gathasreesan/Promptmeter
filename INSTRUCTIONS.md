# 📋 PromptMeter: Quick Instructions & Activity Tracker

This document is your **quick guide** to keep track of how to run the project, how each feature works, and the chronological log of what was built at each stage.

---

## ⚡ Quick How-To (Cheat Sheet)

### 1. Rebuild Dashboard (When you modify `dashboard/src/`)
```bash
cd dashboard
npm run build
```

### 2. Load / Refresh Extension in Chrome
1. Open `chrome://extensions` in Google Chrome.
2. Toggle on **Developer mode** (top right).
3. If not loaded yet: Click **Load unpacked** $\rightarrow$ choose `Promptmeter` folder.
4. If already loaded: Click the 🔄 **Reload icon** on the PromptMeter card whenever you edit extension files (`content.js`, `manifest.json`, `utils/*`).
5. Refresh your active ChatGPT tab (`Ctrl + F5`).

### 3. Using PromptMeter on ChatGPT
1. Open [ChatGPT](https://chatgpt.com).
2. Type your message in the chat box.
3. If your message contains wordy greetings or conversational filler, the **PromptMeter Optimization Card** appears with estimated token and CO₂ savings.
4. Click **Accept Optimization** to replace the text with the optimized version, or click **Ignore** to keep your original prompt.
5. Hit Enter to send. Once ChatGPT finishes streaming its response, PromptMeter automatically saves the token counts and environmental impact to local storage.

### 4. Turn PromptMeter ON or OFF
- Click the **PromptMeter Extension icon** in Chrome.
- Use the **toggle switch** in the top-right of the popup:
  - 🟢 **Active:** Full real-time coaching, optimization cards, and footprint tracking.
  - ⚪ **Paused:** PromptMeter stops analyzing prompts, hides in-page cards, and stops saving turn history on ChatGPT without needing to uninstall.

### 5. Viewing Analytics & Dashboard
- Click the **PromptMeter Extension icon** in Chrome for a quick stats overview.
- Click **"Open Dashboard"** to launch the full-page dashboard with 3 tabs:
  - **Overview:** Charts, carbon & token KPIs, coaching streak, weekly challenges.
  - **Queries Log:** History of all prompts, attachments, responses, and token scores, with options to delete individual log entries (🗑️) or clear all query logs.
  - **Advisor Insights:** Health score ring, recommendations, and badge unlock grid.

---

## 🔍 What Happens Each Time (System Workflow)

| Step | Action | What Happens Under the Hood | Relevant File(s) |
| :--- | :--- | :--- | :--- |
| **1** | **User Types Prompt** | Input event triggers debounced analysis (750ms). Regex rules identify filler phrases, greetings, and wordiness. | [`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js#L68-L82), [`optimizer.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/optimizer.js) |
| **2** | **Suggestion Appears** | In-page card shows diff comparison, token savings, and carbon savings calculated via BPE tokenizer. | [`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js#L93-L132), [`content.css`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.css) |
| **3** | **Attachment Parsing** | Attached images (+170 tokens), docs ($0.25\text{ tokens/byte}$), and web URLs (+2000 tokens) are tracked. | [`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js#L28-L66) |
| **4** | **Prompt Submitted** | User sends message to ChatGPT. `MutationObserver` watches ChatGPT's response container. | [`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js#L344-L400) |
| **5** | **Response Completes** | Once streaming finishes, 800ms debounce captures full markdown, pairs prompt and response, and counts tokens. | [`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js#L270-L341), [`tokenizer.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/tokenizer.js) |
| **6** | **Footprint Calculated** | Calculates electricity ($\text{Wh}$), carbon ($\text{g CO}_2$), and water ($\text{mL}$) based on total tokens. | [`calculator.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/calculator.js) |
| **7** | **Turn Saved** | Turn record is saved to `chrome.storage.local` with rolling 500-record FIFO cap. | [`storage.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/storage.js) |
| **8** | **Dashboard Updates** | Gamification engine checks streak and badges. Chart.js aggregates data by day/week/month. | [`gamification.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/gamification.js), [`App.jsx`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/dashboard/src/App.jsx) |

---

## 📅 Timeline: What Happened Each Time (Build Log)

```
[Phase 1: Foundation]
  ├── Manifest V3 configured for chatgpt.com & chat.openai.com
  ├── Local storage permissions & content script chain established
  └── Popup HTML & CSS created for fast stats view

[Phase 2: Core Math & NLP Engines]
  ├── utils/calculator.js: Research-backed environmental formulas
  ├── utils/tokenizer.js: Tiktoken BPE + heuristic token counter
  └── utils/optimizer.js: Grammar correction, typo/slang fixer, rule-based scoring & prompt rewriter

[Phase 3: ChatGPT In-Page Integration]
  ├── MutationObserver for streaming lifecycle & message capture
  ├── Attachment detection (Images, PDFs, Docs, URLs)
  └── Live in-page optimization card overlay with diff preview

[Phase 4: Gamification & Insights]
  ├── utils/gamification.js: 6 Badges, Streaks, and Weekly Challenge
  └── utils/recommendations.js: Automated diagnostic coaching

[Phase 5: React Analytics Dashboard]
  ├── React 18 + Chart.js setup with esbuild bundler
  ├── Overview Tab (KPIs, time-series bar/line chart, streak card)
  ├── Queries Log Tab (searchable & filterable history table)
  └── Advisor Insights Tab (health gauge, warnings, badge matrix)

[Phase 6: Extension Controls & On/Off Toggle]
  ├── popup.html & style.css: Modern toggle slider & live status banner
  ├── popup.js: Persistent chrome.storage.local isEnabled state
  └── content.js: Live storage listener to pause/resume monitoring seamlessly
```

---

## 🛠️ Key File Reference

- **[`manifest.json`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/manifest.json)**: Extension configuration and permissions.
- **[`content.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.js)**: ChatGPT DOM listener, prompt optimizer overlay, and capture engine.
- **[`content.css`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/content.css)**: Styles for the in-page optimization overlay card.
- **[`popup.html`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/popup.html)** & **[`popup.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/popup.js)**: Chrome toolbar popup window.
- **[`utils/calculator.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/calculator.js)**: Electricity, carbon, and water math equations.
- **[`utils/optimizer.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/optimizer.js)**: NLP rule engine and prompt rewriter.
- **[`utils/tokenizer.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/tokenizer.js)**: Token estimation wrapper.
- **[`utils/storage.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/storage.js)**: Chrome storage adapter with FIFO management.
- **[`utils/gamification.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/gamification.js)**: Badges, milestones, and streak calculation.
- **[`utils/recommendations.js`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/utils/recommendations.js)**: Automated prompt audit coach.
- **[`dashboard/src/App.jsx`](file:///c:/Users/gatha/OneDrive/Documents/Promptmeter/dashboard/src/App.jsx)**: Full React dashboard application.
