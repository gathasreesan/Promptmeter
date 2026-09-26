/**
 * Colour contrast across both themes.
 *
 *     node tests/contrast.test.js
 *
 * Every text colour in utils/tokens.css is checked against the surfaces it is actually
 * painted on, in light and dark, against the WCAG 2.1 thresholds:
 *
 *     4.5:1  normal text
 *     3.0:1  large text (>= 18.66px bold or 24px), and UI component boundaries
 *
 * This exists because the UI has never been looked at. Contrast is the one class of
 * visual defect that does not need eyes -- it is arithmetic on the token values -- so it
 * is the part of "does this look right" that can be settled here rather than guessed at.
 * It says nothing about spacing, alignment or whether the thing is pleasant to use.
 *
 * The pairs below are written by hand rather than derived, because which colour lands on
 * which surface is a fact about the stylesheets, not about the token names. A pair that
 * stops being real should be deleted from this list; a new one should be added.
 */

const fs = require('fs');
const path = require('path');

const TOKENS = fs.readFileSync(
    path.join(__dirname, '..', 'utils', 'tokens.css'), 'utf8');

let passed = 0;
let failed = 0;
const warnings = [];

function check(name, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
    }
}

/**
 * Pulls one theme's token values out of tokens.css by brace matching.
 * @param {string} selector - The rule to read.
 * @returns {Object} token name -> value
 */
function themeValues(selector) {
    const start = TOKENS.indexOf(selector);
    if (start === -1) return {};
    const open = TOKENS.indexOf('{', start);

    let depth = 0;
    let end = -1;
    for (let i = open; i < TOKENS.length; i++) {
        if (TOKENS[i] === '{') depth++;
        else if (TOKENS[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }

    const body = TOKENS.slice(open + 1, end);
    const values = {};
    const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
        values[match[1]] = match[2].trim();
    }
    return values;
}

const LIGHT = themeValues('.pm-tokens {');
const DARK = themeValues('.pm-tokens[data-theme="dark"]');

check('light theme parsed', Object.keys(LIGHT).length > 40, Object.keys(LIGHT).length + ' tokens');
check('dark theme parsed', Object.keys(DARK).length > 30, Object.keys(DARK).length + ' tokens');

// --- colour maths ----------------------------------------------------------------

/** #rgb / #rrggbb / rgba(...) -> {r,g,b,a}. Returns null for anything else. */
function parseColour(value) {
    if (!value) return null;
    const text = value.trim();

    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const digits = hex[1].length === 3
            ? hex[1].split('').map((c) => c + c).join('')
            : hex[1];
        return {
            r: parseInt(digits.slice(0, 2), 16),
            g: parseInt(digits.slice(2, 4), 16),
            b: parseInt(digits.slice(4, 6), 16),
            a: 1,
        };
    }

    const rgba = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i);
    if (rgba) {
        return {
            r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]),
            a: rgba[4] === undefined ? 1 : Number(rgba[4]),
        };
    }
    return null;
}

/** Composites a possibly-translucent colour over an opaque backdrop. */
function flatten(colour, backdrop) {
    if (colour.a >= 1) return colour;
    const mix = (c, b) => c * colour.a + b * (1 - colour.a);
    return {
        r: mix(colour.r, backdrop.r),
        g: mix(colour.g, backdrop.g),
        b: mix(colour.b, backdrop.b),
        a: 1,
    };
}

/** WCAG relative luminance. */
function luminance(colour) {
    const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

function ratio(foreground, background) {
    const a = luminance(foreground);
    const b = luminance(background);
    const light = Math.max(a, b);
    const dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
}

// --- the pairs that are actually painted -------------------------------------------
// [foreground token, background token, minimum ratio, what it is]
const PAIRS = [
    ['--text-primary', '--bg-card', 4.5, 'body text on a card'],
    ['--text-primary', '--bg-primary', 4.5, 'body text on the page'],
    ['--text-primary', '--bg-secondary', 4.5, 'body text on a panel'],
    ['--text-secondary', '--bg-card', 4.5, 'secondary text on a card'],
    ['--text-secondary', '--bg-primary', 4.5, 'secondary text on the page'],
    ['--text-muted', '--bg-card', 4.5, 'captions on a card'],
    ['--text-muted', '--bg-primary', 4.5, 'captions on the page'],
    ['--text-muted', '--bg-secondary', 4.5, 'captions on a panel'],

    // The card's metric row, which is the densest small text in the product.
    ['--text-muted', '--bg-card', 4.5, 'card metrics'],

    // Buttons: label on fill.
    ['--on-accent', '--btn-primary', 4.5, 'primary button label'],
    ['--on-accent', '--btn-primary-hover', 4.5, 'primary button label, hovered'],
    ['--text-primary', '--btn-secondary', 4.5, 'secondary button label'],
    ['--text-primary', '--btn-secondary-hover', 4.5, 'secondary button label, hovered'],

    // The diff preview on the card.
    ['--diff-removed-text', '--bg-card', 4.5, 'removed text in the diff'],
    ['--diff-added-text', '--bg-card', 4.5, 'added text in the diff'],

    // Status colours used as text.
    ['--color-primary', '--bg-card', 4.5, 'brand green as text'],
    ['--color-error', '--bg-card', 4.5, 'error text'],
    ['--color-success', '--bg-card', 4.5, 'success text'],
    ['--color-carbon', '--bg-card', 4.5, 'carbon figure'],

    // Non-text: borders and separators only need 3:1 as component boundaries.
    ['--border-color', '--bg-card', 1.2, 'card border (informational)'],
];

[['light', LIGHT], ['dark', DARK]].forEach((pair) => {
    const themeName = pair[0];
    const theme = pair[1];
    // Dark redefines only what changes; anything absent inherits the light value.
    const resolve = (token) => theme[token] || LIGHT[token];

    PAIRS.forEach((spec) => {
        const fgToken = spec[0];
        const bgToken = spec[1];
        const minimum = spec[2];
        const label = spec[3];

        const fgRaw = resolve(fgToken);
        const bgRaw = resolve(bgToken);
        const fg = parseColour(fgRaw);
        const bg = parseColour(bgRaw);

        if (!fg || !bg) {
            check(themeName + ': ' + label + ' has parseable colours', false,
                fgToken + '=' + fgRaw + '  ' + bgToken + '=' + bgRaw);
            return;
        }

        const backdrop = parseColour(resolve('--bg-card')) || { r: 255, g: 255, b: 255, a: 1 };
        const value = ratio(flatten(fg, backdrop), flatten(bg, backdrop));

        const name = themeName + ': ' + label + ' (' + fgToken + ' on ' + bgToken + ')';
        check(name, value >= minimum, value.toFixed(2) + ':1, needs ' + minimum + ':1');

        // Anything that clears AA but not AAA is worth knowing about without failing.
        if (value >= minimum && minimum === 4.5 && value < 7) {
            warnings.push('  ' + themeName.padEnd(5) + ' ' + value.toFixed(2)
                + ':1  ' + label + '  (AA, below AAA)');
        }
    });
});

// --- the two dark blocks must agree, or one theme silently drifts -----------------
const AUTO_DARK = themeValues('.pm-tokens:not([data-theme="light"])');
const differing = Object.keys(AUTO_DARK).filter((k) => DARK[k] !== AUTO_DARK[k]);
check('both dark blocks carry identical values', differing.length === 0,
    differing.join(', '));

if (warnings.length) {
    console.log('\nAA but not AAA (informational, not failures):');
    warnings.forEach((line) => console.log(line));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
