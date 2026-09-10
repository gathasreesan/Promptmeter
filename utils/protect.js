/**
 * PromptMeter Protected Span Registry
 *
 * Some text must survive optimization byte for byte: source code, URLs, file paths,
 * quoted material, identifiers, error output. This module finds those spans and swaps
 * them for opaque placeholders before any rewriting happens, then restores them
 * afterwards.
 *
 * Placeholders use Unicode private-use characters (U+E000/U+E001). No rewriting rule
 * can match them: they are not word characters, not whitespace, and not punctuation, so
 * \b, \w and \s based patterns step straight over them.
 */
const PromptMeterProtect = {
    MASK_OPEN: '\uE000',
    MASK_CLOSE: '\uE001',
    MASK_RX: /\uE000(\d+)\uE001/g,

    // Dotted sequences that are ordinary prose rather than code paths.
    DOTTED_STOPLIST: new Set([
        'e.g', 'i.e', 'a.m', 'p.m', 'etc', 'vs', 'u.s', 'u.k', 'u.s.a',
        'dr', 'mr', 'mrs', 'ms', 'st', 'jr', 'sr', 'no', 'fig', 'approx'
    ]),

    /**
     * Ordered list of things never to rewrite. Earlier patterns win, so the largest and
     * most explicit constructs (fenced code, URLs) are masked before the narrower
     * identifier patterns get a chance to bite into them.
     *
     * `guard` optionally rejects a match that the regex alone cannot distinguish from
     * ordinary prose.
     */
    patterns: [
        // --- Explicit code markers -------------------------------------------------
        { name: 'fenced-code', rx: /```[\s\S]*?```/g },
        { name: 'fenced-code-tilde', rx: /~~~[\s\S]*?~~~/g },
        { name: 'inline-code', rx: /`[^`\n]+`/g },
        // Indented block: a run of consecutive lines each starting with 4 spaces or a tab
        { name: 'indented-code', rx: /^(?:[ ]{4,}|\t)[^\n]*(?:\n(?:[ ]{4,}|\t)[^\n]*)*/gm },

        // --- Diagnostics -----------------------------------------------------------
        { name: 'traceback', rx: /Traceback \(most recent call last\):[\s\S]*?(?=\n[ \t]*\n|$)/g },
        { name: 'stack-frame', rx: /^[ \t]*at\s+\S[^\n]*$/gm },
        { name: 'exception', rx: /\b[A-Z]\w*(?:Error|Exception|Warning)\b[^\n]*/g },

        // --- Locators --------------------------------------------------------------
        { name: 'url', rx: /\b(?:https?|ftp|file|ws|wss):\/\/[^\s<>"']+/gi },
        { name: 'bare-domain', rx: /\bwww\.[^\s<>"']+/gi },
        { name: 'email', rx: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
        { name: 'windows-path', rx: /\b[A-Za-z]:\\[^\s"'<>|]*/g },
        { name: 'unix-path', rx: /(?<=^|[\s(])(?:~|\.{1,2})?\/[\w.\-]+(?:\/[\w.\-]+)*\/?/gm },
        // Relative paths ("src/app/main.py"). The final segment must carry a file
        // extension, which keeps ordinary prose like "and/or" or "he/she" out.
        { name: 'relative-path', rx: /\b[\w.-]+(?:\/[\w.-]+)*\/[\w-]+\.\w{1,6}\b/g },
        {
            name: 'filename',
            rx: /\b[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|java|c|cpp|cc|h|hpp|cs|rb|go|rs|php|swift|kt|html|css|scss|json|ya?ml|toml|ini|xml|sql|sh|bash|ps1|bat|md|txt|csv|tsv|log|env|lock)\b/gi
        },

        // --- Material the user marked as verbatim ----------------------------------
        { name: 'double-quoted', rx: /"[^"\n]{1,300}"/g },
        { name: 'smart-quoted', rx: /“[^”\n]{1,300}”/g },

        // --- Templates, variables, flags -------------------------------------------
        { name: 'handlebars', rx: /\{\{[^}\n]+\}\}/g },
        { name: 'shell-interp', rx: /\$\{[^}\n]+\}/g },
        { name: 'windows-env', rx: /%[A-Za-z_][A-Za-z0-9_]*%/g },
        { name: 'shell-var', rx: /\$[A-Za-z_][A-Za-z0-9_]*\b/g },
        { name: 'cli-flag', rx: /(?<=^|\s)--?[A-Za-z][\w-]*/gm },

        // --- Literals --------------------------------------------------------------
        { name: 'uuid', rx: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
        { name: 'version', rx: /\bv?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/g },
        { name: 'hex-literal', rx: /\b0[xX][0-9a-fA-F]+\b/g },
        // A long run of hex digits is only a hash if it actually contains a digit,
        // otherwise words like "defaced" would qualify.
        { name: 'hash', rx: /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g },
        {
            name: 'measurement',
            rx: /\b\d+(?:\.\d+)?\s?(?:ms|ns|us|kb|mb|gb|tb|hz|khz|mhz|ghz|px|em|rem|vh|vw|kg|mg|lb|km|cm|mm|mi|ft|in)\b/gi
        },

        // --- Markup ----------------------------------------------------------------
        { name: 'tag', rx: /<\/?[A-Za-z][\w.-]*(?:\s[^<>\n]*)?\/?>/g },

        // --- Code-shaped identifiers -----------------------------------------------
        // No space before the parenthesis, so ordinary parentheticals stay editable.
        { name: 'call', rx: /\b[A-Za-z_$][\w$]*\((?:[^()\n]{0,120})\)/g },
        {
            name: 'dotted-path',
            rx: /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]+)+\b/g,
            guard: function (match) {
                return match.length >= 6 && !PromptMeterProtect.DOTTED_STOPLIST.has(match.toLowerCase());
            }
        },
        { name: 'snake-case', rx: /\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b/g },
        { name: 'camel-case', rx: /\b[a-z]+[A-Z][\w]*\b/g }
    ],

    /**
     * Replaces every protected span with a placeholder.
     * @param {string} text - The raw prompt.
     * @returns {Object} { masked, spans } where spans[i] is the original text of placeholder i.
     */
    mask: function (text) {
        const spans = [];
        let masked = text;

        for (const pattern of this.patterns) {
            pattern.rx.lastIndex = 0;
            masked = masked.replace(pattern.rx, (match) => {
                // A match may legitimately contain an earlier placeholder -- a greedy
                // line-consuming rule like the exception matcher will swallow one that
                // sits on the same line. Refusing those outright left the whole span
                // unprotected, so only a match that is nothing but a placeholder is
                // rejected (re-wrapping it would add a level of indirection for nothing).
                if (this.isOnlyPlaceholder(match)) return match;
                if (pattern.guard && !pattern.guard(match)) return match;

                spans.push(match);
                return `${this.MASK_OPEN}${spans.length - 1}${this.MASK_CLOSE}`;
            });
        }

        return { masked: masked, spans: spans };
    },

    /**
     * Restores placeholders to their original text.
     * @param {string} text - Text containing placeholders.
     * @param {Array} spans - The span table produced by mask().
     * @returns {string} Text with every protected span put back verbatim.
     */
    unmask: function (text, spans) {
        if (spans.length === 0) return text;

        // Spans can nest, so resolve repeatedly until none are left. Each pass reveals
        // only lower-numbered placeholders, so this always terminates; the cap is a
        // guard against a malformed span table rather than an expected case.
        let out = text;
        for (let pass = 0; pass < 12 && out.indexOf(this.MASK_OPEN) !== -1; pass++) {
            out = out.replace(this.MASK_RX, (placeholder, index) => {
                const span = spans[parseInt(index, 10)];
                return span !== undefined ? span : placeholder;
            });
        }
        return out;
    },

    /**
     * True when a match consists solely of a placeholder.
     * @param {string} text - A candidate match.
     * @returns {boolean}
     */
    isOnlyPlaceholder: function (text) {
        return /^\uE000\d+\uE001$/.test(text);
    },

    /**
     * The editable prose left once protected spans are removed.
     * @param {string} masked - Output of mask().
     * @returns {string} Text with all placeholders stripped.
     */
    strip: function (masked) {
        return masked.replace(this.MASK_RX, '').trim();
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterProtect = PromptMeterProtect;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterProtect };
}
