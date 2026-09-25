console.log("[PromptMeter] active on ChatGPT");

// Each util is loaded as its own content script, so one of them failing to parse leaves
// the others running and the failure is easy to miss. Report what actually arrived.
(function reportModules() {
    const required = {
        Theme: typeof PromptMeterTheme,
        Protect: typeof PromptMeterProtect,
        Condense: typeof PromptMeterCondense,
        Tokenizer: typeof PromptMeterTokenizer,
        Calculator: typeof PromptMeterCalculator,
        Storage: typeof PromptMeterStorage,
        Optimizer: typeof PromptMeterOptimizer
    };
    const missing = Object.keys(required).filter(name => required[name] === 'undefined');
    if (missing.length > 0) {
        console.error(`[PromptMeter] these modules failed to load: ${missing.join(', ')}. ` +
            `Check chrome://extensions for a script error.`);
    }
})();

/**
 * ChatGPT ships DOM changes frequently, so every selector the extension depends on lives
 * here rather than being repeated at each call site. Lists are tried in order.
 */
const SELECTORS = {
    promptBox: [
        '#prompt-textarea',
        '.ProseMirror',
        'div[contenteditable="true"]',
        'textarea[placeholder*="Message"]',
        'textarea[data-id]',
        'textarea'
    ],
    // Containers wrapping a single conversation turn
    turn: [
        'article',
        '[data-testid^="conversation-turn-"]',
        '.conversation-turn',
        '.chat-turn',
        '[data-role="turn"]'
    ],
    turnFallback: '.w-full.group',
    // Elements that are themselves an assistant message
    assistantMessage: [
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '.assistant-turn'
    ],
    // Anything inside a turn that identifies it as assistant-authored
    assistantMarkers: [
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '.result-streaming',
        'button[aria-label="Read aloud"]'
    ],
    // A response still being generated
    streaming: [
        '.result-streaming',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Stop response"]',
        'button[aria-label*="Stop"]',
        'button[data-testid="stop-button"]'
    ],
    sendButton: [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]'
    ]
};

// A "Copy" button only appears once a turn has finished rendering, so it identifies a
// completed assistant turn but is not reliable while streaming.
const COMPLETED_ASSISTANT_MARKERS = SELECTORS.assistantMarkers.concat('button[aria-label="Copy"]');

const hasChromeStorage = () =>
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

// Returns the first element matching any selector in the list, or null
function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
        const el = root.querySelector(selector);
        if (el) return el;
    }
    return null;
}

// True if any selector in the list matches inside the given root
function matchesAny(root, selectors) {
    return selectors.some(selector => root.querySelector(selector) !== null);
}

// Colour theme for the injected card. Applied to the card element rather than the
// page root so the extension never touches ChatGPT's own theming.
let themeMode = 'auto';

function applyCardTheme() {
    const card = document.getElementById("promptmeter-opt-card");
    if (card && typeof PromptMeterTheme !== 'undefined') {
        PromptMeterTheme.apply(themeMode, card);
    }
}

if (typeof PromptMeterTheme !== 'undefined') {
    themeMode = PromptMeterTheme.readSync();
    PromptMeterTheme.read((mode) => {
        themeMode = mode;
        applyCardTheme();
    });
}

// Global enabled state (controlled by the popup on/off switch)
let isPromptMeterEnabled = true;

if (hasChromeStorage()) {
    chrome.storage.local.get({ isEnabled: true }, (res) => {
        isPromptMeterEnabled = res.isEnabled !== false;
    });

    // React to popup/dashboard changes without needing a page reload
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.theme !== undefined && typeof PromptMeterTheme !== 'undefined') {
            themeMode = PromptMeterTheme.normalize(changes.theme.newValue);
            applyCardTheme();
        }

        if (changes.isEnabled === undefined) return;
        isPromptMeterEnabled = changes.isEnabled.newValue !== false;
        if (!isPromptMeterEnabled) hideOptimizationCard();
        console.log(`[PromptMeter] ${isPromptMeterEnabled ? 'active' : 'paused'}`);
    });
}

