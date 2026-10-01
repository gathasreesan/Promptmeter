// PromptMeter background worker.
//
// Chrome injects content scripts only into pages loaded AFTER the extension is. When the
// extension is installed, updated or reloaded, every ChatGPT tab already open keeps the
// old copy -- cut off from chrome.* and standing down -- or none at all, so the card
// never appeared until the user happened to refresh the tab. Fix those tabs here.

const manifest = chrome.runtime.getManifest();

// Shown in a tab whose dead copy cannot be replaced in place (see below).
function showRefreshNotice() {
    if (document.getElementById('promptmeter-refresh-notice')) return;
    const bar = document.createElement('div');
    bar.id = 'promptmeter-refresh-notice';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;'
        + 'background:#1f2933;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 14px;'
        + 'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center';
    bar.textContent = 'PromptMeter was updated. Refresh this tab to keep using it.';
    const button = document.createElement('button');
    button.textContent = 'Refresh';
    button.style.cssText = 'background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit';
    button.onclick = () => location.reload();
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'background:none;color:#cbd5e1;border:0;font-size:18px;cursor:pointer';
    close.onclick = () => bar.remove();
    bar.append(button, close);
    document.body.appendChild(bar);
}

async function injectIntoOpenTabs() {
    for (const script of manifest.content_scripts || []) {
        const tabs = await chrome.tabs.query({ url: script.matches });
        for (const tab of tabs) {
            if (tab.id === undefined || tab.discarded) continue;
            const target = { tabId: tab.id };
            try {
                const [probe] = await chrome.scripting.executeScript({
                    target,
                    func: () => ({
                        present: !!window.__promptMeterActive,
                        live: typeof window.__promptMeterLive === 'function' && window.__promptMeterLive()
                    })
                });
                const state = (probe && probe.result) || {};
                if (state.live) continue;             // already running the current copy
                if (state.present) {
                    // A dead copy owns this page scope: its top-level declarations make
                    // a second copy fail to load, so it cannot be replaced in place.
                    // Ask for the one refresh that fixes it, instead of failing silently.
                    await chrome.scripting.executeScript({ target, func: showRefreshNotice });
                    continue;
                }
                if (script.css && script.css.length) {
                    await chrome.scripting.insertCSS({ target, files: script.css });
                }
                await chrome.scripting.executeScript({ target, files: script.js });
            } catch (error) {
                console.warn('[PromptMeter] could not prepare tab', tab.id, error && error.message);
                try { await chrome.scripting.executeScript({ target, func: showRefreshNotice }); } catch (e) { /* tab gone */ }
            }
        }
    }
}

chrome.runtime.onInstalled.addListener(() => { injectIntoOpenTabs(); });
