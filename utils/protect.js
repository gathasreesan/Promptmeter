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
        // Triple quotes delimit a passage the same way a fence does: "the passage
        // denoted by triple backticks: '''Once upon a time ...'''" had its text edited.
        { name: 'triple-single', rx: /'''[\s\S]*?(?:'''|$)/g },
        { name: 'triple-double', rx: /"""[\s\S]*?(?:"""|$)/g },
        { name: 'inline-code', rx: /`[^`\n]+`/g },

        // --- Emoticons ---------------------------------------------------------------
        // Three different stages tore these in half, each its own way: the space tidier
        // read the ":" of ":)" as a colon ("explain ml :)" -> "Explain ML: )"), the
        // leading-punctuation trim took the ":" and left the ")" (":) explain" -> ")
        // explain"), and the foreign path split the prompt at it as if it introduced a
        // payload. One mask stops all three. Only a standalone token counts -- preceded
        // by a space or the start and followed by a space or the end -- so ":)" inside
        // "f(a[1:])" or the "8)" of "(x, 8)" is never touched. The eyes are ":" and ";"
        // only: "=" and "8" are far more often an operator and a number.
        { name: 'emoticon', rx: /(?<=^|[ \t])[:;]['-^o]?[)(\]\[DPpO3|*]+(?=[ \t]|$)/gm },
        // Indented block: a run of consecutive lines each starting with 4 spaces or a tab
        { name: 'indented-code', rx: /^(?:[ ]{4,}|\t)[^\n]*(?:\n(?:[ ]{4,}|\t)[^\n]*)*/gm },

        // --- Diagnostics -----------------------------------------------------------
        { name: 'traceback', rx: /Traceback \(most recent call last\):[\s\S]*?(?=\n[ \t]*\n|$)/g },
        // A stack frame must carry a LOCATION -- "(file.js:3:9)", "(native)" or a
        // trailing ":line:col". Matching every line that merely starts with "at " masked
        // ordinary prose as program text: "at the end of the day what matters is
        // performance" was protected whole, so the optimizer could not touch a single
        // word of it and reported nothing to fix. Masking is the safe direction for
        // genuinely ambiguous text, but it is not free -- a fully masked prompt is a
        // prompt the extension silently does nothing for.
        { name: 'stack-frame', rx: /^[ \t]*at\s+\S[^\n]*?(?:\([^)\n]*\)|:\d+(?::\d+)?)[ \t]*$/gm },
        { name: 'exception', rx: /\b[A-Z]\w*(?:Error|Exception|Warning)\b[^\n]*/g },

        // --- Abbreviations ----------------------------------------------------------
        // Their dots are not sentence ends. Unmasked, "(i.e. where you were born" was
        // capitalised to "I.e. Where", split into two sentences, and the half before it
        // dropped; "e.g. use numpy" came back as "E. G. Use".
        { name: 'abbreviation', rx: /\b(?:i\.e\.|e\.g\.|etc\.|vs\.|cf\.|a\.m\.|p\.m\.|approx\.|incl\.|u\.s\.|u\.k\.|ph\.d\.|dr\.|mr\.|mrs\.|ms\.|st\.|fig\.)(?=\s|,|\)|$)/gi },

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
            rx: /\b[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|java|c|cpp|cc|h|hpp|cs|rb|go|rs|php|swift|kt|html|css|scss|json|ya?ml|toml|ini|xml|sql|sh|bash|ps1|bat|md|txt|csv|tsv|log|env|lock|pem|key|crt|cer|pfx|p12|pub|wav|mp3|mp4|mkv|mov|png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|pptx?|zip|tar|gz|rar|7z|exe|dll|so|apk|ipynb|r|dart|vue|svelte|lua|pl|scala|gradle|tf|proto|db|sqlite|parquet|pkl|h5|onnx|pt|bin|iso|dmg|msi|deb|rpm|conf|cfg|properties|jar|war|class|o|a)\b/gi
        },
        // Shell commands typed without a code fence: "!pip install transformers" became
        // "! Pip install transformers" and "msfdb init;service postgresql start" was
        // respaced and capitalised. A notebook "!cmd" line, a "$ cmd" line, a line that
        // opens with a common command, or commands chained with ";".
        { name: 'shell-line', rx: /^[ \t]*(?:[!$][ \t]?[A-Za-z][\w.+-]*|(?:sudo|pip3?|npm|npx|yarn|pnpm|git|mkdir|apt(?:-get)?|brew|docker|kubectl|gcc|g\+\+|wget|chmod|chown|ssh|scp|conda|systemctl|msfdb|msfconsole|nmap)[ \t])[^\n]*$/gm },
        // (Not "make", "cat", "touch", "echo", "export", "python", "node" ...: they open
        // ordinary English requests -- "make a 4 week workout plan".)
        // Code pasted without a fence: "int n，m，mod，ans" had "ans" expanded to "answer".
        // Lines that only code opens, or that end statements with ";" around braces or "=".
        { name: 'code-line', rx: /^[ \t]*(?:#include\b|#define\b|using\s+namespace\b|from\s+[\w.]+\s+import\b|def\s+\w+\s*\(|function\s+\w+\s*\(|(?:public|private|protected|static)\s+[\w<>\[\]]+|[^\n]*;[^\n]*[{}=][^\n]*$|[^\n]*[{}=][^\n]*;\s*$)[^\n]*$/gm },
        { name: 'command-chain', rx: /\b[\w.-]+(?:[ \t][\w.-]+)*;[\w.-]+(?:[ \t;][\w.-]+)*/g },
        // A bare extension or dot-name: "from .wav file" became "from. Wav file" and
        // ".env" ". Env" -- the dot read as a full stop and the word got a capital.
        { name: 'dot-name', rx: /(?<![\w.])\.(?=[A-Za-z])[A-Za-z0-9]{1,10}\b/g },

        // --- Material the user marked as verbatim ----------------------------------
        { name: 'double-quoted', rx: /"[^"\n]{1,300}"/g },
        { name: 'smart-quoted', rx: /“[^”\n]{1,300}”/g },
        // Single quotes too: "correct my sentence: 'Ich habe gestern...'" had "habe"
        // corrected to "have", and a passage sent for proofreading was proofread
        // before the model saw it. Not touching a letter on the outside, so the
        // apostrophes in "it's" and "students' books" are never taken for quotes.
        { name: 'single-quoted', rx: /(?<![\w'’])'[^'\n]{3,300}'(?![\w'’])/g },

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
        { name: 'camel-case', rx: /\b[a-z]+[A-Z][\w]*\b/g },

        // --- Code inside a line that reads as prose ---------------------------------
        // LAST on purpose: every pattern above takes precedence. code-line starts its
        // SQL run at the SELECT line, and taking that line first lost the statement's ";".
        // The line-based block detector lets a sentence-like line break a run, which is
        // right for prose and wrong for these two:
        //   'findstr /C:" " >nul && echo This script relies on Miniconda which ...'
        //     -- ">nul" was corrected to ">null", which writes a file called null;
        //   'what this ORACLE SQL query does? SELECT P.CUENTA, S.IMEI ... FROM ...'
        //     -- "SELECT" was recased to "Select".
        // SQL needs an UPPERCASE keyword and a second clause keyword later on the same
        // line, so "select the best answer" is prose and "SELECT THE BEST ANSWER FROM
        // THE LIST" is merely left as typed -- the safe direction.
        { name: 'null-device', rx: /[12]?>>?\s*nul\b/gi },
        // The WHOLE statement, across lines, through its ";" or to a blank line or the
        // end: masking only the first line exposed the closing ";" to the tidy that
        // strips trailing punctuation.
        { name: 'sql-inline', rx: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b(?=[^;]*?\b(?:FROM|INTO|SET|WHERE|VALUES|TABLE)\b)[\s\S]*?(?:;|(?=\n[ \t]*\n)|$)/g },
    ],

    // A line that looks like program text rather than prose. Deliberately broad: the
    // block rule below only fires when most lines in a run qualify, so a single false
    // positive cannot protect a paragraph of English.
    // The last four alternatives were missing, and each left a familiar language out:
    //   #include / #define / #!     a C file's first line, or a script's shebang
    //   <tag ...> and </tag>        HTML -- "<div>" lines broke the run, and the
    //                               indentation between them was collapsed
    //   @echo, %~dp0, >nul, rem ... Windows batch: "cd" was capitalised and ">nul"
    //                               corrected to ">null", which creates a file
    //   cd /d, goto, pause, ...
    CODE_LINE: /(?:[{}();]\s*$|^\s*[}\])]|=>|:=|==|!=|\+\+|--|^\s*(?:function|const|let|var|class|def|return|if|else|elif|for|while|switch|case|try|catch|except|import|from|public|private|static|void|int|string|bool|async|await|package|use|fn|impl|struct|enum)\b|^\s*[\w$.]+\s*=[^=]|^\s*[-*]\s|^\s{2,}[\w$"'#.@<-]|^\s*#(?:include|define|undef|ifn?def|if|elif|endif|pragma|!)|^\s*<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|^\s*@\w|%~[a-z]*\d|%\w+%|>\s*nul\b|^\s*(?:rem|setlocal|endlocal|pause|goto|cls)\b|^\s*cd\s+\/d\b)/i,

    // A line that is plainly prose, whatever else it contains. A run is not code when
    // it is made of sentences.
    PROSE_LINE: /^[^\n]*[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}[^\n]*[.!?]?\s*$/i,

    // Minimum consecutive code-shaped lines before a run counts as a block.
    MIN_CODE_BLOCK_LINES: 2,

    /**
     * Masks runs of consecutive lines that are mostly program text.
     *
     * Kept out of the pattern table because the test is proportional -- "most lines in
     * this run look like code" -- which a regex cannot express. Without it a prompt that
     * pastes code with no fence and a two-space indent defeats the whole pipeline: the
     * indented-code pattern needs four spaces, so nothing is masked, isCodeSnippet()
     * then reads the entire prompt as code, and optimizePrompt returns it untouched.
     * The filler around the snippet is never stripped.
     *
     * @param {string} text - Text, already partly masked.
     * @param {Array} spans - Span table, appended to in place.
     * @returns {string} Text with code runs replaced by placeholders.
     */
    maskCodeBlocks: function (text, spans) {
        if (text.indexOf('\n') === -1) return text;

        const lines = text.split('\n');
        const out = [];
        let index = 0;

        while (index < lines.length) {
            if (!this.CODE_LINE.test(lines[index]) || this.PROSE_LINE.test(lines[index])) {
                out.push(lines[index]);
                index += 1;
                continue;
            }

            // Extend the run over code-shaped lines, allowing a blank line inside a block
            // but never ending on one.
            let end = index;
            let last = index;
            while (end < lines.length) {
                const line = lines[end];
                if (line.trim() === '') { end += 1; continue; }
                if (!this.CODE_LINE.test(line) || this.PROSE_LINE.test(line)) break;
                last = end;
                end += 1;
            }

            const run = lines.slice(index, last + 1);
            if (run.length < this.MIN_CODE_BLOCK_LINES) {
                out.push(lines[index]);
                index += 1;
                continue;
            }

            spans.push(run.join('\n'));
            out.push(`${this.MASK_OPEN}${spans.length - 1}${this.MASK_CLOSE}`);
            index = last + 1;
        }

        return out.join('\n');
    },
    /**
     * Replaces every protected span with a placeholder.
     * @param {string} text - The raw prompt.
     * @returns {Object} { masked, spans } where spans[i] is the original text of placeholder i.
     */
    /**
     * Masks the answer options of a multiple-choice question, verbatim.
     *
     * Options are DATA, not the user's prose, and correcting them changes the question.
     * "Which word is spelled correctly? A) recieve B) receive C) receeve" came back with
     * all three options spelled "receive" -- the quiz destroyed, every answer now right.
     * "Select the sentence with the correct capitalization. A) i love reading books ..."
     * had its "i" capitalised, which made option A correct. And an option line opening
     * with a quote ('"A) i love ...') was pruned outright as a fragment.
     *
     * LETTER markers only -- A) (a) A. A: -- and only when there are at least two of
     * them, either one per line or several on a single line. A digit-numbered list is
     * steps or items the user wrote and wants tidied; a lettered list is answer choices
     * far more often than not. Over-masking is the safe direction here: a masked line is
     * merely left as typed.
     *
     * @param {string} text
     * @param {Array} spans - The span table; masked lines are appended to it.
     * @returns {string}
     */
    maskAnswerOptions: function (text, spans) {
        const NL = String.fromCharCode(10);
        const LINE = /^[ \t]*["'“‘]?(?:\(([A-Za-z])\)|([A-Za-z])[).:])[ \t]+\S/;
        const lines = text.split(NL);
        const marked = lines.map((line) => {
            const hit = LINE.exec(line);
            return hit ? (hit[1] || hit[2]).toLowerCase() : null;
        });
        const letters = new Set(marked.filter(Boolean));
        const wrap = (span) => {
            spans.push(span);
            return this.MASK_OPEN + (spans.length - 1) + this.MASK_CLOSE;
        };
        // Several options on one line: "Which is correct: A) recieve B) receive".
        const INLINE = /(?:^|[\s"'“(])\(?[A-Ea-e]\)[ \t]+\S/g;
        return lines.map((line, i) => {
            if (this.isOnlyPlaceholder(line.trim())) return line;
            if (letters.size >= 2 && marked[i]) {
                const lead = (/^[ \t]*/.exec(line) || [''])[0];
                return lead + wrap(line.slice(lead.length));
            }
            // The first option can share a line with the question: 'Select the correct
            // one. "A) i love reading books' -- with B) and C) on the lines below. Once a
            // block of options exists, an option opening mid-line is masked from its
            // marker (and any quote in front of it) to the end of the line.
            if (letters.size >= 2) {
                const mid = /\s(["'“‘]?\(?[A-Za-z]\)[ \t]+\S)/.exec(line);
                if (mid) {
                    const at = mid.index + 1;
                    return line.slice(0, at) + wrap(line.slice(at));
                }
            }
            const inline = line.match(INLINE);
            if (inline && inline.length >= 2) {
                const at = line.search(/\(?[A-Ea-e]\)[ \t]+\S/);
                return line.slice(0, at) + wrap(line.slice(at));
            }
            return line;
        }).join(NL);
    },

    mask: function (text) {
        const spans = [];
        // Before the pattern table: a code block is the largest construct here, and
        // letting camel-case or call patterns nibble at its insides first would leave
        // the block unrecognisable as a run.
        let masked = this.maskCodeBlocks(text, spans);
        masked = this.maskAnswerOptions(masked, spans);

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