// State for capturing turns
let isStreaming = false;
let captureLockTimeout = null;
const loggedPromptSet = new Set(); // Prompt-response pairs already saved, to prevent duplicates

// State for typing suggestions
let debounceTimer = null;
let ignoredPromptText = "";
let wasOptimized = false;
let lastSavedTokens = 0;
let lastSavedCarbon = 0;
// The prompt as the user wrote it, before Accept replaced it. Kept so the dashboard can
// show what the optimization actually changed rather than only how much it saved.
let lastOriginalPrompt = "";

// State for attachments
// Tokens this page's conversation has used, as far as the extension can see. Only turns
// captured since the script loaded are counted, so a reloaded page starts from zero and
// the figure is a floor, never a measurement -- see utils/headroom.js for what it cannot
// observe at all.
let conversationTokens = 0;

let activeAttachments = { images: [], documents: [] };
let lastNonEmptyAttachments = { images: [], documents: [] };

// Locates the ChatGPT prompt input across DOM versions
function getPromptBox() {
    return queryFirst(SELECTORS.promptBox);
}

// Reads an input's text, whether it is a textarea or a contenteditable div
function readText(el) {
    if (!el) return "";
    return (el.value || el.textContent || "").trim();
}

// Detects uploaded files, image previews, and file bubbles in the chat input area
function detectAttachments() {
    const images = [];
    const documents = [];

    // Preview images in the input area
    document.querySelectorAll('#prompt-textarea img, [class*="attachment"] img, [class*="file-pill"] img')
        .forEach(img => images.push({ name: img.alt || "Image Attachment", type: "image" }));

    // File bubbles / upload pills
    document.querySelectorAll('[data-testid="file-pill"], [class*="file-pill"], [class*="attachment-pill"]')
        .forEach(file => {
            const text = file.innerText || file.textContent || "";
            const name = text.split('\n')[0];
            const isImage = /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(text) || file.querySelector('img') !== null;

            if (isImage) {
                const imageName = name || "Image";
                if (!images.some(img => img.name === imageName)) {
                    images.push({ name: imageName, type: "image" });
                }
                return;
            }

            documents.push({
                name: name || "Document",
                type: "document",
                tokens: estimateDocumentTokens(text)
            });
        });

    return { images, documents };
}

// Estimates a document's context cost from the file size shown on its pill
function estimateDocumentTokens(pillText) {
    const sizeMatch = pillText.match(/(\d+(?:\.\d+)?)\s*(KB|MB|bytes)/i);
    if (!sizeMatch) return 2000; // Default document context cost

    const unit = sizeMatch[2].toUpperCase();
    const scale = unit === 'MB' ? 1024 * 1024 : unit === 'KB' ? 1024 : 1;
    return Math.round(parseFloat(sizeMatch[1]) * scale * 0.25);
}

// 1. Monitor active typing inside the prompt box
function handleInput(e) {
    if (!isPromptMeterEnabled) {
        hideOptimizationCard();
        return;
    }

    clearTimeout(debounceTimer);

    // 450ms debounce. The text is read inside the callback so it is always the latest value.
    debounceTimer = setTimeout(() => {
        const promptBox = getPromptBox();
        const currentText = promptBox ? readText(promptBox) : readText(e && e.target);
        if (currentText.length < 5) {
            hideOptimizationCard();
            return;
        }

        // Detect attachments only once the user pauses typing
        const detected = detectAttachments();
        if (detected.images.length > 0 || detected.documents.length > 0) {
            activeAttachments = detected;
            lastNonEmptyAttachments = detected;
        }

        analyzeAndOfferOptimization(currentText);
    }, 450);
}

