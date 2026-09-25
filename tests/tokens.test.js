/**
 * Design token contract.
 *
 *     node tests/tokens.test.js
 *
 * utils/tokens.css is the single definition of every colour, radius and shadow the
 * extension uses. Before it, the same block was pasted into content.css, style.css and
 * dashboard/src/index.css. They agreed by luck rather than by construction, and the
 * failure mode of that kind of duplication is the nasty one: the copy that gets missed
 * still renders, just slightly wrong, on one surface, in one theme.
 *
 * These assertions are what keeps the file singular. They are cheap and they fail loudly
 * the moment somebody pastes a hex back into a component stylesheet.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOKENS = path.join(ROOT, 'utils', 'tokens.css');
const CONSUMERS = [
    'content.css',
    'style.css',
    path.join('dashboard', 'src', 'index.css'),
];

// Tokens set at runtime from JavaScript, not in any stylesheet. App.jsx writes these as
// inline custom properties on the element (per-severity and per-rating colouring), so
// they are legitimately absent from tokens.css.
const SET_FROM_JS = new Set(['--rating-color', '--rating-wash', '--pill-bg']);

// Component-scoped variables: a card variant re-points these at a status colour
// (`.rec-card.sev-warning { --rec-color: var(--rec-border-warning) }`) so one rule can
// serve every severity. They are parameters of a component, not global tokens, and a
// stylesheet is allowed to set them. Anything OUTSIDE this list that a component
// stylesheet defines is a token escaping back out of tokens.css, which is the exact
// thing this file exists to prevent -- so the list is explicit rather than a pattern.
const COMPONENT_SCOPED = new Set([
    '--rec-wash', '--rec-color', '--pill-color', '--pill-bg',
    '--rating-color', '--rating-wash',
]);

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

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const tokensCss = fs.readFileSync(TOKENS, 'utf8');

/** Every `--name:` declaration in a chunk of CSS. */
function declared(css) {
    const names = new Set();
    const pattern = /(--[\w-]+)\s*:/g;
    let match;
    while ((match = pattern.exec(css)) !== null) names.add(match[1]);
    return names;
}

/** Every `var(--name)` reference, whether or not it supplies a fallback. */
function referenced(css) {
    const names = new Set();
    const pattern = /var\(\s*(--[\w-]+)/g;
    let match;
    while ((match = pattern.exec(css)) !== null) names.add(match[1]);
    return names;
}

/**
 * Pulls out one top-level rule body by brace matching, so the dark blocks can be
 * compared against each other. A regex cannot do this: the @media wrapper nests.
 */
function ruleBody(css, selector) {
    const start = css.indexOf(selector);
    if (start === -1) return null;
    const open = css.indexOf('{', start);
    if (open === -1) return null;

    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    return null;
}

/** name -> value, for comparing two blocks declaration by declaration. */
function declarations(css) {
    const map = new Map();
    const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let match;
    while ((match = pattern.exec(css)) !== null) {
        map.set(match[1], match[2].trim().replace(/\s+/g, ' '));
    }
    return map;
}

// --- tokens.css is the only place tokens are defined ----------------------------
const defined = declared(tokensCss);
check('tokens.css defines a non-trivial set', defined.size > 50,
    'found ' + defined.size);

CONSUMERS.forEach((file) => {
    const escaped = [...declared(read(file))].filter((name) => !COMPONENT_SCOPED.has(name));
    check(file + ' defines no global tokens of its own', escaped.length === 0,
        escaped.join(', '));
});

// --- nothing references a token that does not exist -----------------------------
CONSUMERS.forEach((file) => {
    const missing = [...referenced(read(file))]
        .filter((name) => !defined.has(name) && !SET_FROM_JS.has(name));
    check(file + ' references only tokens that exist', missing.length === 0,
        missing.join(', '));
});

// --- the two dark blocks must stay identical ------------------------------------
// Dark values appear twice on purpose -- once under prefers-color-scheme for "auto"
// and once under [data-theme="dark"] for an explicit choice -- because CSS has no way
// to share a block between the two. That is the one duplication left in the file, so
// it is the one that has to be asserted.
const autoDark = ruleBody(tokensCss, '.pm-tokens:not([data-theme="light"])');
const explicitDark = ruleBody(tokensCss, '.pm-tokens[data-theme="dark"]');

check('the auto-dark block exists', autoDark !== null);
check('the explicit-dark block exists', explicitDark !== null);

if (autoDark && explicitDark) {
    const a = declarations(autoDark);
    const b = declarations(explicitDark);

    const onlyAuto = [...a.keys()].filter((k) => !b.has(k));
    const onlyExplicit = [...b.keys()].filter((k) => !a.has(k));
    check('both dark blocks cover the same tokens',
        onlyAuto.length === 0 && onlyExplicit.length === 0,
        'auto only: [' + onlyAuto.join(', ') + ']  explicit only: [' + onlyExplicit.join(', ') + ']');

    const differing = [...a.keys()]
        .filter((k) => b.has(k) && a.get(k) !== b.get(k))
        .map((k) => k + ': ' + a.get(k) + ' vs ' + b.get(k));
    check('both dark blocks carry the same values', differing.length === 0,
        differing.join('\n      '));

    // A token that has a light value but no dark one keeps the light value in dark
    // mode. That is correct for radii and durations and wrong for anything painted.
    const lightBlock = declarations(ruleBody(tokensCss, '.pm-tokens') || '');
    const painted = /color|bg-|border|shadow|wash|diff|toggle|disabled|accent|fill/;
    const unthemed = [...lightBlock.keys()]
        .filter((k) => painted.test(k) && !a.has(k) && !lightBlock.get(k).startsWith('var('));
    check('every painted token has a dark value', unthemed.length === 0,
        unthemed.join(', '));
}

// --- the surfaces actually opt in ------------------------------------------------
check('the injected card carries .pm-tokens',
    /className\s*=\s*"promptmeter-opt-card pm-tokens"/.test(read('content.js')));
check('the popup carries .pm-tokens', /<html class="pm-tokens">/.test(read('popup.html')));
check('the dashboard carries .pm-tokens',
    /<html lang="en" class="pm-tokens">/.test(read(path.join('dashboard', 'index.html'))));
check('the manifest injects tokens.css before content.css',
    read('manifest.json').indexOf('utils/tokens.css') <
    read('manifest.json').indexOf('"content.css"'));

// --- offline: nothing is fetched at paint time -----------------------------------
// PromptMeter has to work with no connection after install. A webfont link that never
// resolves does not fail loudly, it just paints in a different face at a different
// metric, so this is asserted rather than remembered.
['popup.html', path.join('dashboard', 'index.html')].forEach((file) => {
    check(file + ' loads no remote resource',
        !/https?:\/\//.test(read(file).replace(/<!--[\s\S]*?-->/g, '')),
        (read(file).match(/https?:\/\/[^"'\s]+/g) || []).join(', '));
});

// --- braces balance in every stylesheet ------------------------------------------
['utils/tokens.css'].concat(CONSUMERS).forEach((file) => {
    const css = read(file);
    let depth = 0;
    for (const ch of css) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    check(file + ' has balanced braces', depth === 0, 'depth ' + depth);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
