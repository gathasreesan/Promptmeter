/**
 * The injected card has to survive being short.
 *
 *     node tests/layout.test.js
 *
 * content.js sizes the card to the gap above the composer and floors that at
 * CARD_MIN_HEIGHT. A long prompt being typed pushes the composer up, which is exactly
 * when the card matters most and exactly when it has least room.
 *
 * Everything between the header and the buttons used to be `flex: 0 0 auto`, which never
 * shrinks, and the diff could not absorb the shortfall either: a flex item defaults to
 * `min-height: auto`, so it will not go below its content height however its overflow is
 * set. The card overflowed, `overflow: hidden` clipped the bottom, and what got clipped
 * was the row holding Apply. The card was visible and the button was not reachable.
 *
 * Checked structurally rather than by rendering. There is no browser in this session,
 * and "does the action row survive" is a question about flex declarations, which are
 * readable from the stylesheet. This does not replace looking at the thing; it catches
 * the class of fault that put the buttons off-screen.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
    }
}

/**
 * Every declaration block whose selector list mentions this class, concatenated in
 * source order so the last value wins the way the cascade would resolve it.
 */
/**
 * Every declaration block in the stylesheet, as { selector, body } pairs.
 *
 * A real walk rather than a brace regex. content.css nests rules inside @media, and
 * both the flat regex and "strip the @media prelude" are wrong: the first desynchronises
 * on the wrapper, the second leaves the wrapper's closing brace behind and mis-pairs
 * every rule after it. Either way most of the file silently disappears, and a test that
 * cannot see a rule reports it as missing.
 */
function parseRules(css) {
    const out = [];
    const stack = [];
    let prelude = '';
    let body = '';
    let depth = 0;

    for (let i = 0; i < css.length; i++) {
        const ch = css[i];

        if (ch === '{') {
            stack.push(prelude.trim());
            prelude = '';
            body = '';
            depth++;
            continue;
        }

        if (ch === '}') {
            const opened = stack.pop();
            depth--;
            // A block containing declarations rather than nested rules. At-rule
            // wrappers hold rules and fall out here with an empty body, which is right.
            if (body.indexOf(':') !== -1 && opened && opened[0] !== '@') {
                out.push({ selector: opened, body: body });
            }
            body = '';
            prelude = '';
            continue;
        }

        if (depth > 0) body += ch;
        else prelude += ch;
    }

    return out;
}