// 2. Hide the optimization card
function hideOptimizationCard() {
    const card = document.getElementById("promptmeter-opt-card");
    if (card) card.classList.remove("visible");
}

// 2a. Keep the card clear of the composer.
//
// A fixed offset from the bottom of the window cannot work: ChatGPT's input grows as
// the user types, and a long prompt pushes the top of the composer up under a card
// pinned at a constant height. So the composer is measured live and the card is placed
// directly above whatever it currently occupies, shrinking (and scrolling internally)
// rather than ever overlapping it.
const CARD_GAP = 12;         // Clearance between the card and the top of the composer
const CARD_MIN_HEIGHT = 140; // Below this the card is unreadable; it scrolls instead
const CARD_MAX_WIDTH = 580;
const CARD_EDGE = 8;         // Keeps the card off the viewport edges

let composerObserver = null;
let watchedComposer = null;

// The element that visually contains the prompt box, whose top edge the card sits above.
// The watched element is reused while it is still in the document, so a scroll does not
// re-run the selector list on every frame.
function getComposer() {
    if (watchedComposer && watchedComposer.isConnected) return watchedComposer;

    const promptBox = getPromptBox();
    if (!promptBox) return null;
    return promptBox.closest('form') || promptBox.parentElement;
}

function positionOptimizationCard(force) {
    const card = document.getElementById("promptmeter-opt-card");
    if (!card) return;
    if (!force && !card.classList.contains("visible")) return;

    const composer = getComposer();
    const rect = composer ? composer.getBoundingClientRect() : null;

    // Fall back to the stylesheet's centred position when the measurement is missing or
    // does not look like a composer. `.closest('form')` can return an element wrapping
    // most of the page on some ChatGPT builds; anchoring to that would strand the card
    // at the top of the window, which looks broken. A composer sits in the lower part
    // of the viewport and takes up a minority of its height.
    const plausible = rect &&
        rect.height > 0 &&
        rect.height < window.innerHeight * 0.7 &&
        rect.top > window.innerHeight * 0.25;

    if (!plausible) {
        card.classList.remove("promptmeter-anchored");
        card.style.left = card.style.width = card.style.bottom = card.style.maxHeight = "";
        return;
    }

    const width = Math.min(CARD_MAX_WIDTH, Math.max(280, rect.width));
    const left = Math.max(CARD_EDGE, Math.min(
        window.innerWidth - width - CARD_EDGE,
        rect.left + (rect.width - width) / 2
    ));

    // Sit on top of the composer, but never so high that the card leaves the viewport
    // on a short window -- there, overlapping is the lesser of the two failures.
    const clear = window.innerHeight - rect.top + CARD_GAP;
    const ceiling = Math.max(CARD_EDGE, window.innerHeight - CARD_MIN_HEIGHT - CARD_EDGE);
    const bottom = Math.min(Math.max(CARD_EDGE, clear), ceiling);

    card.style.left = `${Math.round(left)}px`;
    card.style.width = `${Math.round(width)}px`;
    card.style.bottom = `${Math.round(bottom)}px`;
    card.style.maxHeight = `${Math.round(window.innerHeight - bottom - CARD_EDGE)}px`;
    card.classList.add("promptmeter-anchored");
}

// Measuring forces a layout, so repositioning is coalesced to one per frame. Scroll
// events on ChatGPT's message list arrive far faster than that.
let positionFrame = null;

function schedulePositionUpdate() {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => {
        positionFrame = null;
        positionOptimizationCard();
    });
}

// Re-measure whenever the composer changes size, which is what typing a long prompt does
function watchComposer() {
    if (typeof ResizeObserver === 'undefined') return;

    const promptBox = getPromptBox();
    const composer = promptBox
        ? (promptBox.closest('form') || promptBox.parentElement)
        : null;
    if (!composer || composer === watchedComposer) return;

    if (composerObserver) composerObserver.disconnect();
    composerObserver = new ResizeObserver(schedulePositionUpdate);
    composerObserver.observe(composer);
    watchedComposer = composer;
}

