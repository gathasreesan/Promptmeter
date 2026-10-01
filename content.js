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
        // 2026 markup: no <article>, no author-role; each turn carries a search unit key.
        '[data-chatgpt-search-unit-key]',
        'article',
        '[data-testid^="conversation-turn-"]',
        '.conversation-turn',
        '.chat-turn',
        '[data-role="turn"]'
    ],
    turnFallback: '.w-full.group',
    // Elements that are themselves an assistant message
    assistantMessage: [
        '[data-chatgpt-search-unit-key$=":assistant"]',
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '.assistant-turn'
    ],
    // Anything inside a turn that identifies it as assistant-authored
    assistantMarkers: [
        '[data-chatgpt-search-unit-key$=":assistant"]',
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

// Also false once the extension was reloaded under this tab (context invalidated).
const hasChromeStorage = () => typeof PromptMeterStorage !== 'undefined'
    ? PromptMeterStorage.isAvailable()
    : typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

// Log an event to the extension's event log (dashboard -> Logs). Never throws: logging
// must not be able to break the thing it is watching.
function pmLog(kind, message, data, level) {
    try { if (typeof PromptMeterStorage !== 'undefined') PromptMeterStorage.log(kind, message, data, level); }
    catch (e) { /* the log is best-effort */ }
}

// Uncaught errors from PromptMeter's own files, not the host page's.
window.addEventListener('error', (event) => {
    if (!event.filename || event.filename.indexOf('chrome-extension://') !== 0) return;
    pmLog('uncaught', event.message, { file: event.filename.split('/').pop(), line: event.lineno }, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (!reason || !String(reason.stack || '').includes('chrome-extension://')) return;
    pmLog('unhandled-rejection', reason.message || String(reason), null, 'error');
});
// Flush the batched log when the tab is hidden or closed.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && typeof PromptMeterStorage !== 'undefined') PromptMeterStorage.flushLog();
});

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

// The host page's own theme. ChatGPT has a theme setting of its own and marks it on
// <html> (a "dark"/"light" class and color-scheme). "Auto" used to mean the OS
// setting, so a dark ChatGPT on a light OS got a glaring white card.
function hostTheme() {
    const root = document.documentElement;
    if (root.classList.contains('dark')) return 'dark';
    if (root.classList.contains('light')) return 'light';
    const scheme = getComputedStyle(root).colorScheme || '';
    if (/^dark\b/.test(scheme)) return 'dark';
    if (/^light\b/.test(scheme)) return 'light';
    return null;
}

function applyCardTheme() {
    const card = document.getElementById("promptmeter-opt-card");
    if (card && typeof PromptMeterTheme !== 'undefined') {
        PromptMeterTheme.apply(themeMode === 'auto' ? (hostTheme() || 'auto') : themeMode, card);
    }
}

// Follow the page when the user flips ChatGPT's theme while the card is up.
new MutationObserver(applyCardTheme).observe(document.documentElement,
    { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

if (typeof PromptMeterTheme !== 'undefined') {
    themeMode = PromptMeterTheme.readSync();
    PromptMeterTheme.read((mode) => {
        themeMode = mode;
        applyCardTheme();
    });
}

/**
 * Swaps the heuristic token count for a real cl100k encoder, once.
 *
 * Deferred rather than loaded from the manifest: the rank table is about a megabyte of
 * JSON, and parsing it during page load -- before anyone has typed -- to improve a
 * number the heuristic already approximates is the wrong trade. requestIdleCallback
 * puts it after the page has settled. Until it lands the estimate is used and the card
 * marks every figure with a "~", which is what PromptMeterTokenizer.isExact() is for.
 *
 * Bundled locally, never fetched: the extension has to work with no connection after
 * install, and nothing executable may come from a CDN.
 */
function loadExactTokenizer() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return;
    if (typeof PromptMeterTokenizer === 'undefined' || PromptMeterTokenizer.isExact()) return;

    const start = () => import(chrome.runtime.getURL('utils/tiktoken.bundle.js'))
        .then((module) => {
            PromptMeterTokenizer.setEncoder(module.encode, module.name);
            console.log('[PromptMeter] exact token counts enabled (' + module.name + ').');
        })
        .catch((error) => {
            // The estimate is already in place and correct to within a few percent, so a
            // failure here costs precision and nothing else.
            console.warn('[PromptMeter] exact tokenizer unavailable; using the estimate.',
                error);
        });

    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(start, { timeout: 5000 });
    } else {
        setTimeout(start, 2000);
    }
}

loadExactTokenizer();

// The first run builds the dictionary indexes and compiles the rules: about 250ms,
// paid on the user's first keystroke. Paying it while the page is idle instead.
(function warmUp() {
    if (typeof PromptMeterCompress === 'undefined') return;
    const run = () => {
        try { PromptMeterCompress.compress('Please explain how `x` works, thanks', { budgetMs: 100 }); }
        catch (e) { /* the real call reports its own errors */ }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 1500);
})();

// Global enabled state (controlled by the popup on/off switch)
let isPromptMeterEnabled = true;

if (hasChromeStorage()) {
    chrome.storage.local.get({ isEnabled: true, dictionary: [], strictness: 'trim' }, (res) => {
        isPromptMeterEnabled = res.isEnabled !== false;
        dictionaryWords = new Set(res.dictionary || []);
        strictness = res.strictness || 'trim';
    });

    // React to popup/dashboard changes without needing a page reload
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.theme !== undefined && typeof PromptMeterTheme !== 'undefined') {
            themeMode = PromptMeterTheme.normalize(changes.theme.newValue);
            applyCardTheme();
        }

        if (changes.dictionary !== undefined) dictionaryWords = new Set(changes.dictionary.newValue || []);
        // Changed in the popup or another tab: re-run so an open card shows the new level.
        if (changes.strictness !== undefined) setStrictness(changes.strictness.newValue || 'trim', false);

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
    return readRaw(el).trim();
}