// Comments come off first. Without this a rule's selector is whatever text preceded
// its brace, which in this file is usually a paragraph of explanation.
const RULES = parseRules(CSS.replace(/\/\*[\s\S]*?\*\//g, ' '));

/**
 * Every declaration for a class, in source order, so the last value wins the way the
 * cascade would resolve it.
 */
function declarationsFor(className) {
    return RULES
        .filter((rule) => rule.selector.split(',')
            .map((sel) => sel.trim())
            .some((sel) => sel === className
                || sel.endsWith(' ' + className)
                || sel.startsWith(className + ':')
                || sel.startsWith(className + '.')))
        .map((rule) => rule.body)
        .join(';');
}

function property(className, name) {
    const found = [...declarationsFor(className)
        .matchAll(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'g'))];
    return found.length ? found[found.length - 1][1].trim() : null;
}

// --- the panels between the header and the buttons --------------------------------
// Each one is optional and each one can be several lines. They must give way before
// the diff does, and scroll themselves rather than pushing anything off the card.
const PANELS = [
    '.promptmeter-opt-headroom',
    '.promptmeter-opt-preserve',
    '.promptmeter-opt-scope',
    '.promptmeter-opt-grammar'
];

PANELS.forEach((selector) => {
    const flex = property(selector, 'flex');
    check(selector + ' may shrink', flex !== null && /^0\s+1\s/.test(flex),
        'flex: ' + flex);
    check(selector + ' can go below its content height',
        property(selector, 'min-height') === '0',
        'min-height: ' + property(selector, 'min-height'));
    check(selector + ' scrolls instead of pushing',
        /auto|scroll/.test(property(selector, 'overflow-y') || ''),
        'overflow-y: ' + property(selector, 'overflow-y'));
    check(selector + ' is capped so it cannot eat the card',
        property(selector, 'max-height') !== null);
});

// --- the diff absorbs the slack ---------------------------------------------------
check('the diff takes the remaining space',
    /^1\s+1\s/.test(property('.promptmeter-opt-diff', 'flex') || ''),
    'flex: ' + property('.promptmeter-opt-diff', 'flex'));
check('the diff can shrink below its content -- min-height: 0 is what makes '
    + 'overflow-y actually work on a flex item',
    property('.promptmeter-opt-diff', 'min-height') === '0',
    'min-height: ' + property('.promptmeter-opt-diff', 'min-height'));
check('the diff scrolls',
    /auto|scroll/.test(property('.promptmeter-opt-diff', 'overflow-y') || ''));

// --- the buttons never give way ---------------------------------------------------
check('the action row never shrinks',
    /^0\s+0\s/.test(property('.promptmeter-opt-actions', 'flex') || ''),
    'flex: ' + property('.promptmeter-opt-actions', 'flex'));
check('the header never shrinks',
    /^0\s+0\s/.test(property('.promptmeter-opt-header', 'flex') || ''),
    'flex: ' + property('.promptmeter-opt-header', 'flex'));

// --- the card itself ---------------------------------------------------------------
check('the card is a column', property('.promptmeter-opt-card', 'flex-direction') === 'column');
check('the card clips its own corners',
    property('.promptmeter-opt-card', 'overflow') === 'hidden');

// --- the floor the JS enforces has to fit what cannot shrink ----------------------
const floorMatch = /CARD_MIN_HEIGHT\s*=\s*(\d+)/.exec(JS);
check('CARD_MIN_HEIGHT is defined in content.js', floorMatch !== null);
if (floorMatch) {
    const floor = Number(floorMatch[1]);
    // Header text + its margin + the button row + the card's own padding. Generous
    // rather than exact: the point is that the floor is above it, not by how much.
    const irreducible = 30 + 12 + 36 + 32;
    check('the floor leaves room for the header and the buttons',
        floor > irreducible,
        floor + 'px floor against ' + irreducible + 'px that cannot shrink');
}

// Every panel the renderer can show must be one this file knows about. A new panel
// added without a flex rule is the exact fault that clipped the buttons.
const rendered = [...JS.matchAll(/class="(promptmeter-opt-[a-z]+)"/g)]
    .map((m) => '.' + m[1]);
// Text spans inside the header are not flex children of the card and need no rule.
const known = PANELS.concat(['.promptmeter-opt-card', '.promptmeter-opt-header',
    '.promptmeter-opt-diff', '.promptmeter-opt-actions', '.promptmeter-opt-metrics',
    '.promptmeter-opt-title', '.promptmeter-opt-btn']);
const unaccounted = [...new Set(rendered)].filter((selector) => known.indexOf(selector) === -1);
check('every rendered card panel has a declared flex behaviour',
    unaccounted.length === 0, unaccounted.join(', '));

// ---------------------------------------------------------------------------
// Spacing comes off the scale, not off the cuff.
//
// The card read as cramped, and the cause was not only that the gaps were small: there
// were nine different ones -- 5, 6, 7, 8, 9, 10, 12, 14, 16 -- each chosen on its own.
// Nothing aligned with anything else, so even the generous gaps looked accidental.
// A tenth arbitrary value undoes that quietly, which is what this catches.
// ---------------------------------------------------------------------------
const SPACING_PROPERTIES = ['padding', 'padding-top', 'padding-bottom', 'padding-left',
    'padding-right', 'margin', 'margin-top', 'margin-bottom', 'margin-left',
    'margin-right', 'gap', 'row-gap', 'column-gap'];

// Values a gap may hold without naming a step: zero, auto, and the 1-2px used inside a
// chip, which sits on a caption line and would look wrong at a full step.
const ALLOWED_LITERALS = /^(0|auto|none|inherit|[12]px)$/;

const chr10 = String.fromCharCode(10);
const offenders = [];
RULES.forEach((rule) => {
    if (rule.selector.indexOf('promptmeter') === -1) return;
    SPACING_PROPERTIES.forEach((property) => {
        const found = [...rule.body.matchAll(
            // Doubled backslashes: in a string literal '\s' is plain "s", so the
            // single-backslash version matched nothing and the scan silently passed.
            new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'g'))];
        found.forEach((match) => {
            const value = match[1].trim();
            if (value.indexOf('var(--space-') !== -1) return;
            if (value.indexOf('calc(') !== -1 && value.indexOf('--space-') !== -1) return;
            const parts = value.split(/\s+/);
            if (parts.every((part) => ALLOWED_LITERALS.test(part))) return;
            offenders.push(rule.selector.replace(/\s+/g, ' ').slice(0, 44)
                + ' { ' + property + ': ' + value + ' }');
        });
    });
});

check('every gap in the card names a step on the scale',
    offenders.length === 0, offenders.join(chr10 + '      '));