window.addEventListener("resize", schedulePositionUpdate);
window.addEventListener("scroll", schedulePositionUpdate, true);

// 3. Create and show the optimization overlay
function showOptimizationCard(originalText, optimizedText, tokensSaved, carbonSaved, grammarIssues, scopeIssues, tokenStats, headroom) {
    let card = document.getElementById("promptmeter-opt-card");
    if (!card) {
        card = document.createElement("div");
        card.id = "promptmeter-opt-card";
        // pm-tokens carries every colour and radius from utils/tokens.css. It sits on
        // the card rather than on :root so the host page keeps its own variables.
        card.className = "promptmeter-opt-card pm-tokens";
        document.body.appendChild(card);
        applyCardTheme();
    }

    // stats() is the source for the counts. A caller that does not supply it (an older
    // call site, a test) still gets a card rather than a crash -- but it gets no token
    // figures at all, rather than "0 -> 0 tokens, -0%", which is not a smaller claim
    // than the truth, it is a different and wrong one.
    const stats = tokenStats || null;

    // "~" marks a count that came from the heuristic rather than a real BPE encoder.
    // PromptMeterTokenizer.isExact() exists precisely so this can be said out loud:
    // a carbon figure derived from a guess must not be dressed up as a measurement.
    const approx = stats && stats.exact ? '' : '~';
    const countNote = stats && stats.exact
        ? `Counted with ${stats.encoding}`
        : 'Estimated -- no exact tokenizer is loaded';

    // The carbon figure is always an estimate, and an older call site may not pass one.
    const carbon = typeof carbonSaved === 'number' && isFinite(carbonSaved)
        ? carbonSaved : null;

    const issues = grammarIssues || [];
    // De-duplicated, because one rule can fire on several spans of the same prompt and
    // the card is a summary rather than a list of every edit.
    const issueLabels = [];
    issues.forEach(issue => {
        if (issueLabels.indexOf(issue.label) === -1) issueLabels.push(issue.label);
    });
    const shownIssues = issueLabels.slice(0, 4);
    const hiddenCount = issueLabels.length - shownIssues.length;

    card.innerHTML = `
        <div class="promptmeter-opt-header">
            <div class="promptmeter-opt-title">PromptMeter</div>
            <div class="promptmeter-opt-metrics">
                ${stats ? `
                <span class="promptmeter-metric promptmeter-metric-count" title="${countNote}">
                    <span class="promptmeter-count-from">${approx}${stats.originalTokens}</span>
                    <span class="promptmeter-count-arrow" aria-hidden="true">→</span>
                    <span class="promptmeter-count-to">${approx}${stats.optimizedTokens}</span>
                    <span class="promptmeter-count-unit">tokens</span>
                </span>
                <span class="promptmeter-metric promptmeter-metric-saved">−${stats.percent}%</span>` : ''}
                ${carbon !== null
                    ? `<span class="promptmeter-metric" title="Estimated">~${carbon.toFixed(3)} g CO₂</span>`
                    : ''}
                ${issueLabels.length > 0
                    ? `<span class="promptmeter-metric promptmeter-metric-grammar">${issueLabels.length} fixed</span>`
                    : ''}
            </div>
        </div>
        <div class="promptmeter-opt-diff">
            <div class="promptmeter-diff-box promptmeter-diff-original"></div>
            <div class="promptmeter-diff-box promptmeter-diff-optimized"></div>
        </div>
        <div class="promptmeter-opt-headroom" hidden></div>
        <div class="promptmeter-opt-scope" hidden>
            <div class="promptmeter-scope-title">${(scopeIssues || []).some(f => f.type === 'complexity') ? 'Worth reconsidering' : 'Worth splitting up'}</div>
            <ul class="promptmeter-scope-list"></ul>
        </div>
        <div class="promptmeter-opt-grammar" hidden>
            <div class="promptmeter-grammar-title">Also corrected</div>
            <ul class="promptmeter-grammar-list"></ul>
        </div>
        <div class="promptmeter-opt-actions">
            <button id="promptmeter-btn-ignore" class="promptmeter-opt-btn promptmeter-btn-ignore">Ignore</button>
            <button id="promptmeter-btn-accept" class="promptmeter-opt-btn promptmeter-btn-accept">Apply</button>
        </div>
    `;

    // The prompt goes in as text, not markup. It is the user's own writing, so a stray
    // "<" would otherwise be parsed as a tag and silently swallow the rest of the
    // preview -- and anything pasted in from elsewhere would be parsed as markup too.
    card.querySelector('.promptmeter-diff-original').textContent = originalText;
    card.querySelector('.promptmeter-diff-optimized').textContent = optimizedText;

    // Headroom. Only rendered when a report exists, and always worded as an estimate:
    // the extension cannot see the system prompt, attachments or server-side truncation,
    // so the true usage is always higher by an unknown margin.
    if (headroom) {
        const row = card.querySelector('.promptmeter-opt-headroom');
        row.textContent = `Context: about ${headroom.percentUsed}% used, `
            + `~${headroom.remaining.toLocaleString()} tokens left of ${headroom.contextLimit.toLocaleString()}`
            + (headroom.message ? ` · ${headroom.message}` : '');
        row.className = 'promptmeter-opt-headroom promptmeter-headroom-' + headroom.level;
        row.hidden = false;
    }

    // Scope advice. Deliberately separate from the grammar panel: those are edits already
    // applied to the preview, whereas this is a judgement the user has to act on, because
    // only they can decide which parts of an over-large request to drop.
    const scope = scopeIssues || [];
    if (scope.length > 0) {
        const panel = card.querySelector('.promptmeter-opt-scope');
        const list = card.querySelector('.promptmeter-scope-list');
        scope.slice(0, 3).forEach(finding => {
            const item = document.createElement('li');
            item.textContent = finding.label;
            list.appendChild(item);
        });
        panel.hidden = false;
    }

    if (shownIssues.length > 0) {
        const panel = card.querySelector('.promptmeter-opt-grammar');
        const list = card.querySelector('.promptmeter-grammar-list');
        shownIssues.forEach(label => {
            const item = document.createElement('li');
            item.textContent = label;
            list.appendChild(item);
        });
        if (hiddenCount > 0) {
            const more = document.createElement('li');
            more.className = 'promptmeter-grammar-more';
            more.textContent = `and ${hiddenCount} more`;
            list.appendChild(more);
        }
        panel.hidden = false;
    }

    // Scoped to the card, not getElementById. These ids live in somebody else's
    // document: if the host page ever ships an element called promptmeter-btn-accept,
    // a global lookup binds the handler to theirs and the button silently stops working.
    card.querySelector("#promptmeter-btn-accept").onclick = () => applyOptimization(optimizedText);
    card.querySelector("#promptmeter-btn-ignore").onclick = () => {
        ignoredPromptText = originalText;
        hideOptimizationCard();
    };

    // Place it before it fades in, so it never appears over the composer first.
    // Positioning is a convenience: if measuring the page fails for any reason the
    // card must still be shown, at the stylesheet's default position.
    try {
        positionOptimizationCard(true);
        watchComposer();
    } catch (err) {
        console.warn("PromptMeter: could not anchor the card to the composer.", err);
        card.classList.remove("promptmeter-anchored");
        card.style.left = card.style.width = card.style.bottom = card.style.maxHeight = "";
    }

    card.classList.add("visible");
}