// The composer's text with its line breaks. ProseMirror keeps one <p> per line, and
// textContent concatenates them with nothing between: "hi" / "explain X" / "thanks"
// read as "hiexplain Xthanks", so a multi-line prompt was analysed, shown and saved
// for Revert with its words glued together.
function readRaw(el) {
    if (!el) return "";
    if (typeof el.value === 'string') return el.value;
    const blocks = el.querySelectorAll(':scope > p, :scope > div');
    if (blocks.length) return Array.from(blocks, block => block.textContent).join('\n');
    return el.innerText || el.textContent || "";
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

    // An emptied composer is a new prompt: the old undo steps belong to text that is
    // gone, and Revert would paste it back in. Checked on every input event, not after
    // the debounce -- select-all, delete, type fast, and the pause never sees it empty.
    if (undoStack.length && !readText(getPromptBox() || (e && e.target))) undoStack.length = 0;

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
// The Esc listener is torn down with the card: left attached it would swallow an Esc
// the host page wanted, on every page load, for the rest of the session.
let escHandler = null;

function hideOptimizationCard() {
    const card = document.getElementById("promptmeter-opt-card");
    if (card) { card.classList.remove("visible"); delete card.dataset.side; }
    if (escHandler) {
        document.removeEventListener('keydown', escHandler, true);
        escHandler = null;
    }
}

// 2a. Keep the card clear of the composer.
//
// A fixed offset from the bottom of the window cannot work: ChatGPT's input grows as
// the user types, and a long prompt pushes the top of the composer up under a card
// pinned at a constant height. So the composer is measured live and the card is placed
// directly above whatever it currently occupies, shrinking (and scrolling internally)
// rather than ever overlapping it.
// What each severity means, shown on hover. Kept beside the card rather than in
// optimizer.js because it is presentation: the engine decides the tier, this
// decides how to explain it.
// Words the user has told us to leave alone, for this page.
//
// Rejecting a correction has to actually stop it happening. Hiding the row would leave
// the rewrite unchanged and the word still corrected, and the next keystroke would
// bring the row straight back. These are threaded into the optimizer, which adds them
// to the vocabulary the spelling corrector treats as already right.
//
// Not persisted: it is a correction someone declined on one prompt, not a dictionary
// entry, and a name that should survive here may well be a typo in the next prompt.
// "Always keep" is the persisted version: dictionaryWords, synced from storage.
//
// What the composer held before each Apply, newest last, so Revert can walk back.
// Undo is not enough: writing into a React or ProseMirror editor goes through synthetic
// events, and the host's own undo stack does not reliably contain a step for it. Keeping
// the strings is the only way to guarantee the user can get their own words back.
const UNDO_LIMIT = 5;
const undoStack = [];

const preservedWords = new Set();
let dictionaryWords = new Set();
// Edit level: 'fixes' (spelling and grammar), 'trim' (also filler), 'condense' (also
// wordy phrasing). Chosen in the popup or on the card; Trim by default.
let strictness = 'trim';
const EDIT_LEVELS = [['fixes', 'Fix', 'Spelling and grammar only'],
    ['trim', 'Trim', 'Also remove greetings and filler'],
    ['condense', 'Condense', 'Also shorten wordy phrasing']];

function setStrictness(level, save) {
    if (!EDIT_LEVELS.some(([id]) => id === level) || level === strictness) return;
    strictness = level;
    if (save && hasChromeStorage()) PromptMeterStorage.setSetting('strictness', level);
    pmLog('level', 'edit level ' + level);
    // Re-run on what is in the box now, and keep the card open even if this level has
    // nothing to change -- a card that vanishes on a click reads as a crash.
    const card = document.getElementById("promptmeter-opt-card");
    const box = getPromptBox();
    if (card && card.classList.contains('visible') && box) analyzeAndOfferOptimization(readText(box), true);
}

// Session keeps and the personal dictionary, as the one set the corrector reads.
function keptWords() {
    return dictionaryWords.size ? new Set([...preservedWords, ...dictionaryWords]) : preservedWords;
}

/**
 * Names the panel after what is actually in it.
 * @param {Array} applied - Corrections already made to the text.
 * @param {Array} advice - Findings only the user can act on.
 * @returns {string}
 */
function headingFor(applied, advice) {
    if (applied.length && advice.length) return 'Corrected, and worth a look';
    if (applied.length) return applied.length === 1 ? 'Corrected' : 'Corrections';
    return advice.length === 1 ? 'Worth a look' : 'Worth a look';
}

// Why a finding exists, by what kind of finding it is. The row says WHAT changed;
// this says why PromptMeter thinks it should.
const WHY_BY_CATEGORY = {
    spelling: 'This word is not in PromptMeter\'s dictionary, and it is one typing slip away from the correction. If it is a name or a term you use, keep it.',
    grammar: 'A grammar rule that holds whatever the topic. Models read garbled grammar fine, but a wrong tense or subject can change which question they answer.',
    punctuation: 'Punctuation and capitals. It rarely changes the answer; it is fixed because it costs nothing.',
    ambiguity: 'Vague words and references with nothing to point at make the model guess, and a guess can answer a different question from yours.',
    'output-format': 'Without a stated format the model picks one. Naming it (a list, a table, 200 words) often saves a follow-up message.',
    'missing-context': 'The answer depends on something the prompt does not say, so the model will fill it in with an assumption.',
    repetition: 'Saying the same thing twice costs tokens and gives the model nothing new.',
    contradiction: 'Two instructions pull against each other; the model will quietly satisfy one and drop the other.',
    structure: 'How the request is laid out makes it harder to follow.'
};

function whyText(issue) {
    const base = WHY_BY_CATEGORY[issue.category || issue.type]
        || SEVERITY_TITLE[issue.severity] || SEVERITY_TITLE.suggestion;
    // The rule's own definition, where the engine supplies one.
    return issue.detail && issue.detail !== issue.explanation ? base + ' ' + issue.detail : base;
}

function smallButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'promptmeter-why-btn';
    button.textContent = label;
    button.onclick = (event) => {
        event.stopPropagation();
        onClick(button);
    };
    return button;
}