// The scale itself has to exist and be evenly stepped, or naming a step means nothing.
const TOKENS = fs.readFileSync(path.join(ROOT, 'utils', 'tokens.css'), 'utf8');
const steps = [1, 2, 3, 4, 5, 6].map((n) => {
    // Doubled backslashes: this is a string literal, so '\s' would be plain "s".
    const hit = new RegExp('--space-' + n + '\\s*:\\s*(\\d+)px').exec(TOKENS);
    return hit ? Number(hit[1]) : null;
});
check('the scale defines six steps', steps.every((value) => value !== null),
    JSON.stringify(steps));
if (steps.every((value) => value !== null)) {
    check('the steps are a 4px progression',
        steps.every((value, index) => value === 4 * (index + 1)), JSON.stringify(steps));
}

// Rows in a list need space between them. Four findings flush against each other read
// as one block of text, which is most of what "cramped" meant.
const rowGap = property('.promptmeter-grammar-list li + li', 'margin-top');
check('correction rows are separated', rowGap !== null && rowGap.indexOf('--space-') !== -1,
    'margin-top: ' + rowGap);

// ---------------------------------------------------------------------------
// preview.html must still resemble the card.
//
// The file's own header says "when showOptimizationCard() changes, change it here as
// well" and then admits nothing checks that it happened. So a restyle could pass every
// test while the one page a person opens to LOOK at the card rendered markup the
// extension no longer emits -- which is worse than no preview, because it looks
// authoritative. Class names are the contract: if the card renders a class, the preview
// has to use it.
// ---------------------------------------------------------------------------
const PREVIEW = fs.readFileSync(path.join(ROOT, 'preview.html'), 'utf8');

// Every promptmeter class the card renders, minus the ones set from JS after render
// (state and severity), which the preview has no reason to carry.
const STATEFUL = /^promptmeter-(?:severity|headroom|keep|preserve|scope|opt-card)/;
const cardClasses = new Set();
[...JS.matchAll(/class="(promptmeter-[^"$]*)"/g)].forEach((match) => {
    match[1].split(/\s+/).forEach((name) => {
        if (name && !STATEFUL.test(name)) cardClasses.add(name);
    });
});
const missing = [...cardClasses].filter((name) => PREVIEW.indexOf(name) === -1);
check('preview.html uses every class the card renders (' + cardClasses.size + ' checked)',
    missing.length === 0, 'preview is missing: ' + missing.join(', '));

// ---------------------------------------------------------------------------
// The restyle's own structure.
// ---------------------------------------------------------------------------
// One figure carries the saving. It used to be an 11px chip among four other 11px
// chips, so the number the card exists to show had no more weight than the mode label.
const heroSize = property('.promptmeter-hero-value', 'font-size');
check('the saving is the largest figure on the card',
    heroSize !== null && parseInt(heroSize, 10) >= 20, 'font-size: ' + heroSize);
check('the saving uses tabular numerals so it does not jog as it changes',
    (property('.promptmeter-hero-value', 'font-variant-numeric') || '').indexOf('tabular') !== -1);

// Each half of the diff is named in words. Colour alone is not a label -- and the
// original used to be painted in the error wash, which said the user had done something
// wrong rather than that this was their text.
check('both halves of the diff are labelled in words',
    (PREVIEW.match(/promptmeter-diff-label/g) || []).length >= 2
    && JS.indexOf('promptmeter-diff-label') !== -1);
const originalBg = property('.promptmeter-diff-original', 'background');
check('the original is a recessed surface, not an error',
    originalBg !== null && originalBg.indexOf('--surface-sunken') !== -1,
    'background: ' + originalBg);

// Esc closes the card, and the listener is torn down with it. Left attached it would
// swallow an Esc the host page wanted, on every page load, for the rest of the session.
check('Esc dismisses the card', /key\s*!==\s*'Escape'/.test(JS));
check('the Esc listener is removed when the card hides',
    /removeEventListener\('keydown'/.test(JS));
check('dismissing with Esc and with Ignore do the same thing',
    /btn-ignore"\)\.onclick = dismiss/.test(JS));
// Enter must NOT be bound: it is how these pages send a message.
check('Enter is not bound', !/key\s*===\s*'Enter'/.test(JS));

// A hint for a shortcut that does nothing is worse than no hint, so the only key named
// on a control is the only one that works.
const hinted = [...JS.matchAll(/promptmeter-btn-key[^>]*>([^<]+)</g)].map((m) => m[1].trim());
check('the only keyboard hint shown is one that works',
    hinted.every((key) => key.toLowerCase() === 'esc'), hinted.join(', '));

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