// 4. Analyze the text currently being typed and offer a rewrite
function analyzeAndOfferOptimization(text) {
    if (!isPromptMeterEnabled || text === ignoredPromptText) return;

    // This runs inside a debounce timer, where a throw is swallowed by the event loop
    // and the card simply never appears. Surface it instead.
    let optimized;
    let grammarIssues = [];
    let scopeIssues = [];
    try {
        const report = PromptMeterOptimizer.optimizeWithReport(text);
        optimized = report.text;
        grammarIssues = report.grammar;
        scopeIssues = report.scope;
    } catch (err) {
        console.error("[PromptMeter] optimizePrompt failed for this text.", err, text);
        hideOptimizationCard();
        return;
    }

    if (!optimized || optimized.trim() === text.trim()) {
        hideOptimizationCard();
        return;
    }

    // One call gives before, after, saved, percent, and whether the counts came from a
    // real encoder or the estimate -- the card labels the two differently.
    const tokenStats = PromptMeterTokenizer.stats(text, optimized);
    const tokensSaved = tokenStats.saved;

    // Headroom only once there is something to base it on. With no turns captured yet
    // the only honest report is none at all.
    const headroom = (typeof PromptMeterHeadroom !== 'undefined' && conversationTokens > 0)
        ? PromptMeterHeadroom.report(conversationTokens, tokenStats.optimizedTokens)
        : null;

    // Only interrupt for a worthwhile change: 2+ tokens saved, a 5% character
    // reduction, or a grammatical error found. Grammar earns an interruption on its own
    // because correcting it rarely saves a token -- "he go" becomes "he goes", which is
    // longer -- yet an agreement or tense error is exactly the kind of thing that makes
    // the model answer the wrong question and cost a whole extra turn.
    const charSavingsPct = ((text.length - optimized.length) / text.length) * 100;
    if (tokensSaved < 2 && charSavingsPct < 5.0 && grammarIssues.length === 0 &&
        scopeIssues.length === 0) {
        hideOptimizationCard();
        return;
    }

    showOptimizationCard(text, optimized, tokensSaved,
        PromptMeterCalculator.savings(tokensSaved).carbon, grammarIssues, scopeIssues,
        tokenStats, headroom);
}

