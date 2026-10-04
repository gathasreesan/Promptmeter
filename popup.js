// popup.js

document.addEventListener("DOMContentLoaded", () => {
    // Follow the theme chosen on the dashboard, and update live if it changes
    if (typeof PromptMeterTheme !== 'undefined') {
        PromptMeterTheme.start();
    }

    const toggle = document.getElementById("toggle-promptmeter");
    const statusBadge = document.getElementById("popup-status-badge");
    const statusBanner = document.getElementById("status-banner");
    const statusText = document.getElementById("status-text");

    // 1. Open the dashboard tab on button click
    document.getElementById("open-dashboard-btn").addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") });
    });

    // Helper to update toggle UI elements
    function updateToggleUI(isEnabled) {
        if (toggle) toggle.checked = isEnabled;
        if (statusBadge) {
            statusBadge.textContent = isEnabled ? "Active" : "Paused";
            statusBadge.className = isEnabled ? "badge" : "badge disabled";
        }
        if (statusBanner) {
            statusBanner.className = isEnabled ? "status-banner" : "status-banner disabled";
        }
        if (statusText) {
            statusText.textContent = isEnabled ? "Active on ChatGPT" : "Paused";
        }
    }

    // 2. Fetch current enabled state from storage (default: true)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ isEnabled: true }, (result) => {
            const isEnabled = result.isEnabled !== false;
            updateToggleUI(isEnabled);
        });

        // 3. Listen for toggle switch changes
        if (toggle) {
            toggle.addEventListener("change", (e) => {
                const isEnabled = e.target.checked;
                chrome.storage.local.set({ isEnabled: isEnabled }, () => {
                    updateToggleUI(isEnabled);
                });
            });
        }
    }

    // 3b. Edit level. Saved to storage; open ChatGPT tabs re-run their card live.
    const HINTS = { fixes: 'Spelling and grammar only. Nothing is removed.',
        trim: 'Also remove greetings and filler',
        condense: 'Also shorten wordy phrasing' };
    const levelButtons = document.querySelectorAll('[data-level]');
    const showLevel = (value) => {
        levelButtons.forEach(button =>
            button.setAttribute('aria-checked', String(button.dataset.level === value)));
        const hint = document.getElementById('level-hint');
        if (hint) hint.textContent = HINTS[value] || HINTS.trim;
    };
    if (typeof PromptMeterStorage !== 'undefined') {
        PromptMeterStorage.getSettings({ strictness: 'trim' }, (res) => showLevel(res.strictness));
        levelButtons.forEach(button => button.addEventListener('click', () => {
            showLevel(button.dataset.level);
            PromptMeterStorage.setSetting('strictness', button.dataset.level);
        }));
    }

    // 4. Fetch stats and render preview in the popup
    if (typeof PromptMeterStorage !== 'undefined') {
        try {
            PromptMeterStorage.getHistory((history) => {
                const stats = PromptMeterStorage.aggregate(history);
                const effEl = document.getElementById("popup-efficiency");
                const set = (id, text) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = text;
                };

                // What the extension did, rather than the lifetime cost of using ChatGPT
                // at all -- the old headline was a number PromptMeter only ever raises.
                set("popup-saved", (stats.totalTokensSaved || 0).toLocaleString());
                const saved = Number(stats.totalCarbonSaved) || 0;
                // Savings are fractions of a gram; below a milligram "0mg" says less
                // than saying so.
                set("popup-carbon", saved <= 0 ? "no CO₂ saved yet"
                    : saved < 0.001 ? "under 1 mg CO₂ avoided"
                        : saved < 1 ? `${Math.round(saved * 1000)} mg CO₂ avoided`
                            : `${saved.toFixed(1)} g CO₂ avoided`);
                set("popup-improved", history.filter(turn => turn.wasOptimized).length.toLocaleString());
                set("popup-logged", `of ${history.length.toLocaleString()}`);
                if (typeof PromptMeterGamification !== 'undefined') {
                    const streak = PromptMeterGamification.calculateStreak(history);
                    set("popup-streak", `${streak}d`);
                }
                const empty = document.getElementById("popup-empty");
                if (empty) empty.hidden = history.length > 0;

                if (effEl) {
                    // No history aggregates to 0, which showed a new user a red "0%".
                    // The dashboard treats an empty history as 100; so does this.
                    const effVal = !stats.totalQueries || isNaN(stats.avgEfficiency) ? 100 : stats.avgEfficiency;
                    effEl.textContent = `${effVal}%`;

                    // A class, not an inline hex. The three literals that used to be
                    // written here were the light-theme greens and reds, set straight
                    // onto style.color, which wins over any stylesheet -- so in dark
                    // mode the number kept a colour picked for a white card and the
                    // contrast went with it. The stylesheet resolves these against the
                    // active theme instead.
                    effEl.className = "stat-value " + (
                        effVal >= 90 ? "stat-good" : effVal >= 70 ? "stat-fair" : "stat-poor"
                    );
                }
            });
        } catch (err) {
            console.warn("PromptMeter [Popup]: Stats fetch failed.", err);
        }
    }
});