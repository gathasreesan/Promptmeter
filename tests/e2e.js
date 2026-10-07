/**
 * End-to-end checks: the real extension files in a simulated browser page.
 *
 *     npm install --no-save jsdom@24     # once; jsdom is not a project dependency
 *     node tests/e2e.js                  # this repository
 *     node tests/e2e.js path/to/promptmeter   # an unzipped release, to test what ships
 *
 * Loads every content script in manifest order -- content.js included -- into a page
 * shaped like ChatGPT's composer, types prompts, clicks the card's buttons and checks
 * what the user would see. Then loads the popup and the dashboard the same way. The
 * Chrome APIs are stubbed the way Chrome behaves: storage callbacks are asynchronous.
 *
 * Not in the default suite run (like fuzz.js): it needs jsdom, and it takes ~30s.
 * Expected noise: the exact tokenizer cannot be import()ed from a chrome-extension://
 * URL outside Chrome, so content.js falls back to the estimate -- the same fallback a
 * real failure would take -- and the dashboard's chart has no canvas to draw on.
 */

const fs = require('fs');
const path = require('path');

let JSDOM;
try {
    ({ JSDOM } = require('jsdom'));
} catch (error) {
    console.log('jsdom is not installed. Run:  npm install --no-save jsdom@24');
    process.exit(2);
}

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const NL = String.fromCharCode(10);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Noise every run produces outside Chrome; see the header.
const EXPECTED = /exact tokenizer|ERR_UNSUPPORTED_ESM|Failed to create chart/;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
    if (condition) { passed++; return; }
    failed++;
    console.log('FAIL  ' + name + (detail ? '\n      ' + String(detail).slice(0, 300) : ''));
}

/** Chrome's API surface, as far as these pages use it. Callbacks are async, as in Chrome. */
function chromeStub(store) {
    return {
        storage: {
            local: {
                get: (keys, cb) => {
                    const out = {};
                    if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
                        Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
                    } else {
                        Object.assign(out, store);
                    }
                    if (cb) setTimeout(() => cb(out), 0);
                    return Promise.resolve(out);
                },
                set: (obj, cb) => { Object.assign(store, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
                remove: (k, cb) => { if (cb) setTimeout(cb, 0); return Promise.resolve(); },
            },
            onChanged: { addListener() {} },
        },
        runtime: {
            getURL: (p) => 'chrome-extension://promptmeter/' + p,
            sendMessage() {}, onMessage: { addListener() {} }, openOptionsPage() {}, id: 'promptmeter',
        },
        tabs: { create() {}, query: (q, cb) => cb && cb([]) },
    };
}

function watchErrors(w) {
    const errors = [];
    w.console.error = (...args) => errors.push(args.map(String).join(' '));
    w.addEventListener('error', (e) => errors.push('uncaught: ' + ((e.error && e.error.stack) || e.message)));
    return errors;
}

// ---------------------------------------------------------------------------
// The card, on ChatGPT
// ---------------------------------------------------------------------------
function chatPage(kind) {
    const composer = kind === 'textarea'
        ? '<textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>'
        : '<div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p></p></div>';
    const dom = new JSDOM('<!doctype html><html><head></head><body><main>'
        + '<div class="conversation"></div><form>' + composer
        + '<button data-testid="send-button">Send</button></form></main></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://chatgpt.com/' });
    const w = dom.window;
    w.chrome = chromeStub({});
    w.requestIdleCallback = (fn) => setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
    const errors = watchErrors(w);
    // Layout numbers for the positioning code.
    w.HTMLElement.prototype.getBoundingClientRect = function () {
        return { top: 600, left: 200, width: 768, height: 60, bottom: 660, right: 968, x: 200, y: 600 };
    };
    Object.defineProperty(w, 'innerHeight', { value: 900 });
    Object.defineProperty(w, 'innerWidth', { value: 1280 });
    manifest.content_scripts[0].js.forEach((file) => {
        try {
            w.eval(fs.readFileSync(path.join(ROOT, file), 'utf8') + NL + '//# sourceURL=' + file);
        } catch (error) {
            errors.push('LOAD ' + file + ': ' + ((error && error.stack) || error));
        }
    });
    return { w, errors };
}