// 5. Apply the optimized prompt text directly into ChatGPT's input area
function applyOptimization(optimizedText) {
    const promptBox = getPromptBox();
    if (!promptBox) {
        hideOptimizationCard();
        return;
    }

    // textContent is used rather than innerText: it reads the same value without
    // forcing a layout reflow.
    const originalText = promptBox.value || promptBox.textContent || "";
    const tokensSaved = Math.max(
        0,
        PromptMeterTokenizer.countTokens(originalText) - PromptMeterTokenizer.countTokens(optimizedText)
    );

    if (tokensSaved > 0) {
        wasOptimized = true;
        lastSavedTokens = tokensSaved;
        lastSavedCarbon = PromptMeterCalculator.savings(tokensSaved).carbon;
        lastOriginalPrompt = originalText.trim();
    }

    // Don't re-evaluate the text that was just applied
    ignoredPromptText = optimizedText;
    promptBox.focus();
    writeToPromptBox(promptBox, optimizedText);

    // Dispatch synthetic events so React and ProseMirror update their internal state
    try {
        promptBox.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: optimizedText
        }));
    } catch (e) { /* InputEvent unsupported; the plain events below still fire */ }
    promptBox.dispatchEvent(new Event('input', { bubbles: true }));
    promptBox.dispatchEvent(new Event('change', { bubbles: true }));

    // Re-enable ChatGPT's Send button once its own state refresh has settled
    setTimeout(() => {
        const sendBtn = queryFirst(SELECTORS.sendButton) ||
            (promptBox.closest('form') && promptBox.closest('form').querySelector('button[type="submit"]'));
        if (sendBtn) {
            sendBtn.removeAttribute('disabled');
            sendBtn.disabled = false;
        }
    }, 50);

    hideOptimizationCard();
}

