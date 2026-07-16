// popup.js

document.addEventListener("DOMContentLoaded", () => {
    // 1. Open the dashboard tab on button click
    document.getElementById("open-dashboard-btn").addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") });
    });

    // 2. Fetch stats and render preview in the popup
    if (typeof PromptMeterStorage !== 'undefined') {
        PromptMeterStorage.getStats((stats) => {
            document.getElementById("popup-carbon").textContent = `${stats.totalCarbon.toFixed(1)}g`;
            document.getElementById("popup-efficiency").textContent = `${stats.avgEfficiency}%`;
            
            // Adjust efficiency color dynamically
            const effEl = document.getElementById("popup-efficiency");
            if (stats.avgEfficiency >= 90) {
                effEl.style.color = "#34d399"; // Green
            } else if (stats.avgEfficiency >= 70) {
                effEl.style.color = "#fbbf24"; // Amber
            } else {
                effEl.style.color = "#f87171"; // Red
            }
        });
    }
});