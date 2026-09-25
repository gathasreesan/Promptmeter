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
            statusText.textContent = isEnabled ? "Watching your prompts" : "Paused";
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

    // 4. Fetch stats and render preview in the popup
    if (typeof PromptMeterStorage !== 'undefined') {
        try {
            PromptMeterStorage.getStats((stats) => {
                const carbonEl = document.getElementById("popup-carbon");
                const effEl = document.getElementById("popup-efficiency");

                if (carbonEl) {
                    const carbonVal = isNaN(stats.totalCarbon) ? 0 : stats.totalCarbon;
                    carbonEl.textContent = `${carbonVal.toFixed(1)}g`;
                }

                if (effEl) {
                    const effVal = isNaN(stats.avgEfficiency) ? 100 : stats.avgEfficiency;
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