// Writes text into either a native input or a contenteditable editor
function writeToPromptBox(promptBox, text) {
    if (promptBox.tagName === 'TEXTAREA' || promptBox.tagName === 'INPUT') {
        // React tracks the value via the native setter, so bypassing it is ignored
        const nativeSetter =
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
            nativeSetter.call(promptBox, text);
        } else {
            promptBox.value = text;
        }
        return;
    }

    // Contenteditable div (modern ChatGPT ProseMirror / Lexical)
    try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(promptBox);
        selection.removeAllRanges();
        selection.addRange(range);

        if (!document.execCommand('insertText', false, text)) {
            promptBox.textContent = text;
        }
    } catch (e) {
        promptBox.textContent = text;
    }
}

// --- Turn / message container helpers ---

function getAllTurnContainers() {
    const list = document.querySelectorAll(SELECTORS.turn.join(', '));
    return Array.from(list.length > 0 ? list : document.querySelectorAll(SELECTORS.turnFallback));
}

// Selectors are tried one at a time rather than as one combined selector: `closest`
// returns the nearest matching ancestor, so combining them would let an inner fallback
// container win over the outer, more specific turn element.
function getTurnContainer(element) {
    if (!element) return null;
    for (const selector of SELECTORS.turn.concat(SELECTORS.turnFallback)) {
        const match = element.closest(selector);
        if (match) return match;
    }
    return null;
}

// True if a turn container holds an assistant message rather than a user one
function isAssistantTurn(turn) {
    return matchesAny(turn, SELECTORS.assistantMarkers);
}

function getAssistantMessages() {
    const direct = document.querySelectorAll(SELECTORS.assistantMessage.join(', '));
    if (direct.length > 0) return Array.from(direct);

    return getAllTurnContainers().filter(turn => matchesAny(turn, COMPLETED_ASSISTANT_MARKERS));
}

// Returns the text of the first non-empty user turn in the list, or null
function firstUserTurnText(turns) {
    for (const turn of turns) {
        if (isAssistantTurn(turn)) continue;
        if ((turn.textContent || "").trim().length === 0) continue;

        const userMsg = turn.querySelector('[data-message-author-role="user"]') || turn;
        return userMsg.textContent || "";
    }
    return null;
}

// 6. Find the prompt that produced a given assistant response
function findPrecedingUserPrompt(assistantElement) {
    const parentTurn = getTurnContainer(assistantElement);

    // Preferred path: walk back through the sibling turns
    if (parentTurn) {
        const siblings = [];
        for (let prev = parentTurn.previousElementSibling; prev; prev = prev.previousElementSibling) {
            siblings.push(prev);
        }
        const found = firstUserTurnText(siblings);
        if (found !== null) return found;
    }

    // Fallback: the turns may not be siblings, so scan the flat list backwards
    const allTurns = getAllTurnContainers();
    const index = allTurns.indexOf(parentTurn);
    if (index > 0) {
        return firstUserTurnText(allTurns.slice(0, index).reverse()) || "";
    }

    return "";
}