function type(w, text) {
    const box = w.document.getElementById('prompt-textarea');
    if (box.tagName === 'TEXTAREA') {
        box.value = text;
    } else {
        box.innerHTML = text.split(NL).map((line) => '<p>'
            + (line.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '<br>') + '</p>').join('');
    }
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
}

function composerText(w) {
    const box = w.document.getElementById('prompt-textarea');
    if (box.tagName === 'TEXTAREA') return box.value;
    const lines = box.querySelectorAll('p');
    return lines.length ? [...lines].map((p) => p.textContent).join(NL) : box.textContent;
}

function card(w) {
    const el = w.document.getElementById('promptmeter-opt-card');
    if (!el) return { visible: false };
    const text = (s) => (el.querySelector(s) ? el.querySelector(s).textContent : null);
    return { visible: el.classList.contains('visible'), suggested: text('.promptmeter-diff-optimized') };
}

const click = (w, id) => {
    const el = w.document.getElementById(id);
    if (el) el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return !!el;
};

// What the card should suggest, typed the way people type.
const SUGGESTIONS = [
    ['hey tmrw is mi exm teach me ML', 'Teach me ML'],
    ['hi :) can u pls explan recursion to me thanks', 'Explain recursion to me'],
    ['Explan how fnite automata work', 'Explain how finite automata work'],
    ['teach me different types of ml', 'Teach me different types of ML'],
];

async function testCard(kind) {
    const { w, errors } = chatPage(kind);
    const tag = ' [' + kind + ']';
    await wait(600); // the warm-up runs in idle callbacks
    const DEBOUNCE = 450; // longer than the card's 220ms debounce

    for (const [input, want] of SUGGESTIONS) {
        type(w, input);
        await wait(DEBOUNCE);
        const s = card(w);
        check('the card appears' + tag + ': ' + input, s.visible === true);
        check('it suggests the right rewrite' + tag + ': ' + input, s.suggested === want, s.suggested);
    }

    // A quiz keeps its answer options exactly as typed.
    const quiz = 'Which word is spelled correctly?' + NL + 'A) recieve' + NL + 'B) receive' + NL + 'C) receeve';
    type(w, quiz);
    await wait(DEBOUNCE);
    check('quiz options are not corrected' + tag, (card(w).suggested || '').indexOf('A) recieve') !== -1, card(w).suggested);

    // Apply writes the suggestion into the composer.
    type(w, 'hey tmrw is mi exm teach me ML');
    await wait(DEBOUNCE);
    click(w, 'promptmeter-btn-accept');
    await wait(300);
    check('Apply writes the suggestion' + tag, composerText(w).trim() === 'Teach me ML', composerText(w));

    // Esc dismisses, leaves the text alone, and the card stays away.
    type(w, 'can u pls explan recursion to me thanks');
    await wait(DEBOUNCE);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(100);
    check('Esc hides the card' + tag, card(w).visible === false);
    check('Esc leaves the composer untouched' + tag,
        composerText(w).trim() === 'can u pls explan recursion to me thanks', composerText(w));
    await wait(500);
    check('the card does not come straight back' + tag, card(w).visible === false);

    // Ignore.
    type(w, 'pls explan how nural networks wrk');
    await wait(DEBOUNCE);
    click(w, 'promptmeter-btn-ignore');
    await wait(100);
    check('Ignore hides the card' + tag, card(w).visible === false);

    // Apply, then Revert restores what the user typed.
    const typed = 'i want 2 learn pyhton fast plz';
    type(w, typed);
    await wait(DEBOUNCE);
    click(w, 'promptmeter-btn-accept');
    await wait(300);
    check('Apply changed the text' + tag, composerText(w).trim() !== typed, composerText(w));
    const revert = w.document.getElementById('promptmeter-btn-revert');
    check('Revert is offered after Apply' + tag, !!revert && !revert.hidden);
    if (revert && !revert.hidden) {
        click(w, 'promptmeter-btn-revert');
        await wait(300);
        check('Revert restores the original' + tag, composerText(w).trim() === typed, composerText(w));
    }

    // Clearing the box hides the card; a bare greeting does not raise it.
    type(w, '');
    await wait(DEBOUNCE);
    check('an empty composer hides the card' + tag, card(w).visible !== true);
    type(w, 'hi');
    await wait(DEBOUNCE);
    check('a bare "hi" does not raise the card' + tag, card(w).visible !== true);

    // Pasted code survives Apply with its indentation and blank line.
    const code = 'pls fix this code' + NL + 'def add(a, b):' + NL + '    return a+b' + NL + NL + 'print(add(2, 3))';
    type(w, code);
    await wait(DEBOUNCE);
    click(w, 'promptmeter-btn-accept');
    await wait(300);
    const after = composerText(w);
    check('applied code keeps its indentation' + tag, after.indexOf('    return a+b') !== -1, after);
    check('applied code keeps every line' + tag,
        after.indexOf('def add(a, b):') !== -1 && after.indexOf('print(add(2, 3))') !== -1, after);

    const real = errors.filter((e) => !EXPECTED.test(e));
    check('no errors logged' + tag, real.length === 0, real.join(' | '));
    w.close();
}