const SEVERITY_TITLE = {
    error: 'Definitely wrong: a rule that does not depend on context',
    suggestion: 'Probably right, but the context could make it wrong',
    improvement: 'Was not wrong -- this is shorter or tidier'
};

const CARD_GAP = 12;         // Clearance between the card and the top of the composer
const CARD_MIN_HEIGHT = 140; // Below this the card is unreadable; it scrolls instead
// The card sizes to what it shows: a one-line fix does not need a composer-wide panel
// covering the conversation. fitWidth() picks between these per render; wide prompts
// and cards with panels get the full width, never more than the composer or window.
const CARD_MAX_WIDTH = 680;
const CARD_MIN_WIDTH = 460;
const CARD_EDGE = 8;         // Keeps the card off the viewport edges
// Below this much room above the composer, the card opens below it if there is more there.
const CARD_ROOMY = 360;
// Below this height the card shows only what it is for: the saving, the suggestion and
// the buttons. On a 529px window ChatGPT left ~230px either side of the composer, and
// the full card squeezed the suggestion out of sight.
const CARD_COMPACT = 330;

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
        card.classList.remove("promptmeter-anchored", "promptmeter-compact");
        card.style.left = card.style.width = card.style.bottom = card.style.maxHeight = card.style.top = "";
        return;
    }

    const width = Math.min(
        Number(card.dataset.fitWidth) || CARD_MAX_WIDTH,
        Math.max(280, rect.width),
        // The viewport is the real limit. Clamping `left` cannot rescue a card that is
        // wider than the window -- it pins the left edge and lets the right run off.
        Math.max(280, window.innerWidth - CARD_EDGE * 2)
    );
    const left = Math.max(CARD_EDGE, Math.min(
        window.innerWidth - width - CARD_EDGE,
        rect.left + (rect.width - width) / 2
    ));

    // Below the composer when that is where the room is. ChatGPT's new-chat screen puts
    // the composer mid-page, and on a laptop-height window the gap above it was ~220px:
    // the card squeezed into it and the suggestion scrolled out of sight.
    const roomAbove = rect.top - CARD_GAP - CARD_EDGE;
    const roomBelow = window.innerHeight - rect.bottom - CARD_GAP - CARD_EDGE;
    // Sticky side. Deciding afresh on every measurement made the card jump from above
    // the composer to below it as the user's text grew the box ("the popup goes
    // down"). It now keeps its side while that side still fits a usable card, and a
    // fresh card prefers above unless there is truly no room there.
    // "Fits" is the card's own height (capped at CARD_ROOMY), so a short card holds
    // its side in less room than a tall one and a squeezed card still moves.
    const needed = Math.min(card.offsetHeight || CARD_ROOMY, CARD_ROOMY);
    let side = card.dataset.side;
    if (side === 'below' ? roomBelow < needed && roomAbove > roomBelow
        : side === 'above' ? roomAbove < needed && roomBelow > roomAbove
            : true) {
        side = roomAbove < CARD_ROOMY && roomBelow > roomAbove ? 'below' : 'above';
    }
    card.dataset.side = side;
    if (side === 'below') {
        card.style.left = `${Math.round(left)}px`;
        card.style.width = `${Math.round(width)}px`;
        card.style.top = `${Math.round(rect.bottom + CARD_GAP)}px`;
        card.style.bottom = 'auto';
        card.style.maxHeight = `${Math.round(roomBelow)}px`;
        card.classList.toggle("promptmeter-compact", roomBelow < CARD_COMPACT);
        card.classList.add("promptmeter-anchored");
        return;
    }
    card.style.top = '';

    // Sit on top of the composer, but never so high that the card leaves the viewport
    // on a short window -- there, overlapping is the lesser of the two failures.
    const clear = window.innerHeight - rect.top + CARD_GAP;
    const ceiling = Math.max(CARD_EDGE, window.innerHeight - CARD_MIN_HEIGHT - CARD_EDGE);
    const bottom = Math.min(Math.max(CARD_EDGE, clear), ceiling);

    card.style.left = `${Math.round(left)}px`;
    card.style.width = `${Math.round(width)}px`;
    card.style.bottom = `${Math.round(bottom)}px`;
    card.style.maxHeight = `${Math.round(window.innerHeight - bottom - CARD_EDGE)}px`;
    card.classList.toggle("promptmeter-compact", window.innerHeight - bottom - CARD_EDGE < CARD_COMPACT);
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

/**
 * Word-level diff of the prompt against the suggestion, as two annotated token lists.
 *
 * Two plain boxes made the user compare the texts by eye to find what changed. An LCS
 * over words marks exactly which words went and which arrived. Each word keeps the
 * whitespace after it, so line breaks render as typed.
 *
 * @returns {{before: Array, after: Array}|null} [{text, changed}] per side, or null
 *          when the texts are too long to diff on a keystroke.
 */
function diffWords(before, after) {
    const split = (s) => (s.match(/\S+\s*/g) || []).map(t => ({ word: t.trimEnd(), text: t }));
    const a = split(before);
    const b = split(after);
    // ponytail: O(n*m) table; above ~2M cells (about 1,400 x 1,400 words) plain text is shown instead
    if (a.length * b.length > 2e6) return null;

    const cols = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * cols + j] = a[i].word === b[j].word
                ? lcs[(i + 1) * cols + j + 1] + 1
                : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i].word === b[j].word) { i++; j++; }
        else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) a[i++].changed = true;
        else b[j++].changed = true;
    }
    while (i < a.length) a[i++].changed = true;
    while (j < b.length) b[j++].changed = true;
    return { before: a, after: b };
}