// 7. Save a captured prompt / response pair
function handleResponseCaptured(prompt, response) {
    if (!isPromptMeterEnabled) return;

    const cleanPrompt = prompt.trim();
    const cleanResponse = response.trim();
    if (!cleanPrompt || !cleanResponse) return;

    // Prevents the same turn being saved repeatedly as the DOM settles
    const dedupeKey = `${cleanPrompt.slice(0, 100)}_${cleanResponse.slice(0, 100)}`;
    if (loggedPromptSet.has(dedupeKey)) return;
    loggedPromptSet.add(dedupeKey);

    const links = cleanPrompt.match(/https?:\/\/[^\s]+/g) || [];

    // Attachments may have been cleared by the time the response lands, so fall back
    // to the last non-empty set seen while typing.
    const hasActive = activeAttachments.images.length > 0 || activeAttachments.documents.length > 0;
    const { images, documents } = hasActive ? activeAttachments : lastNonEmptyAttachments;

    // Links, images and documents all expand the context the model actually processes
    const promptTokens = PromptMeterTokenizer.countTokens(cleanPrompt) +
        links.length * 2000 +
        images.length * 170 +
        documents.reduce((sum, doc) => sum + (doc.tokens || 2000), 0);
    const responseTokens = PromptMeterTokenizer.countTokens(cleanResponse);
    const totalTokens = promptTokens + responseTokens;

    conversationTokens += totalTokens;

    const footprint = PromptMeterCalculator.calculate(totalTokens);
    const attachmentCounts = {
        attachedImages: images.length,
        attachedDocs: documents.length,
        attachedLinks: links.length
    };

    activeAttachments = { images: [], documents: [] };
    lastNonEmptyAttachments = { images: [], documents: [] };

    PromptMeterStorage.getHistory((history) => {
        const analysis = PromptMeterOptimizer.analyzePrompt(cleanPrompt, history);

        const turnData = Object.assign({
            prompt: cleanPrompt,
            response: cleanResponse,
            promptTokens: promptTokens,
            responseTokens: responseTokens,
            totalTokens: totalTokens,
            electricity: footprint.electricity,
            carbon: footprint.carbon,
            efficiencyScore: analysis.score,
            wasOptimized: wasOptimized,
            tokensSaved: wasOptimized ? lastSavedTokens : 0,
            carbonSaved: wasOptimized ? lastSavedCarbon : 0,
            originalPrompt: wasOptimized ? lastOriginalPrompt : null,
            timestamp: new Date().toISOString()
        }, attachmentCounts);

        wasOptimized = false;
        lastSavedTokens = 0;
        lastSavedCarbon = 0;
        lastOriginalPrompt = "";

        PromptMeterStorage.saveTurn(turnData, () => {
            console.log(`[PromptMeter] turn saved, score ${analysis.score}%.`);
        });
    });
}

// 8. Bind typing listeners, re-running as ChatGPT swaps its input element
function bindInputListeners() {
    const promptBox = getPromptBox();
    if (!promptBox || promptBox.dataset.promptmeterBound) return;

    promptBox.dataset.promptmeterBound = "true";
    promptBox.addEventListener("input", handleInput);
    promptBox.addEventListener("paste", handleInput);

    // The composer element is new too, so the size watch has to follow it
    watchComposer();
}

bindInputListeners();

// 9. Watch the conversation for completed responses.
// Every DOM read is throttled to 400ms so a streaming response cannot lock the main thread.
function processDOMUpdates() {
    bindInputListeners();

    const assistantMessages = getAssistantMessages();
    if (assistantMessages.length === 0) return;

    const latest = assistantMessages[assistantMessages.length - 1];
    const isCurrentlyStreaming =
        latest.classList.contains('result-streaming') ||
        latest.querySelector('.result-streaming') !== null ||
        matchesAny(document, SELECTORS.streaming);

    const responseText = (latest.textContent || "").trim();

    if (isCurrentlyStreaming) {
        isStreaming = true;
        hideOptimizationCard();
        clearTimeout(captureLockTimeout);
        return;
    }

    if (isStreaming && responseText.length > 0) {
        // Wait 800ms after streaming stops so markdown and code blocks have finalized
        clearTimeout(captureLockTimeout);
        captureLockTimeout = setTimeout(() => {
            isStreaming = false;
            handleResponseCaptured(findPrecedingUserPrompt(latest), responseText);
        }, 800);
    }
}

let observerThrottleTimeout = null;

const observer = new MutationObserver(() => {
    if (observerThrottleTimeout) return;
    observerThrottleTimeout = setTimeout(() => {
        observerThrottleTimeout = null;
        processDOMUpdates();
    }, 400);
});

// childList only: watching attributes would thrash on ChatGPT's animated elements
observer.observe(document.body, { childList: true, subtree: true });
