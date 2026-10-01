// PromptMeter background worker.
//
// Chrome injects content scripts only into pages loaded AFTER the extension is. When the
// extension is installed, updated or reloaded, every ChatGPT tab already open keeps the
// old copy -- cut off from chrome.* and standing down -- or none at all, so the card
// never appeared until the user happened to refresh the tab. Inject the current copy
// into those tabs instead.

const manifest = chrome.runtime.getManifest();

async function injectIntoOpenTabs() {
    for (const script of manifest.content_scripts || []) {
        const tabs = await chrome.tabs.query({ url: script.matches });
        for (const tab of tabs) {
            if (tab.id === undefined || tab.discarded) continue;
            try {
                // Skip a tab that already runs this copy: content.js marks the page.
                const [probe] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => !!window.__promptMeterActive
                });
                if (probe && probe.result) continue;
                if (script.css && script.css.length) {
                    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: script.css });
                }
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: script.js });
            } catch (error) {
                // A tab that is loading, crashed or closed meanwhile: it gets the
                // manifest's injection on its next load anyway.
                console.warn('[PromptMeter] could not inject into tab', tab.id, error && error.message);
            }
        }
    }
}

chrome.runtime.onInstalled.addListener(() => { injectIntoOpenTabs(); });