// Writes diff tokens into a box as text nodes and spans. Never innerHTML: this is the
// user's own writing, and a "<" in it must stay a character.
// Consecutive changed words share one highlight: a pill per word turned a removed
// sentence into a row of fragments.
function renderDiff(box, tokens, changedClass) {
    box.textContent = '';
    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].changed) {
            box.appendChild(document.createTextNode(tokens[i].text));
            continue;
        }
        let run = '';
        while (i < tokens.length && tokens[i].changed) run += tokens[i++].text;
        i--;
        const words = run.trimEnd();
        const mark = document.createElement('span');
        mark.className = changedClass;
        mark.textContent = words;
        box.appendChild(mark);
        box.appendChild(document.createTextNode(run.slice(words.length)));
    }
}

// The validator's rule ids, in words a user can act on. "it would have changed
// constraint, numbers" was the card quoting its own internals.
const LOST_RULE_TEXT = {
    numbers: 'a number', constraint: 'a requirement', verbatim: 'code or quoted text',
    format: 'the output format', task: 'what you asked for', invention: 'words you did not write',
    payload: 'the text you pasted', name: 'a name or term', 'list-item': 'a list item',
    empty: 'every word'
};

// 3. Create and show the optimization overlay
function showOptimizationCard(originalText, optimizedText, tokensSaved, carbonSaved, grammarIssues, scopeIssues, tokenStats, headroom, compression) {
    let card = document.getElementById("promptmeter-opt-card");

    // Nothing the card shows has changed since the last render: keep the DOM. A rebuild
    // on every pause in typing flickered, reset the scroll, and snapped an open "Why?"
    // panel shut under the user's cursor.
    const signature = JSON.stringify([originalText, optimizedText,
        (grammarIssues || []).map(i => i.label || i.explanation), (scopeIssues || []).map(i => i.label),
        tokenStats && [tokenStats.originalTokens, tokenStats.optimizedTokens, tokenStats.exact],
        headroom && headroom.percentUsed, compression && compression.mode, undoStack.length, strictness]);
    if (card && card.classList.contains('visible') && card.dataset.signature === signature) {
        positionOptimizationCard(true);
        return;
    }
    if (!card) {
        card = document.createElement("div");
        card.id = "promptmeter-opt-card";
        // pm-tokens carries every colour and radius from utils/tokens.css. It sits on
        // the card rather than on :root so the host page keeps its own variables.
        card.className = "promptmeter-opt-card pm-tokens";
        // A named landmark, so a screen reader can find the card. Not aria-live: it is
        // rebuilt on every pause in typing, and re-reading all of it each time is noise.
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', 'PromptMeter suggestion');
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

    // optimizeWithReport already de-duplicates these and tags each with a severity,
    // sorted most-certain first, so the card shows what is definitely wrong before
    // what is merely tidier.
    const issues = (grammarIssues || [])
        .filter(issue => issue && (issue.label || issue.explanation));
    // Applied corrections and advice are different things and the panel used to
    // run them together under "Errors corrected" -- a heading that was wrong for
    // two of the three rows under it. A correction has already happened to the
    // text; advice is something only the user can act on.
    const APPLIED = new Set(['spelling', 'grammar', 'punctuation', 'agreement',
        'article', 'verb-form', 'noun-form', 'pronoun-case', 'contraction',
        'redundancy', 'word-choice', 'phrasing']);
    const applied = issues.filter(issue => APPLIED.has(issue.type || issue.category));
    const advice = issues.filter(issue => !APPLIED.has(issue.type || issue.category));

    const shownIssues = applied.concat(advice).slice(0, 5);
    const hiddenCount = issues.length - shownIssues.length;

    card.dataset.signature = signature;
    // Width to fit: short suggestions get a compact card, long prompts and cards with
    // panels (findings, advice, warnings) the full width.
    const longest = Math.max(originalText.length, optimizedText.length);
    const panels = (grammarIssues || []).length + (scopeIssues || []).length + (headroom ? 1 : 0);
    card.dataset.fitWidth = String(longest < 90 && panels === 0 ? CARD_MIN_WIDTH
        : longest < 220 && panels <= 2 ? 560 : CARD_MAX_WIDTH);
    // An update to a card already on screen fades its content in rather than snapping.
    if (card.classList.contains('visible')) {
        card.classList.remove('promptmeter-refreshed');
        void card.offsetWidth;   // restart the animation
        card.classList.add('promptmeter-refreshed');
    }
    card.innerHTML = `
        <div class="promptmeter-opt-header">
            <div class="promptmeter-opt-title">PromptMeter</div>
            <div class="promptmeter-modes" role="radiogroup" aria-label="Edit level">
                ${EDIT_LEVELS.map(([id, label, hint]) => `<button type="button" role="radio"
                    class="promptmeter-mode" data-level="${id}" title="${hint}"
                    aria-checked="${id === strictness}">${label}</button>`).join('')}
            </div>
            <div class="promptmeter-opt-metrics">
                ${stats ? `
                <div class="promptmeter-hero ${stats.saved < 0 ? 'promptmeter-hero-cost' : ''}"
                     title="${stats.saved < 0 ? 'This rewrite costs tokens' : 'Tokens saved'}">
                    <span class="promptmeter-hero-value">${stats.saved < 0 ? '+' : '−'}${Math.abs(stats.saved)} ${Math.abs(stats.saved) === 1 ? 'token' : 'tokens'}</span>
                    <span class="promptmeter-hero-unit">${Math.abs(stats.percent)}%</span>
                </div>` : ''}
                <div class="promptmeter-metric-line">
                    ${stats ? `
                    <span class="promptmeter-metric promptmeter-metric-count" title="${countNote}">
                        <span class="promptmeter-count-from">${approx}${stats.originalTokens}</span>
                        <span class="promptmeter-count-arrow" aria-hidden="true">→</span>
                        <span class="promptmeter-count-to">${approx}${stats.optimizedTokens}</span>
                    </span>` : ''}
                </div>
            </div>
        </div>
        <div class="promptmeter-opt-diff">
            <div class="promptmeter-diff-row">
                <div class="promptmeter-diff-label">Original</div>
                <div class="promptmeter-diff-box promptmeter-diff-original"></div>
            </div>
            <div class="promptmeter-diff-row">
                <div class="promptmeter-diff-label promptmeter-diff-label-after">Suggestion</div>
                <div class="promptmeter-diff-box promptmeter-diff-optimized"></div>
            </div>
        </div>
        <div class="promptmeter-opt-headroom" hidden></div>
        <div class="promptmeter-opt-preserve" hidden></div>
        <div class="promptmeter-opt-scope" hidden>
            <div class="promptmeter-scope-title">${(scopeIssues || []).some(f => f.type === 'complexity') ? 'Worth reconsidering' : 'Worth splitting up'}</div>
            <ul class="promptmeter-scope-list"></ul>
        </div>
        <div class="promptmeter-opt-grammar" hidden>
            <div class="promptmeter-grammar-title">${headingFor(applied, advice)}</div>
            <ul class="promptmeter-grammar-list"></ul>
        </div>
        <div class="promptmeter-opt-actions">
            <button id="promptmeter-btn-revert" class="promptmeter-opt-btn promptmeter-btn-ignore" hidden>Revert</button>
            <button id="promptmeter-btn-copy" class="promptmeter-opt-btn promptmeter-btn-ignore" title="Copy the suggestion without changing your message">Copy</button>
            <button id="promptmeter-btn-ignore" class="promptmeter-opt-btn promptmeter-btn-ignore">Ignore<span class="promptmeter-btn-key" aria-hidden="true">esc</span></button>
            <button id="promptmeter-btn-accept" class="promptmeter-opt-btn promptmeter-btn-accept">Apply</button>
        </div>
    `;

    // The prompt goes in as text, not markup. It is the user's own writing, so a stray
    // "<" would otherwise be parsed as a tag and silently swallow the rest of the
    // preview -- and anything pasted in from elsewhere would be parsed as markup too.
    const originalBox = card.querySelector('.promptmeter-diff-original');
    const optimizedBox = card.querySelector('.promptmeter-diff-optimized');
    const diff = diffWords(originalText, optimizedText);
    if (diff) {
        renderDiff(originalBox, diff.before, 'promptmeter-diff-del');
        renderDiff(optimizedBox, diff.after, 'promptmeter-diff-ins');
    } else {
        originalBox.textContent = originalText;
        optimizedBox.textContent = optimizedText;
    }

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

    // What a harder compression would have cost. The candidates that were tried and
    // rejected are the most useful thing the compressor knows: "a shorter version was
    // available and it dropped your word limit" is a better answer than silence about
    // why the prompt was not compressed further.
    // Only candidates SHORTER than the one shown: warnings lists every rejected tier,
    // so a failed conservative tier behind a winning balanced one claimed "a shorter
    // rewrite was rejected" when it was the longer one.
    const shown = compression && compression.tokens ? compression.tokens.optimized : Infinity;
    const heldBack = compression && compression.candidates
        ? compression.candidates.filter(c => !c.valid && c.tokens < shown) : [];
    if (heldBack.length) {
        const row = card.querySelector('.promptmeter-opt-preserve');
        const lost = [...new Set(heldBack
            .reduce((all, c) => all.concat(c.violations.map(v => v.rule)), [])
            .map(rule => LOST_RULE_TEXT[rule] || rule))];
        const listed = lost.length > 1
            ? lost.slice(0, -1).join(', ') + ' or ' + lost[lost.length - 1]
            : lost[0];
        row.textContent = 'A shorter version was held back because it would have lost '
            + listed + '.';
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
        shownIssues.forEach(issue => {
            const item = document.createElement('li');
            // A dot carrying the severity, then the text. The severity is a class
            // rather than a word so the row stays one line at 11px.
            const dot = document.createElement('span');
            dot.className = 'promptmeter-severity promptmeter-severity-'
                + (issue.severity || 'suggestion');
            dot.title = SEVERITY_TITLE[issue.severity] || SEVERITY_TITLE.suggestion;
            item.appendChild(dot);

            const text = document.createElement('span');
            text.className = 'promptmeter-grammar-text';
            text.textContent = issue.label || issue.explanation;
            item.appendChild(text);

            // A correction the user can decline. Only offered where declining does
            // something: a spelling change names the word to keep, so the rewrite can be
            // redone without it. Advice has nothing to undo.
            if (issue.word) {
                const keep = document.createElement('button');
                keep.type = 'button';
                keep.className = 'promptmeter-keep';
                keep.textContent = 'Keep';
                keep.title = 'Leave "' + issue.word + '" as you wrote it';
                keep.onclick = (event) => {
                    event.stopPropagation();
                    preservedWords.add(issue.word.toLowerCase());
                    pmLog('keep', 'correction declined for this page', { word: issue.word });
                    // Re-run rather than patch the text: a preserved word changes what
                    // every later stage sees, and editing the output string would give a
                    // different answer from the one the pipeline would produce.
                    analyzeAndOfferOptimization(originalText);
                };
                item.appendChild(keep);
            }

            // "Why?" opens the reason under the row, with the actions that go with it:
            // keep the word for good, or report the fix as wrong.
            const whyButton = document.createElement('button');
            whyButton.type = 'button';
            whyButton.className = 'promptmeter-keep promptmeter-why';
            whyButton.textContent = 'Why?';
            whyButton.setAttribute('aria-expanded', 'false');
            item.appendChild(whyButton);
            list.appendChild(item);

            const why = document.createElement('li');
            why.className = 'promptmeter-why-panel';
            why.hidden = true;
            const reason = document.createElement('p');
            reason.textContent = whyText(issue);
            why.appendChild(reason);
            const actions = document.createElement('div');
            actions.className = 'promptmeter-why-actions';
            if (issue.word && typeof PromptMeterStorage !== 'undefined') {
                actions.appendChild(smallButton('Always keep "' + issue.word + '"', (button) => {
                    pmLog('always-keep', 'word added to the dictionary', { word: issue.word });
                    PromptMeterStorage.addToDictionary(issue.word, () => {
                        dictionaryWords.add(PromptMeterStorage.normalizeWord(issue.word));
                        analyzeAndOfferOptimization(originalText);
                    });
                    button.disabled = true;
                }));
            }
            if (typeof PromptMeterStorage !== 'undefined') {
                actions.appendChild(smallButton('Report this as wrong', (button) => {
                    pmLog('report', 'correction reported as wrong', { finding: issue.label || issue.explanation });
                    PromptMeterStorage.addFixReport({
                        category: issue.category || issue.type || '',
                        finding: issue.label || issue.explanation || '',
                        word: issue.word || '',
                        prompt: originalText,
                        suggestion: optimizedText
                    }, () => { button.textContent = 'Reported, thanks'; });
                    button.disabled = true;
                }));
            }
            why.appendChild(actions);
            list.appendChild(why);
            whyButton.onclick = (event) => {
                event.stopPropagation();
                why.hidden = !why.hidden;
                whyButton.setAttribute('aria-expanded', String(!why.hidden));
            };
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

    // Copy for use elsewhere (another chat, a doc) without touching the composer.
    const copy = card.querySelector("#promptmeter-btn-copy");
    copy.onclick = () => {
        const done = (label) => {
            copy.textContent = label;
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(optimizedText).then(() => { done('Copied'); pmLog('copy', 'suggestion copied'); },
                (err) => { done('Copy failed'); pmLog('copy', 'clipboard refused: ' + (err && err.message), null, 'warn'); });
        } else {
            done('Copy failed');
        }
    };

    const revert = card.querySelector("#promptmeter-btn-revert");
    // Revert walks back through the last UNDO_LIMIT applies, newest first.
    revert.hidden = undoStack.length === 0;
    revert.textContent = undoStack.length > 1 ? `Revert (${undoStack.length})` : 'Revert';
    revert.title = 'Put back what you had before the last Apply';
    revert.onclick = () => {
        const promptBox = getPromptBox();
        if (!promptBox || undoStack.length === 0) return;
        // Popped before writing: the write triggers the input handler, and a stale
        // entry would offer to revert the text that was just restored.
        const restore = undoStack.pop().before;
        pmLog('revert', 'restored text from before an apply', { left: undoStack.length });
        wasOptimized = false;
        lastSavedTokens = 0;
        lastSavedCarbon = 0;
        lastOriginalPrompt = "";
        ignoredPromptText = restore;
        replacePromptText(promptBox, restore);
        hideOptimizationCard();
    };
    // Ignoring the prompt and dismissing with Esc have to mean the same thing, or the
    // card reappears on the next keystroke after one of them.
    const dismiss = () => {
        ignoredPromptText = originalText;
        hideOptimizationCard();
    };
    card.querySelector("#promptmeter-btn-ignore").onclick = dismiss;
    card.querySelectorAll('.promptmeter-mode').forEach((button) => {
        button.onclick = () => setStrictness(button.dataset.level, true);
    });

    // Esc dismisses it, which is what every other dismissible panel on these pages does
    // and was previously impossible without reaching for the mouse. Registered on the
    // document because focus is almost always in the composer, not in the card, and
    // removed as soon as the card goes so it cannot swallow an Esc meant for the host
    // page. Enter is deliberately NOT bound: it is how these pages send a message.
    if (escHandler) document.removeEventListener('keydown', escHandler, true);
    escHandler = (event) => {
        if (event.key !== 'Escape') return;
        if (!card.classList.contains('visible')) return;
        event.stopPropagation();
        dismiss();
    };
    document.addEventListener('keydown', escHandler, true);

    // Place it before it fades in, so it never appears over the composer first.
    // Positioning is a convenience: if measuring the page fails for any reason the
    // card must still be shown, at the stylesheet's default position.
    try {
        positionOptimizationCard(true);
        watchComposer();
    } catch (err) {
        console.warn("PromptMeter: could not anchor the card to the composer.", err);
        card.classList.remove("promptmeter-anchored", "promptmeter-compact");
        card.style.left = card.style.width = card.style.bottom = card.style.maxHeight = card.style.top = "";
    }

    card.classList.add("visible");
}

// 4. Analyze the text currently being typed and offer a rewrite
function analyzeAndOfferOptimization(text, keepOpen) {
    const analysisStarted = performance.now();
    // Trimmed on both sides: `text` arrives trimmed, but Revert stores the box's raw
    // value, so a trailing newline brought the card straight back after a revert.
    if (!isPromptMeterEnabled || text.trim() === ignoredPromptText.trim()) return;

    // This runs inside a debounce timer, where a throw is swallowed by the event loop
    // and the card simply never appears. Surface it instead.
    let optimized;
    let compression = null;
    let grammarIssues = [];
    let scopeIssues = [];
    try {
        // PromptMeterAnalysis when it is available: it runs the same optimizer and then
        // adds the detectors a rewrite cannot serve -- contradictions, unbounded scope,
        // ambiguity, missing context -- and tags every finding with the word it changed
        // so a row can be declined. The optimizer alone is the fallback, so a build
        // without analysis.js still shows a card rather than nothing.
        if (typeof PromptMeterCompress !== 'undefined') {
            // The compressor generates several rewrites, validates each against the
            // original and takes the shortest that survives -- so the card shows a text
            // that has been checked for lost constraints rather than merely produced.
            // A budget keeps candidate generation off the critical path of a keystroke.
            compression = PromptMeterCompress.compress(text, { budgetMs: 40, preserve: keptWords(),
                maxMode: (PromptMeterStorage.STRICTNESS || {})[strictness] });
            optimized = compression.text;
            // An unchanged prompt hides the card whatever the reason; the console is
            // where "nothing to do" and "it broke" stay distinguishable.
            if (compression.status === PromptMeterCompress.STATUS.FAILED) {
                console.error("[PromptMeter] compression failed:", compression.reason, compression.error);
                pmLog('compression-failed', compression.reason, null, 'error');
            }
            // compress() already ran the analysis; running it again doubled the cost.
            const result = compression.analysis || PromptMeterAnalysis.analyze(text, keptWords());
            grammarIssues = result.findings.filter(f => f.severity !== 'improvement' && f.category !== 'scope');
            scopeIssues = result.findings
                .filter(f => f.category === 'scope')
                .map(f => ({ label: f.explanation, type: 'scope' }));
        } else if (typeof PromptMeterAnalysis !== 'undefined') {
            const result = PromptMeterAnalysis.analyze(text, keptWords());
            optimized = result.optimized;
            grammarIssues = result.findings.filter(f => f.severity !== 'improvement' && f.category !== 'scope');
            scopeIssues = result.findings
                .filter(f => f.category === 'scope')
                .map(f => ({ label: f.explanation, type: 'scope' }));
        } else {
            const report = PromptMeterOptimizer.optimizeWithReport(text, keptWords());
            optimized = report.text;
            grammarIssues = report.grammar;
            scopeIssues = report.scope;
        }
    } catch (err) {
        console.error("[PromptMeter] optimizePrompt failed for this text.", err, text);
        if (typeof PromptMeterStorage !== 'undefined') PromptMeterStorage.error('analyze-failed', err, { chars: text.length });
        hideOptimizationCard();
        return;
    }

    if (!optimized || optimized.trim() === text.trim()) {
        if (!keepOpen) {
            hideOptimizationCard();
            return;
        }
        optimized = text;
    }

    // In a conversation already under way, a short follow-up ("fix it", "more", "same
    // but shorter") refers to the last reply, which this prompt cannot see. Warning that
    // "it" points at nothing, or that no request is stated, is wrong there; in a new
    // chat the same warning is right, so it stays for first messages.
    if (getAssistantMessages().length > 0 && text.split(/\s+/).length <= 8) {
        const FOLLOW_UP_NOISE = /first thing the prompt mentions|Does not clearly state|stops part-way|not included|vague terms/i;
        grammarIssues = grammarIssues.filter(issue => !FOLLOW_UP_NOISE.test(issue.label || issue.explanation || ''));
    }

    // Rows describe the suggestion, so a correction it does not contain is dropped:
    // a typo inside a quote the compressor protected, or "pls" -> "please" when "pls"
    // was removed outright. Listing those promised fixes Apply would not make.
    grammarIssues = grammarIssues.filter(issue => {
        const label = issue.label || issue.explanation || '';
        if (!/corrected to|should be|missing an apostrophe/.test(label)) return true;
        const quoted = label.match(/"([^"]+)"/g);
        const fixed = quoted && quoted[quoted.length - 1].slice(1, -1).toLowerCase();
        return !fixed || optimized.toLowerCase().includes(fixed);
    });

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
    // The threshold decides whether to OPEN the card, not whether to keep it open.
    // Applied on every pause, a saving hovering around two tokens switched the card
    // off and on as the user kept typing ("it goes off in between").
    const openCard = document.getElementById("promptmeter-opt-card");
    const alreadyShowing = !!(openCard && openCard.classList.contains('visible'));
    if (!alreadyShowing && tokensSaved < 2 && charSavingsPct < 5.0 && grammarIssues.length === 0 &&
        scopeIssues.length === 0) {
        hideOptimizationCard();
        return;
    }

    pmLog('card', 'suggestion shown', { saved: tokensSaved, mode: compression ? compression.mode : '',
        status: compression ? compression.status : '', fixes: grammarIssues.length,
        ms: Math.round(performance.now() - analysisStarted), chars: text.length });
    showOptimizationCard(text, optimized, tokensSaved,
        PromptMeterCalculator.savings(tokensSaved).carbon, grammarIssues, scopeIssues,
        tokenStats, headroom, compression);
}

// 5. Apply the optimized prompt text directly into ChatGPT's input area
function applyOptimization(optimizedText) {
    const promptBox = getPromptBox();
    if (!promptBox) {
        hideOptimizationCard();
        return;
    }

    // With its line breaks, so Revert puts back the lines as typed.
    const originalText = readRaw(promptBox);
    const tokensSaved = Math.max(
        0,
        PromptMeterTokenizer.countTokens(originalText) - PromptMeterTokenizer.countTokens(optimizedText)
    );

    // Recorded before the write, whether or not any tokens were saved: a rewrite that
    // saved nothing is exactly the one a user is most likely to want back.
    undoStack.push({ before: originalText, after: optimizedText });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();

    if (tokensSaved > 0) {
        wasOptimized = true;
        lastSavedTokens = tokensSaved;
        lastSavedCarbon = PromptMeterCalculator.savings(tokensSaved).carbon;
        lastOriginalPrompt = originalText.trim();
    }

    // Don't re-evaluate the text that was just applied
    ignoredPromptText = optimizedText;
    replacePromptText(promptBox, optimizedText);
    pmLog('apply', 'suggestion applied', { saved: tokensSaved, chars: optimizedText.length });
    hideOptimizationCard();
}

// Writes text into the composer AND tells the editor it changed. Shared by Apply and
// Revert: Revert used to write without the events, so on a textarea React kept the
// applied text in its state and Send could post the version the user had just undone.
function replacePromptText(promptBox, text) {
    promptBox.focus();
    writeToPromptBox(promptBox, text);

    // Dispatch synthetic events so React and ProseMirror update their internal state
    try {
        promptBox.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
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
    // The new markup puts the role on the turn element itself, not inside it.
    return SELECTORS.assistantMarkers.some(sel => turn.matches(sel)) || matchesAny(turn, SELECTORS.assistantMarkers);
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

    // A failed reply is ChatGPT's error text, not an answer. Saving it put "This response
    // couldn't load" into the history and the averages; the turn is logged instead, so a
    // network drop shows up in the event log rather than as a fake conversation.
    if (cleanResponse.length < 200 && /couldn'?t load|something went wrong|network error|error in (?:message|body) stream|an error occurred|there was an error generating|request timed out|too many requests/i.test(cleanResponse)) {
        pmLog('capture-skipped', 'reply was an error message, not saved', { reply: cleanResponse }, 'warn');
        return;
    }

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

        // analyzePrompt returns scored:false when there was no prompt to judge. Saving
        // that turn would put a null efficiencyScore into the history the dashboard
        // averages over, and there is nothing to learn from a turn with no prompt.
        if (analysis.scored === false) return;

        const turnData = Object.assign({
            prompt: cleanPrompt,
            response: cleanResponse,
            promptTokens: promptTokens,
            responseTokens: responseTokens,
            totalTokens: totalTokens,
            electricity: footprint.electricity,
            carbon: footprint.carbon,
            efficiencyScore: analysis.score,
            // Which quality heuristics fired, as ids rather than prose. The labels are
            // presentation and change; the ids are the contract the dashboard reads.
            qualityIssues: (analysis.quality || []).map(finding => finding.id),
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

        pmLog('capture', 'turn saved', { tokens: totalTokens, optimized: turnData.wasOptimized, score: analysis.score });
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

    // The composer element is new too, so the size watch has to follow it
    watchComposer();
}

// Typing is heard at the document, not on the box. On chatgpt.com the editor is still
// hydrating and re-rendering for several seconds after load, and a listener bound to
// the box then could miss the first prompt entirely -- live testing reproduced a card
// that never appeared for whatever was typed in the first ~8s. One capture-phase
// listener sees input from whichever element is the composer at the time.
function isFromPromptBox(event) {
    const box = getPromptBox();
    const target = event.target instanceof Node ? event.target : null;
    return !!(box && target && (target === box || box.contains(target)));
}
document.addEventListener('input', (event) => { if (isFromPromptBox(event)) handleInput(event); }, true);
document.addEventListener('paste', (event) => { if (isFromPromptBox(event)) handleInput(event); }, true);

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
        // Only when streaming starts. Hiding on every 400ms tick killed any card the
        // user raised by typing their next prompt while a reply was still coming in.
        if (!isStreaming) {
            // The prompt was sent; its undo steps must not follow the user into the next one.
            undoStack.length = 0;
            hideOptimizationCard();
        }
        isStreaming = true;
        clearTimeout(captureLockTimeout);
        return;
    }

    // A reply we never saw streaming still counts if the user sent something and this
    // message is new since then. Relying on the streaming state alone missed any reply
    // that finished between two 400ms checks -- a short "Yes." or a failed load.
    const freshReply = awaitingReplySince > 0 && !knownAtSend.has(latest) && !capturedReplies.has(latest);

    if ((isStreaming || freshReply) && responseText.length > 0) {
        // Wait 800ms after streaming stops so markdown and code blocks have finalized
        clearTimeout(captureLockTimeout);
        captureLockTimeout = setTimeout(() => {
            isStreaming = false;
            awaitingReplySince = 0;
            capturedReplies.add(latest);
            // Re-read: the text may have finished rendering during the wait.
            handleResponseCaptured(findPrecedingUserPrompt(latest), (latest.textContent || responseText).trim());
        }, 800);
    }
}

// Sending: Enter in the composer or a click on Send. Marks the assistant messages that
// already exist, so only a reply that appears after this counts as new -- a past chat
// opened later is never re-captured.
let awaitingReplySince = 0;
let knownAtSend = new WeakSet();
const capturedReplies = new WeakSet();

function markSent() {
    awaitingReplySince = Date.now();
    knownAtSend = new WeakSet(getAssistantMessages());
    // The prompt was sent; its undo steps must not follow the user into the next one.
    undoStack.length = 0;
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const box = getPromptBox();
    if (box && (event.target === box || box.contains(event.target)) && readText(box)) markSent();
}, true);
document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest(SELECTORS.sendButton.join(', '))) markSent();
}, true);

let observerThrottleTimeout = null;

const observer = new MutationObserver(() => {
    // The extension was reloaded under this tab: this copy of the script is orphaned and
    // every chrome.* call would throw. Stand down cleanly; the fresh copy takes over when
    // the page reloads.
    if (typeof chrome !== 'undefined' && chrome.runtime && !chrome.runtime.id) {
        observer.disconnect();
        hideOptimizationCard();
        isPromptMeterEnabled = false;
        console.info('[PromptMeter] extension was reloaded; refresh this tab to use the new version.');
        return;
    }
    if (observerThrottleTimeout) return;
    observerThrottleTimeout = setTimeout(() => {
        observerThrottleTimeout = null;
        processDOMUpdates();
    }, 400);
});

// childList only: watching attributes would thrash on ChatGPT's animated elements
observer.observe(document.body, { childList: true, subtree: true });