// ---------------------------------------------------------------------------
// The popup and the dashboard
// ---------------------------------------------------------------------------
function extensionPage(file, url) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const dom = new JSDOM(html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ''),
        { runScripts: 'outside-only', pretendToBeVisual: true, url: url });
    const w = dom.window;
    const store = { isEnabled: true };
    w.chrome = chromeStub(store);
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {} }));
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    const errors = watchErrors(w);
    const dir = path.dirname(path.join(ROOT, file));
    [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].forEach((m) => {
        try {
            w.eval(fs.readFileSync(path.join(dir, m[1]), 'utf8'));
        } catch (error) {
            errors.push('LOAD ' + m[1] + ': ' + error.message);
        }
    });
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    return { w, errors, store };
}

async function testPopup() {
    const { w, errors, store } = extensionPage('popup.html', 'https://promptmeter.test/popup.html');
    await wait(200);
    const status = () => (w.document.getElementById('status-text') || {}).textContent;
    check('popup shows it is active', /active|watching/i.test(status() || ''), status());
    const toggle = w.document.getElementById('toggle-promptmeter');
    check('popup has the on/off switch', !!toggle);
    if (toggle) {
        toggle.checked = false;
        toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
        await wait(100);
        check('switching off says so', /paused/i.test(status() || ''), status());
        check('switching off is saved', store.isEnabled === false, JSON.stringify(store));
    }
    const real = errors.filter((e) => !EXPECTED.test(e));
    check('popup logs no errors', real.length === 0, real.join(' | '));
    w.close();
}

async function testDashboard() {
    // A normal origin, because jsdom gives an opaque chrome-extension:// page no
    // localStorage, while Chrome gives extension pages one.
    const { w, errors } = extensionPage('dashboard/index.html', 'https://promptmeter.test/dashboard/index.html');
    await wait(1500);
    const root = w.document.getElementById('root');
    check('dashboard renders', root && root.children.length > 0 && root.textContent.length > 50,
        root && root.textContent.slice(0, 80));
    check('dashboard shows its sections', /Overview/.test(root.textContent) && /History/.test(root.textContent),
        root.textContent.slice(0, 120));
    const real = errors.filter((e) => !EXPECTED.test(e));
    check('dashboard logs no errors', real.length === 0, real.join(' | '));
    w.close();
}

(async () => {
    console.log('Testing ' + ROOT);
    await testCard('prosemirror');
    await testCard('textarea');
    await testPopup();
    await testDashboard();
    console.log(passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
