/**
 * PromptMeter semantic compression.
 *
 * Generates several rewrites of a prompt at different aggressiveness, checks each one
 * against the original, and returns the shortest that survives. If none survives, the
 * original is returned unchanged -- a prompt that was not compressed costs tokens, and a
 * prompt that was compressed wrongly costs a whole extra turn plus the user's trust.
 *
 * WHY CANDIDATES AND NOT ONE REWRITE. The right amount of compression depends on what is
 * in the prompt, and no single threshold knows that in advance. Stripping the sentence
 * before the request is right when it is an apology and wrong when it is the constraint
 * the whole answer turns on. Producing several and testing them turns a guess into a
 * measurement.
 *
 * THE VALIDATOR IS THE POINT. Everything here is arranged around it:
 *
 *     numbers        every numeral in the original still present
 *     code           fenced and inline spans byte-identical
 *     urls           unchanged
 *     quoted         the user's own quoted material intact
 *     constraints    must / only / exactly / no X / under N words still stated
 *     format         a named output format still named
 *     task           the leading imperative verb unchanged
 *     invention      no content word that was not in the original
 *
 * The last one is the strongest and the cheapest. Compression may only remove; a word
 * appearing in the output that never appeared in the input means something was invented,
 * whatever else looks fine.
 *
 * COST BUDGET. Candidate generation is not free and runs on a debounce while somebody is
 * typing. compress() takes a budget in milliseconds and stops producing candidates when
 * it is spent, so a long prompt degrades to fewer candidates rather than to a slow
 * keystroke. Tiers are generated cheapest first, so the budget always buys the safest
 * ones.
 */

const PM_C_PROTECT = (typeof PromptMeterProtect !== 'undefined')
    ? PromptMeterProtect
    : (typeof require !== 'undefined' ? require('./protect.js').PromptMeterProtect : null);

const PM_C_OPTIMIZER = (typeof PromptMeterOptimizer !== 'undefined')
    ? PromptMeterOptimizer
    : (typeof require !== 'undefined' ? require('./optimizer.js').PromptMeterOptimizer : null);
const PM_C_SPELL = (typeof PromptMeterSpelling !== 'undefined')
    ? PromptMeterSpelling
    : (typeof require !== 'undefined' ? require('./spelling.js').PromptMeterSpelling : null);

const PM_C_CONDENSE = (typeof PromptMeterCondense !== 'undefined')
    ? PromptMeterCondense
    : (typeof require !== 'undefined' ? require('./condense.js').PromptMeterCondense : null);

const PM_C_TOKENIZER = (typeof PromptMeterTokenizer !== 'undefined')
    ? PromptMeterTokenizer
    : (typeof require !== 'undefined' ? require('./tokenizer.js').PromptMeterTokenizer : null);

const PM_C_ANALYSIS = (typeof PromptMeterAnalysis !== 'undefined')
    ? PromptMeterAnalysis
    : (typeof require !== 'undefined' ? require('./analysis.js').PromptMeterAnalysis : null);

const PromptMeterCompress = {

    MODES: ['conservative', 'balanced', 'aggressive'],

    // Condense-only phrase rewrites. Trim removes what carries nothing (greetings,
    // filler, wrappers); these shorten what carries meaning in more words than it
    // needs. Each result still goes through validate(), like every candidate.
    TIGHTEN_RULES: [
        // Wordy connectives
        [/\bin\s+order\s+to\b/gi, 'to'],
        [/\bdue\s+to\s+the\s+fact\s+that\b/gi, 'because'],
        [/\bfor\s+the\s+purpose\s+of\b/gi, 'for'],
        [/\bwith\s+(?:regard|respect)\s+to\b/gi, 'about'],
        [/\bat\s+this\s+point\s+in\s+time\b/gi, 'now'],
        [/\bin\s+the\s+event\s+that\b/gi, 'if'],
        [/\bis\s+able\s+to\b/gi, 'can'],
        // Announcements of a requirement: the requirement stays, the frame goes.
        [/(^|[.!?]\s+)(?:it\s+is\s+important\s+to\s+note\s+that|please\s+note\s+that|note\s+that)\s+(\w)/gi,
            (m, lead, first) => lead + first.toUpperCase()],
        // Only before "you": "Make sure this uses Python 3" is an instruction, and
        // without its frame it read as a statement of fact.
        [/\bmake\s+sure\s+(?:that\s+)?you\s+/gi, ''],
        [/\bmake\s+sure\s+to\s+/gi, ''],
        // Abstract nouns around the subject
        [/\bthe\s+(?:concept|idea|notion|topic)\s+of\s+/gi, ''],
        // Requests
        [/\bgive\s+me\s+(?:a\s+list\s+of|some)\s+/gi, 'list '],
        // Only "also" goes: the verb is the second request. Dropping it turned
        // "convert this and also explain what each line is doing" into "and what each
        // line is doing".
        [/\b(and\s+)?also\s+(tell\s+me|explain|show\s+me)\s+/gi, (m, and, verb) => 'and ' + verb + ' '],
        [/,?\s+and\s+also\s+(?:i\s+want\s+you\s+to\s+)?/gi, ' and '],
        // "Explain X ... and explain it simply" / "Explain X. Explain it simply.": the
        // second "explain" only carries the manner, so the manner is all that stays.
        [/^(explain\b[^]*?)(?:,?\s+and\s+|[.!?]\s+)explain\s+it\s+(simply|briefly|in\s+detail|step\s+by\s+step|clearly)\b/i,
            (m, first, how) => `${first.replace(/[.!?]$/, '')}, ${how}`],
        [/\bwhat\s+should\s+i\s+do\s+to\s+(\w+)/gi, 'how do I $1'],
        // A doubt stated as a fact becomes the question. Mid-sentence ("... student and
        // I am not sure") it starts a new sentence rather than leaving "and Should I".
        [/(,?\s+and\s+|^|[.!?]\s+)i\s+am\s+not\s+sure\s+(?:whether|if)\s+i\s+should\s+([^.?!]+?)\s+or\s+([^.?!]+?)[.?!]/gi,
            (m, lead, a, b) => (/and/i.test(lead) ? '. ' : lead) + `Should I ${a} or ${b}?`],
        [/(^|[.!?]\s+)i\s+(?:need|want|would\s+like)\s+to\s+know\s+how\s+to\s+([^.?!]+)[.?!]?/gi,
            (m, lead, rest) => `${lead}How do I ${rest}?`],
        [/(^|[.!?]\s+)help\s+me\s+(?:to\s+)?understand\s+/gi, '$1Explain '],
        [/\bgive\s+me\s+the\s+(steps|points|options)\b/gi, 'list the $1'],
        [/\bi\s+have\s+(?:this|a)\s+problem\s+where\s+/gi, ''],
        // Who it is for, said once
        [/\b(?:because|since|as)\s+i(?:'m|\s+am)\s+(a|an)\s+(beginner|student|newbie|novice)\b/gi, 'for $1 $2'],
        [/\b(?:because|since|as)\s+i(?:'m|\s+am)\s+new\s+to\s+(\w+)/gi, 'for a $1 beginner'],
        // "like" before a question word is filler: "like what it is and how it works"
        [/,?\s+like\s+(?=(?:what|how|why|when|where|which|who)\b)/gi, ', '],
        // Questions that are really requests, in their shortest form. Condense only:
        // Trim keeps the user's question; Condense trades it for the command.
        [/(^|[.!?]\s+)what\s+are\s+(?:the\s+|some\s+)?(?:different\s+|various\s+|main\s+)?(types|kinds|forms|categories|causes|symptoms|benefits|advantages|disadvantages|uses|stages|steps|examples|features|applications|effects|signs|risks)\s+of\s+/gi,
            (m, lead, what) => lead + 'List the ' + what.toLowerCase() + ' of '],
        [/(^|[.!?]\s+)how\s+(?:do|can|should)\s+(?:i|we|one)\s+/gi, '$1How to '],
        [/(^|[.!?]\s+)what\s+is\s+the\s+meaning\s+of\s+/gi, '$1Define '],
        [/(^|[.!?]\s+)what\s+does\s+(.{1,40}?)\s+mean\b\??/gi, '$1Define $2'],
        [/(^|[.!?]\s+)is\s+it\s+possible\s+to\s+/gi, '$1Can I '],
        [/(^|[.!?]\s+)i\s+wonder\s+(what|how|why|which|where|when|who|whether|if)\s+([^.?!]+)[.?!]?/gi,
            (m, lead, q, rest) => lead + q.charAt(0).toUpperCase() + q.slice(1) + ' ' + rest + '?'],
        [/(^|[.!?]\s+)i(?:'m|\s+am)\s+not\s+sure\s+how\s+to\s+([^.?!]+)[.?!]?/gi,
            (m, lead, rest) => lead + 'How to ' + rest + '?'],
        // Who it is for, in two words: ", I am a beginner and I don't know much about
        // machine learning" -> " for a beginner".
        [/,?\s*(?:and\s+|as\s+|since\s+|because\s+)?i(?:'m|\s+am)\s+(?:a\s+)?(?:complete\s+|total\s+|absolute\s+)?(beginner|newbie|novice)(?:\s+(?:and|so)\s+i\s+(?:do\s*n[o']?t|don'?t)\s+(?:really\s+)?know\s+(?:much|anything)\s+about\s+[^.,;?!]+)?/gi, ' for a $1'],
        [/\basking\s+(?:him|her|them)\s+for\b/gi, 'asking for'],
        [/\b(generate|give|list|suggest|write|share|provide|recommend|create|make)\s+(me\s+)?some\s+(?=(?:[a-z]+\s+)?[a-z]+s\b)/gi, '$1 $2'],
        [/\ball\s+the\s+(?=(?:[a-z]+\s+)?[a-z]+s\b)/gi, 'all '],
        [/\bi(?:'m|\s+am)\s+planning\s+to\b/gi, 'I plan to'],
        [/(^|[.!?]\s+)what\s+(?:are|is)\s+the\s+(best|top|cheapest|easiest|fastest)\s+([^.?!]+)[.?!]?/gi,
            (m, lead, sup, rest) => lead + sup.charAt(0).toUpperCase() + sup.slice(1) + ' ' + rest + '?'],
        // Trailing padding
        [/\s+for\s+me\b(?!\s+(?:and|to)\b)/gi, ''],
        [/\s+as\s+well(?=\s*[.?!]|$)/gi, ''],
    ],

    /**
     * Applies TIGHTEN_RULES and tidies what they leave. Code, URLs and quoted text
     * are masked first, so nothing inside them is rewritten.
     * @param {string} text
     * @returns {string}
     */
    tighten: function (text) {
        const masked = PM_C_PROTECT ? PM_C_PROTECT.mask(text) : { masked: text, spans: [] };
        // Two passes: one rewrite can set up another ("Help me understand X. Explain it
        // simply." needs the first to become "Explain" before the two can merge).
        const pass = (text) => this.TIGHTEN_RULES.reduce((s, [rx, to]) => s.replace(rx, to), text);
        let out = pass(pass(masked.masked));
        // "I am facing many respiratory issues. List the kinds of respiratory issues":
        // the opening sentence only announces the subject the request names again.
        out = out.replace(/^\s*i(?:'m|\s+am|\s+have\s+been)\s+(?:facing|having|experiencing|dealing\s+with|suffering\s+from|struggling\s+with|getting|seeing)\s+(?:many\s+|some\s+|a\s+lot\s+of\s+|a\s+few\s+|lots\s+of\s+|frequent\s+)?([^.?!]{3,60})[.!]\s+(?=\S)/i,
            (m, subject, offset, whole) => {
                const rest = whole.slice(m.length).toLowerCase();
                const head = subject.trim().toLowerCase().split(/\s+/).pop().replace(/s$/, '');
                return head.length > 3 && rest.includes(head) ? '' : m;
            });
        if (out === masked.masked) return text;
        out = out
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+([,.?!;:])(?![=<>\d])/g, '$1')
            .replace(/,\s*,/g, ',')
            .replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, c) => lead + c.toUpperCase())
            .replace(/,\s+(Explain|Write|Give|List|Tell|Show|Describe|Create|Make|Help)\b/g,
                (m, verb) => ', ' + verb.toLowerCase())
            .trim();
        return PM_C_PROTECT ? PM_C_PROTECT.unmask(out, masked.spans) : out;
    },

    STATUS: {
        SUCCESSFUL: 'OPTIMIZATION_SUCCESSFUL',
        ALREADY_OPTIMAL: 'NO_OP_ALREADY_OPTIMAL',
        UNSAFE_COMPRESSION: 'NO_OP_UNSAFE_COMPRESSION',
        UNSUPPORTED_LANGUAGE: 'NO_OP_UNSUPPORTED_LANGUAGE',
        FAILED: 'OPTIMIZATION_FAILED'
    },

    // Milliseconds. Generous next to the optimizer's own cost (about 1.5ms on an
    // ordinary prompt) and small next to the 750ms debounce the card runs on.
    DEFAULT_BUDGET_MS: 60,

    // ---------------------------------------------------------------------------
    // Extraction
    // ---------------------------------------------------------------------------

    OUTPUT_FORMATS: /\b(json|xml|yaml|csv|markdown|html|table|bullet(?:s|ed)?|list|essay|email|poem|script|summary|outline|diagram|pseudocode|step[\s-]by[\s-]step)\b/gi,

    CONSTRAINT_PATTERNS: [
        /\b(?:exactly|at least|at most|no more than|under|over|within|up to)\s+\d+\s+\w+/gi,
        /\b\d+\s*(?:words?|characters?|lines?|pages?|paragraphs?|sentences?|bullets?|slides?|items?|steps?|examples?)\b/gi,
        /\bmust\s+(?:not\s+)?\w+/gi,
        /\bonly\s+(?:use\s+)?\w+/gi,
        /\bno\s+(?:external|third[\s-]party|new|extra)?\s*\w+/gi,
        /\b(?:do not|don't|never|avoid)\s+\w+/gi,
        // Requirements asked politely. "I would like it to not mention water" read as
        // no constraint at all, so a haiku prompt lost it and still validated; so did
        // "I'd appreciate it if the story had a twist ending". The whole clause is the
        // constraint, and the carrier check below lets its wrapper go but not its point.
        /\b(?:to not|not to|without)\s+\w+/gi,
        /\b(?:would|'d)\s+(?:really\s+)?(?:like|love|prefer)\s+(?:it\s+)?(?:to|if|that)\b[^.!?\n]*/gi,
        /\bappreciate\s+it\s+if\b[^.!?\n]*/gi,
        // (?!\w): without it "in javascirpt" read as the constraint "in java", which the
        // corrected "in JavaScript" then failed, so the typo fix was thrown away.
        /\bin\s+(?:python|javascript|typescript|java|c\+\+|c#|go|rust|ruby|php|sql)(?!\w)\s*\d*\.?\d*/gi,
        // Depth and style of the answer. "In detail" after a question was dropped as a
        // fragment; "Use O(n) time" and "step by step" are the shape of the answer.
        /\b(?:in (?:great |full |more )?detail|in depth|in-depth|briefly|step[- ]by[- ]step|with (?:an? |some )?examples?|in O\([^)]+\)|O\([^)]+\) (?:time|space))\b/gi,
        // Roles. "I want you to act as a Linux terminal." was dropped as a wrapper, and
        // without it the rest of that prompt means nothing.
        /\b(?:act as|acting as|pretend (?:you are|to be)|(?:play|take on|assume) the role of|you are (?:an?|the))\s+[^.!?\n,]+/gi,
        // Style instructions. "Be concise." carries no number and no "must", so the
        // aggressive tier dropped it and nothing noticed.
        /\b(?:be|keep it|make it)\s+(?:very\s+)?(?:concise|brief|short|succinct|specific|detailed|thorough|formal|informal|casual|funny|polite|professional|friendly|simple|clear)\b/gi
    ],

    // Where material handed over to be worked on starts: "the following article:",
    // "below:", "the paragraph below" ending its line. Everything after it is the
    // user's content, not their request, and compression may not edit it.
    // Also a colon after an instruction verb: "Translate to Hindi:", "Proofread my
    // email:", "rewrite this paragraph in formal tone: ..." -- live testing caught the
    // text to translate deleted as a greeting and the email to proofread trimmed.
    PAYLOAD_MARKER: /\bfollowing\b[^:\n]{0,300}:|\b(?:below|here)\s*:|\b(?:text|paragraph|article|passage|email|message|essay|story|code|sentences?|list|document|poem)\s+below\b[^\n]*\n|\b(?:translate|proofread|fix|correct|check|rewrite|rephrase|paraphrase|summari[sz]e|improve|edit|polish|shorten|simplify|explain|analy[sz]e|review|grade|rate|make\s+it\s+(?:better|shorter|formal|professional))\b[^:\n]{0,60}:(?!\/\/)|\bfollowing\b[^:\n]{0,80}[.:]?[ \t]*(?=\n)|(?=\n[ \t]*(?:message|text|input|sentence|passage|email|tweet|review|paragraph|content|data|word|quote|letters?|options?|statement|story|essay|poem|lyrics|transcript)[ \t]*:)|^[ \t]*(?:message|text|input|sentence|passage|email|tweet|review|paragraph|content|data|word|quote|letters?|options?|statement|story|essay|poem|lyrics|transcript)[ \t]*:[ \t]*/i,

    // Capitalised shorthand people type that names nothing, and the assistant itself,
    // which "Hey ChatGPT," addresses rather than asks about.
    NOT_NAMES: new Set(['ok', 'okay', 'lol', 'omg', 'pls', 'plz', 'asap', 'btw', 'tbh', 'imo',
        'thx', 'ty', 'hi', 'hey', 'chatgpt', 'gpt', 'ai']),

    /**
     * Terms that name something: an inner capital (MongoDB, iPhone), all caps (BASE,
     * API), or a capital that does not open a sentence (Postgres in "And Postgres").
     * A prompt typed in capitals has no names by this measure, so the caps rule is off.
     */
    namesIn: function (text) {
        const masked = text.replace(/```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+/g, ' ');
        const letters = masked.match(/[A-Za-z]/g) || [];
        const shouting = letters.length
            && (masked.match(/[A-Z]/g) || []).length / letters.length > 0.6;
        const names = new Set();
        // Whole tokens only: starting mid-token made "1NF" yield a name "NF".
        const word = /(?<![A-Za-z0-9+#])[A-Za-z0-9][A-Za-z0-9+#]*(?:[-.][A-Za-z0-9+#]+)*/g;
        let hit;
        while ((hit = word.exec(masked)) !== null) {
            const token = hit[0].replace(/\.$/, '');
            if (token.length < 2 || !/[A-Za-z]/.test(token)
                || this.NOT_NAMES.has(token.toLowerCase())) continue;
            const inner = /[a-z][A-Z]/.test(token);
            const caps = !shouting && /^[A-Z]{2,}[A-Z0-9+#-]*$/.test(token);
            // Walk back over whitespace to the previous character. A regex anchored at
            // the end of the whole prefix made this quadratic in the prompt length.
            let j = hit.index - 1;
            let newline = false;
            while (j >= 0 && /\s/.test(masked[j])) {
                if (masked[j] === '\n') newline = true;
                j--;
            }
            const opens = j < 0 || newline || /[.!?:;\-*•(["'“‘]/.test(masked[j]);
            const midCapital = !shouting && /^[A-Z][a-z]/.test(token) && !opens;
            if (inner || caps || midCapital) names.add(token);
        }
        return [...names];
    },

    /** The material after a PAYLOAD_MARKER, or null when there is none. */
    payloadIn: function (text) {
        const hit = this.PAYLOAD_MARKER.exec(text);
        // A sign-off after the material ("Kind regards,\nAsha") is the user's, not part
        // of the text to review; counting it made every rewrite of the email "lose"
        // payload, so nothing in front of it could be trimmed either.
        const rest = hit ? text.slice(hit.index + hit[0].length)
            .replace(/\n\s*(?:(?:kind|best|warm)\s+regards|regards|thanks(?:\s+in\s+advance)?|thank\s+you|cheers|sincerely|yours\s+(?:truly|sincerely))\b[\s\S]*$/i, '')
            .trim() : '';
        return rest || null;
    },

    /**
     * Pulls a prompt apart into the pieces a compressor has to treat differently.
     *
     * This is descriptive, not a rewrite: nothing here changes the prompt. It exists so
     * the validator and the UI can both talk about the same parts, and so "did the
     * constraints survive" is a question with an answer rather than an impression.
     *
     * @param {string} prompt
     * @returns {Object} { objective, context, constraints, format, terminology, reference }
     */
    extract: function (prompt) {
        const empty = {
            objective: '', context: [], constraints: [], format: [],
            terminology: [], reference: []
        };
        if (typeof prompt !== 'string' || !prompt.trim()) return empty;

        const masked = PM_C_PROTECT ? PM_C_PROTECT.mask(prompt) : { masked: prompt, spans: [] };
        const text = masked.masked;

        // The objective is the clause carrying the request. The first sentence that has
        // an imperative or a question mark, rather than simply the first sentence --
        // prompts routinely open with an apology.
        const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
        const asks = /\b(?:explain|write|create|build|make|give|list|show|tell|describe|compare|summari[sz]e|translate|fix|debug|generate|design|draft|suggest|recommend|calculate|solve|analy[sz]e|review|rewrite|convert|implement|help|teach|outline|what|why|how|when|which|who)\b/i;
        const objective = sentences.find((s) => asks.test(s) || s.indexOf('?') !== -1)
            || sentences[0] || '';

        const constraints = [];
        this.CONSTRAINT_PATTERNS.forEach((pattern) => {
            pattern.lastIndex = 0;
            const hits = text.match(pattern);
            if (hits) hits.forEach((hit) => {
                const trimmed = hit.trim();
                if (constraints.indexOf(trimmed) === -1) constraints.push(trimmed);
            });
        });

        this.OUTPUT_FORMATS.lastIndex = 0;
        const format = [...new Set((text.match(this.OUTPUT_FORMATS) || [])
            .map((f) => f.toLowerCase()))];

        // Terminology: the words the optimizer must not touch because they name the
        // subject. Acronyms it already knows, plus anything capitalised mid-sentence.
        const terminology = [...new Set(
            (text.match(/\b[A-Z][A-Za-z0-9+#.]*\b/g) || [])
                .filter((word) => word.length > 1)
                .concat(PM_C_OPTIMIZER
                    ? (text.match(PM_C_OPTIMIZER.compiled.acronyms) || [])
                    : [])
        )];

        return {
            objective: objective,
            // Every sentence that is not the objective is context until proven otherwise.
            context: sentences.filter((s) => s !== objective),
            constraints: constraints,
            format: format,
            terminology: terminology,
            // Protected spans are reference material by construction: code, quotes, URLs.
            reference: masked.spans.slice()
        };
    },

    // ---------------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------------

    /** Every numeral, as written. "300" and "3.14" are different things to preserve. */
    numbersIn: (text) => (text.match(/\d+(?:[.,]\d+)*/g) || []),

    /** Code, inline spans, URLs and quoted material -- anything protect.js would mask. */
    verbatimIn: (text) => []
        .concat(text.match(/```[\s\S]*?```/g) || [])
        .concat(text.match(/`[^`\n]+`/g) || [])
        .concat(text.match(/https?:\/\/\S+/g) || [])
        .concat(text.match(/"[^"\n]{4,}"/g) || [])
        .concat(text.match(/(?<![\w'’])'[^'\n]{4,}'(?![\w'’])/g) || [])
        // Big-O is a requirement written as notation: "Use O(n) time" was dropped whole.
        .concat(text.match(/\bO\([^)\s]{1,12}\)/g) || []),

    // Words too common to carry meaning. A candidate dropping one of these has not lost
    // a requirement; a candidate INVENTING one has not invented anything either.
    FUNCTION_WORDS: new Set(('the a an and or but if then than that this these those there '
        + 'here it its is are was were be been being am do does did done doing have has '
        + 'had having will would can could shall should may might must not no yes of to '
        + 'in on at by for with from as into over under about after before between out '
        + 'up down off again further once you your yours we our ours i me my mine they '
        + 'them their he she his her so such own same too very just now also please').split(' ')),

    // Words that express a comparison rather than the thing being compared. A
    // constraint may be reworded across these without changing what it demands.
    // Only genuine comparison words. Verbs like "use", "keep" and "include" were here
    // briefly and are exactly wrong: they ARE the requirement, and excusing them let
    // "Do not use code" compress away to nothing without tripping anything.
    // Words the optimizer's and tighten()'s own rewrites put in place of longer
    // phrases ("in simple terms" -> "simply", "due to the fact that" -> "because").
    // Seeing one in a candidate is not the compressor inventing content.
    REWRITE_WORDS: new Set(['quickly', 'many', "i'm", 'im', 'summarize', 'summarise', 'teach', 'define', 'plan', 'one', 'them',
        'simply', 'briefly', 'because', 'list', 'about', 'now', 'can',
        'beginner', 'should', 'how', 'explain', 'concisely', 'shortly',
        // Corrections the grammar rules make from a different word in the original.
        "they're", "it's", "you're", "who's", 'than', 'whether', 'which', 'their', 'there',
        'losing', 'advise', 'known', 'saw', 'bought', 'fewer', 'are', 'write', 'between', 'and',
        'for', 'to', 'gone', 'done', 'seen', 'taken', 'written', 'given', 'he', 'she', 'buy']),

    COMPARATORS: new Set(['more', 'less', 'least', 'most', 'than', 'under', 'over',
        'up', 'exactly', 'precisely', 'within', 'around', 'about']),

    /** Content words, lowercased and crudely stemmed so plurals do not read as new. */
    contentWords: function (text) {
        const stem = (word) => word
            .replace(/(?:ing|ed|es|s)$/, '')
            .replace(/ie$/, 'y');
        return new Set((text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
            .filter((word) => !this.FUNCTION_WORDS.has(word))
            .map(stem));
    },

    /**
     * Drops a REQUEST that repeats an earlier one: "Explain normalization in DBMS. ...
     * Explain normalization clearly." Only a sentence that opens with a task verb is a
     * candidate, and only when every content word and number in it is already said by
     * the sentences that stay -- so questions, inputs, examples, constraints and
     * statements are never removed. One paragraph and three sentences or more only.
     * @param {string} text
     * @returns {string}
     */
    MANNER: new Set(['clearly', 'simply', 'briefly', 'properly', 'well', 'again', 'really',
        'understand', 'know', 'learn', 'need', 'want']),

    dropRepeatedRequests: function (text) {
        if (!PM_C_CONDENSE || /\n|`/.test(text)) return text;
        const sentences = PM_C_CONDENSE.splitSentences(text);
        if (sentences.length < 3) return text;
        const REQUEST = /^(?:explain|describe|write|give|list|tell|show|help|summari[sz]e|teach)\b|^(?:and\s+)?i\s+(?:really\s+|just\s+)?(?:need|want)\s+to\s+(?:understand|know|learn)\b/i;
        const keep = sentences.map(() => true);
        for (let i = sentences.length - 1; i > 0; i--) {
            if (!REQUEST.test(sentences[i]) || /[?]$/.test(sentences[i])) continue;
            const others = sentences.filter((s, j) => j !== i && keep[j]).join(' ');
            const said = this.contentWords(others);
            // How it should be explained ("clearly", "simply") is not a new request.
            const manner = this.contentWords([...this.MANNER].join(' '));   // stemmed alike
            const words = [...this.contentWords(sentences[i])].filter((w) => !manner.has(w));
            const numbers = this.numbersIn(sentences[i]);
            if (words.length >= 2 && words.every((w) => said.has(w))
                && numbers.every((n) => this.numbersIn(others).includes(n))) keep[i] = false;
        }
        return keep.every(Boolean) ? text : sentences.filter((s, i) => keep[i]).join(' ');
    },

    /**
     * Checks a candidate against the original.
     *
     * Every rule is a thing that must SURVIVE, except the last, which is a thing that
     * must not APPEAR. Violations name what was lost so the UI can warn rather than
     * silently falling back.
     *
     * @param {string} original
     * @param {string} candidate
     * @returns {Object} { valid, violations: [{ rule, detail }] }
     */
    validate: function (original, candidate, options) {
        const violations = [];

        if (typeof candidate !== 'string' || !candidate.trim()) {
            return { valid: false, violations: [{ rule: 'empty', detail: 'nothing left' }] };
        }
        // "hello?" became "?": punctuation with every word stripped is not a prompt.
        if (/\p{L}/u.test(original) && !/\p{L}/u.test(candidate)) {
            return { valid: false, violations: [{ rule: 'empty', detail: 'no words left' }] };
        }
        // "Hi Vicuna! How are you?" became "Vicuna!": one word left of a real prompt
        // is the leftover of the strippers, not a shorter prompt.
        const wordCount = (s) => (s.match(/\p{L}+/gu) || []).length;
        if (wordCount(candidate) <= 1 && wordCount(original) >= 3) {
            return { valid: false, violations: [{ rule: 'empty', detail: 'one word left' }] };
        }

        // Names. "Also BASE. And MongoDB. And Postgres." were dropped as fragments and
        // "Thanks to the new API, ..." as a thank-you; each was a thing the user asked
        // about. A term with an inner capital, all caps, or a capital mid-sentence
        // names something, and has to survive (case-insensitively: "python" may become
        // "Python").
        const lowerCandidate = candidate.toLowerCase();
        const has = (word) => new RegExp('(?:^|[^\\w])' + word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            + '(?![\\w])').test(lowerCandidate);
        this.namesIn(original).forEach((name) => {
            // A capitalised typo ("Machine Learing") looks like a name; its correction
            // standing in its place is the word surviving, not a name lost.
            const fixed = PM_C_SPELL && /^[A-Za-z]+$/.test(name) && PM_C_SPELL.correctWord(name.toLowerCase());
            if (fixed && has(fixed)) return;
            if (!has(name)) {
                violations.push({ rule: 'name', detail: name });
            }
        });

        // List items. A numbered or bulleted line is an enumerated requirement:
        // "3. Mobile first" was emptied to "3." and nothing noticed.
        const kept = this.contentWords(candidate);
        const lineWords = candidate.split('\n').map((line) => this.contentWords(line));
        (original.match(/^[ \t]*(?:\d+\s*[.)\-]|[-*•])[ \t]+.+$/gm) || []).forEach((item) => {
            const words = [...this.contentWords(item)];
            // Every word of the item in one line of the candidate: "Never received
            // item... never received refund." lost its second half and passed, because
            // "refund" survived in the item below it.
            const whole = lineWords.some((set) => words.every((word) => set.has(word)));
            const lost = whole ? [] : words.filter((word) => !kept.has(word)).concat(['(split)']);
            if (lost.length) violations.push({ rule: 'list-item', detail: item.trim().slice(0, 40) });
        });

        // Numbers. A changed numeral is a changed requirement -- "under 300 words"
        // becoming "under 30 words" is a different prompt that still reads fine.
        // Digits inside known chat shorthand ("2nite", "gr8", "b4") are spelling, not
        // numbers: expanding "2nite" to "tonight" was rejected as losing the number 2.
        // Only tokens the optimizer's own tables expand; "3pm" and "GPT-4o" still count.
        const tables = PM_C_OPTIMIZER ? Object.assign({}, PM_C_OPTIMIZER.chatSlangMap,
            PM_C_OPTIMIZER.spellingTypos, PM_C_OPTIMIZER.politenessTypos) : {};
        const unshorthand = (text) => text.replace(/\b[a-z]*\d[a-z\d]*\b/gi,
            (token) => Object.prototype.hasOwnProperty.call(tables, token.toLowerCase()) ? ' ' : token);
        // Digits used as words ("how 2 make", "4 beginners") and the number in a
        // courtesy bribe ("I will tip $200") are not requirements.
        const asWords = (text) => (PM_C_OPTIMIZER && PM_C_OPTIMIZER.expandDigitWords
            ? PM_C_OPTIMIZER.expandDigitWords(text) : text).replace(/\bi\s+will\s+tip\s+\$?\d[\d,.]*/gi, ' ');
        // A digit typed inside a word ("pr5oblems") is a typo, not a number: the
        // optimizer removes it, and requiring it to survive threw the fix away.
        const strayDigits = (text) => text.replace(/\b([A-Za-z]+)\d([A-Za-z]+)\b/g,
            (m, a, b) => (a.length + b.length >= 3 ? a + b : m));
        // Each distinct number once: a value repeated in the original ("the best phone
        // under 20000 ... buy the best phone under 20000") is one requirement, kept when
        // the repeated phrase is said once.
        const beforeNumbers = [...new Set(this.numbersIn(strayDigits(unshorthand(asWords(original)))))];
        const afterNumbers = this.numbersIn(candidate).slice();
        beforeNumbers.forEach((number) => {
            const at = afterNumbers.indexOf(number);
            if (at === -1) violations.push({ rule: 'numbers', detail: number });
            else afterNumbers.splice(at, 1);
        });

        // Verbatim material: code, URLs, quoted passages.
        this.verbatimIn(original).forEach((span) => {
            if (candidate.indexOf(span) === -1) {
                violations.push({ rule: 'verbatim', detail: span.slice(0, 40) });
            }
        });

        // Payload. The article to summarise or the paragraph to rewrite lost whole
        // sentences to the condenser as "narrative", and only a stray numeral ever
        // caught it. Compared against the spell-corrected payload when there is one,
        // since the conservative tier legitimately fixes typos inside it.
        const payload = this.payloadIn((options && options.alsoAllow) || original)
            || this.payloadIn(original);
        if (payload) {
            const kept = this.contentWords(candidate);
            const lost = [...this.contentWords(payload)].filter((word) => !kept.has(word));
            if (lost.length) {
                violations.push({ rule: 'payload', detail: lost.slice(0, 5).join(', ') });
            }
        }

        const parts = this.extract(original);

        // Constraints, compared on their content words so a rewording survives but a
        // removal does not: "no more than 300 words" and "under 300 words" both keep
        // the 300 and the "words".
        const present = this.contentWords(candidate);
        const candidateNumbers = new Set(this.numbersIn(candidate));
        parts.constraints.forEach((constraint) => {
            // Every NUMBER in the constraint must survive -- that is the part that
            // cannot be reworded without changing the requirement.
            const lostNumber = this.numbersIn(constraint)
                .some((number) => !candidateNumbers.has(number));

            // Of the rest, the words that carry the requirement rather than express
            // the comparison. Demanding all of them is too strict: "no more than 300
            // words" and "under 300 words" are the same requirement, and "do not use
            // code" survives as "no code". Demanding none is no check at all, so the
            // bar is that most of them are still there.
            const carriers = [...this.contentWords(constraint)]
                .filter((word) => !this.COMPARATORS.has(word));
            // A misspelled carrier survives as its correction: "no experiance" is kept
            // by "no experience", and reading it as lost threw away every fix.
            const fixedForm = (word) => {
                const fix = PM_C_SPELL && PM_C_SPELL.correctWord && PM_C_SPELL.correctWord(word);
                return fix && present.has(fix.toLowerCase());
            };
            const kept = carriers.filter((word) => present.has(word) || fixedForm(word)).length;
            const lostMeaning = carriers.length > 0 && kept * 2 < carriers.length;

            if (lostNumber || lostMeaning) {
                violations.push({ rule: 'constraint', detail: constraint });
            }
        });

        // A named output format must still be named.
        const candidateFormats = new Set((candidate.match(this.OUTPUT_FORMATS) || [])
            .map((f) => f.toLowerCase()));
        // "Summarize" asks for the summary format by itself.
        if (/\bsummari[sz]e\b/i.test(candidate)) candidateFormats.add('summary');
        parts.format.forEach((format) => {
            if (!candidateFormats.has(format)) {
                violations.push({ rule: 'format', detail: format });
            }
        });

        // The task itself. If the original asked to explain, the candidate may not ask
        // to write -- compression may shorten a request, never redirect it.
        const taskVerb = (text) => {
            const hit = /\b(explain|write|create|build|make|give|list|show|tell|describe|compare|summari[sz]e|translate|fix|debug|generate|design|draft|suggest|recommend|calculate|solve|analy[sz]e|review|rewrite|convert|implement|teach|outline|plan|check|find|parse|format|schedule|refactor|proofread)\b/i.exec(text);
            return hit ? hit[1].toLowerCase() : null;
        };
        const before = taskVerb(original);
        const after = taskVerb(candidate);
        // The original verb has to survive, not stay first: dropping a restated
        // "Explain X." ahead of "Tell me about X. Explain X." read as explain -> tell.
        // A verb that was never there is still caught by the invention rule below.
        // "give me a list of" -> "list", "tell me" -> "explain": the same request.
        const SAME_TASK = { give: ['list', 'show', 'suggest'], tell: ['explain', 'list'], show: ['list'] };
        // "give me an explanation of X" is "explain X": the noun was the request.
        const explanationAsked = (before === 'give' && after === 'explain' && /\bexplanation\b/i.test(original))
            // "write/give/make a summary of X" is "summarize X".
            || (/^summari[sz]e$/.test(after || '') && /\bsummary\b/i.test(original));
        if (before && after !== before && !explanationAsked && !(SAME_TASK[before] || []).includes(after)
            && !new RegExp('\\b' + before + '\\b', 'i').test(candidate)) {
            violations.push({ rule: 'task',
                detail: after ? before + ' -> ' + after : 'the request verb is gone' });
        }

        // Invention. Compression removes; anything in the output that was never in
        // the input is something the compressor made up.
        //
        // `alsoAllow` carries the spell-corrected text, and without it this rule
        // reads every correction as an invention -- "recusrion" becoming
        // "recursion" introduces a word the original genuinely did not contain.
        // Over 3,000 real prompts that rejected 15.7% of the CONSERVATIVE tier,
        // which does nothing but fix spelling. A corrected word is not a new
        // requirement; it is the word the user was reaching for.
        const originalWords = this.contentWords(original);
        if (options && options.alsoAllow) {
            this.contentWords(options.alsoAllow).forEach((word) => originalWords.add(word));
        }
        const invented = [...this.contentWords(candidate)]
            .filter((word) => !originalWords.has(word) && !this.REWRITE_WORDS.has(word));
        if (invented.length) {
            violations.push({ rule: 'invention', detail: invented.slice(0, 5).join(', ') });
        }

        return { valid: violations.length === 0, violations: violations };
    },

    // ---------------------------------------------------------------------------
    // Candidates
    // ---------------------------------------------------------------------------

    /**
     * Produces rewrites from safest to hardest, stopping when the budget runs out.
     *
     * Cheapest first is deliberate. A budget that expires has still bought the
     * conservative candidate, which is the one most likely to validate.
     *
     * @param {string} prompt
     * @param {number} budgetMs
     * @returns {Array} [{ mode, text, ms }]
     */
    candidates: function (prompt, budgetMs, preserve) {
        const budget = typeof budgetMs === 'number' ? budgetMs : this.DEFAULT_BUDGET_MS;
        const started = Date.now();
        const out = [];
        const spent = () => Date.now() - started;

        if (!PM_C_ANALYSIS || !PM_C_OPTIMIZER) return out;

        // The material after a payload marker is the user's text for the model to work
        // on -- the sentence to translate, the email to proofread. It is never ours to
        // edit, at any level: only the instruction in front of it is optimised, and the
        // payload goes back on exactly as typed.
        const marker = this.PAYLOAD_MARKER.exec(prompt);
        const cut = marker ? marker.index + marker[0].length : -1;
        if (cut > 0 && cut < prompt.length && prompt.slice(cut).trim()) {
            const head = prompt.slice(0, cut);
            const tail = prompt.slice(cut);
            const sep = (tail.match(/^\s*/) || [''])[0] || ' ';
            const inner = this.candidates(head, budgetMs, preserve);
            const joined = inner.map((c) => {
                let text = c.text.replace(/\s+$/, '');
                if (/:\s*$/.test(head) && !/:$/.test(text)) text = text.replace(/[.!?]$/, '') + ':';
                return Object.assign({}, c, { text: text + sep + tail.replace(/^\s*/, '') });
            });
            // The instruction was analysed without its payload, so advice that only
            // holds for an instruction with nothing after it ("stops part-way", "this"
            // points at nothing, "refers to something not included") is dropped: the
            // payload is that something.
            const forward = /stops part-way|first thing the prompt mentions|not included/i;
            joined.analysis = inner.analysis && Object.assign({}, inner.analysis, {
                findings: (inner.analysis.findings || [])
                    .filter((f) => !forward.test(f.explanation || f.label || ''))
            });
            return joined;
        }

        // One call produces both tiers: analyze() returns the corrected text and the
        // optimized text together. Budget-checking between them would discard the
        // better one after paying for it, which is what an earlier version did -- a
        // prompt that compressed 51 tokens to 27 shipped at 49 because the clock ran
        // out on a candidate that was already in hand.
        // `preserve` is the words the user declined a correction for. Without it the
        // card's Keep button hid the row but every candidate still made the correction.
        const analysis = PM_C_ANALYSIS.analyze(prompt, preserve);
        // Carried on the array so compress() can hand it back: the card needs these
        // findings, and re-running analyze() for them doubled the cost of a keystroke.
        out.analysis = analysis;
        out.push({ mode: 'conservative', text: analysis.corrected, ms: spent() });
        out.push({ mode: 'balanced', text: analysis.optimized, ms: spent() });
        // The same prompt pasted more than once, with no sentence breaks between copies.
        // Collapsed on the ORIGINAL: once the optimizer has rewritten the first copy
        // ("can u pls explain" -> "Explain") the copies no longer match word for word.
        const once = this.collapseRepeats(prompt);
        if (once !== prompt) {
            out.push({ mode: 'balanced', text: PM_C_ANALYSIS.analyze(once, preserve).optimized, ms: spent() });
        }
        const deduped = this.collapseRepeats(analysis.optimized);
        if (deduped !== analysis.optimized) out.push({ mode: 'balanced', text: deduped, ms: spent() });

        // The aggressive tier is the first one that costs anything extra, so it is the
        // first the budget can refuse. It also only earns its cost on a prompt with room
        // to lose: below this there is nothing for a second condensing pass to find.
        if (spent() >= budget) return out;
        const best = deduped !== analysis.optimized ? deduped : analysis.optimized;
        const tight = this.tighten(best);
        if (tight && tight !== best) out.push({ mode: 'aggressive', text: tight, ms: spent() });

        // The one sentence-level step Condense takes: a request asked again in other
        // words. The broader passes that used to run here (condense with a raised
        // new-terms floor, and an earlier restated-sentence pass) were measured on 400
        // real prompts and removed questions, constraints, inputs, roles, examples and
        // lines of a shell script. dropRepeatedRequests() is narrow on purpose.
        const once2 = this.dropRepeatedRequests(tight || best);
        if (once2 !== (tight || best)) out.push({ mode: 'aggressive', text: once2, ms: spent() });

        return out;
    },

    /**
     * Removes a run of words that immediately repeats itself: "X Y Z W X Y Z W" -> "X Y
     * Z W". A prompt pasted twice or three times has no sentence breaks between the
     * copies, so the sentence-level passes never saw them as repeats. Runs of at least
     * four words only, compared case- and punctuation-insensitively; the validator then
     * judges the result like any other candidate.
     * @param {string} text
     * @returns {string}
     */
    collapseRepeats: function (text) {
        if (/\n/.test(text) && !/`/.test(text)) return this.collapseLineRepeats(text);
        let words = text.split(/\s+/).filter(Boolean);
        // ponytail: O(n^2) scan per pass; prompts above 600 words are left as typed
        // Line breaks and code would be flattened by re-joining on single spaces.
        if (words.length < 8 || words.length > 600 || /[\n`]/.test(text)) return text;
        const key = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        let changed = true;
        while (changed) {
            changed = false;
            for (let size = Math.floor(words.length / 2); size >= 4 && !changed; size--) {
                for (let i = 0; i + 2 * size <= words.length; i++) {
                    let same = true;
                    for (let k = 0; k < size && same; k++) {
                        if (key(words[i + k]) !== key(words[i + size + k])) same = false;
                    }
                    // Both copies must end the same way. "Tell me about Paris. Tell me about
                    // Paris history." matched as a repeated run, and collapsing it left
                    // "Tell me about Paris. history." -- the second copy was the start of
                    // a longer sentence, not a repeat.
                    const ends = (w) => /[.!?]$/.test(w);
                    if (same && ends(words[i + size - 1]) === ends(words[i + 2 * size - 1])) {
                        words = words.slice(0, i + size).concat(words.slice(i + 2 * size));
                        changed = true;
                        break;
                    }
                }
            }
        }
        const out = words.join(' ');
        return out === text.split(/\s+/).filter(Boolean).join(' ') ? text : out;
    },

    /**
     * collapseRepeats for text with line breaks: the same line, or the same block of
     * lines, pasted twice in a row ("Explain X.\nExplain X." or a paragraph pasted
     * twice). Compared ignoring case, punctuation and blank lines between; lines with
     * under 12 letters are never treated as a repeat, so "}" or "i++" twice in
     * unfenced code survive. Line breaks that remain are kept as typed.
     */
    collapseLineRepeats: function (text) {
        const lines = text.split('\n');
        const key = (line) => line.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        // Indexes of the lines that carry text; blank lines are only separators.
        let rows = lines.map((line, i) => i).filter((i) => key(lines[i]));
        const dropped = new Set();
        let changed = true;
        while (changed) {
            changed = false;
            for (let size = Math.floor(rows.length / 2); size >= 1 && !changed; size--) {
                for (let i = 0; i + 2 * size <= rows.length; i++) {
                    let same = true;
                    let letters = 0;
                    for (let k = 0; k < size && same; k++) {
                        const a = key(lines[rows[i + k]]);
                        if (a !== key(lines[rows[i + size + k]])) same = false;
                        letters += a.length;
                    }
                    if (same && letters >= 12) {
                        const gone = rows.slice(i + size, i + 2 * size);
                        gone.forEach((r) => dropped.add(r));
                        // The blank lines that separated the copy go with it.
                        for (let r = gone[0] - 1; r > rows[i + size - 1]; r--) dropped.add(r);
                        rows = rows.slice(0, i + size).concat(rows.slice(i + 2 * size));
                        changed = true;
                        break;
                    }
                }
            }
        }
        // A line the next one extends ("write a story" / "write a story about a dragon"
        // / "... who is afraid of fire") was a draft of it: only the last one stays.
        for (let k = 0; k + 1 < rows.length; k++) {
            const a = key(lines[rows[k]]);
            const b = key(lines[rows[k + 1]]);
            if (a.length >= 8 && b.length > a.length && b.startsWith(a)) dropped.add(rows[k]);
        }
        return dropped.size ? lines.filter((line, i) => !dropped.has(i)).join('\n') : text;
    },

    // ---------------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------------

    /**
     * Compresses a prompt, or returns it unchanged.
     *
     * @param {string} prompt
     * @param {Object} [options]
     * @param {number} [options.budgetMs] - Time allowed for candidate generation.
     * @param {string} [options.mode] - Force a tier instead of picking the shortest.
     * @param {string} [options.maxMode] - The hardest tier allowed (user strictness).
     * @param {Set<string>} [options.preserve] - Words not to spell-correct.
     * @param {number} [options.repeats] - How many times this prompt will be sent, for
     *        the net-saving figure. Defaults to 1.
     * @returns {Object} {
     *     original, text, mode, tokens, candidates, warnings, parts, overheadMs
     *   }
     */
    compress: function (prompt, options) {
        const first = this.compressOnce(prompt, options);
        if ((options && options.settled) || first.text === prompt) return first;
        const again = this.compressOnce(first.text, Object.assign({}, options, { settled: true }));
        if (again.text === first.text) return first;
        const corrected = (first.candidates || []).find((c) => c.mode === 'conservative');
        if (!this.validate(prompt, again.text, { alsoAllow: corrected && corrected.text }).valid) return first;
        const optimized = PM_C_TOKENIZER ? PM_C_TOKENIZER.countTokens(again.text) : 0;
        if (optimized > first.tokens.optimized) return first;
        const original = first.tokens.original;
        return Object.assign({}, first, {
            text: again.text,
            tokens: Object.assign({}, first.tokens, {
                optimized: optimized,
                saved: original - optimized,
                percent: original > 0 ? Math.round(((original - optimized) / original) * 100) : 0,
                netSaved: (original - optimized) * Math.max(1, (options && options.repeats) || 1)
            })
        });
    },

    compressOnce: function (prompt, options) {
        const settings = options || {};
        const started = Date.now();

        const blank = {
            original: prompt || '', text: prompt || '', mode: 'none',
            tokens: null, candidates: [], warnings: [], parts: this.extract(''),
            overheadMs: 0
        };
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return Object.assign(blank, { status: this.STATUS.ALREADY_OPTIMAL, reason: 'empty prompt' });
        }
        const originalTokens = PM_C_TOKENIZER ? PM_C_TOKENIZER.countTokens(prompt) : 0;
        const unchanged = (status, reason, extra) => Object.assign({}, blank, {
            original: prompt, text: prompt, status: status, reason: reason,
            tokens: { original: originalTokens, optimized: originalTokens, saved: 0, percent: 0,
                exact: PM_C_TOKENIZER ? PM_C_TOKENIZER.isExact() : false,
                encoding: PM_C_TOKENIZER ? PM_C_TOKENIZER.encoding() : 'unknown', netSaved: 0 },
            overheadMs: Date.now() - started
        }, extra);

        // The validator and every rewrite rule read English through [a-z]. On other
        // scripts every check passes vacuously, which is how a Malayalam prompt lost
        // two of its three sentences and still "validated". Decline instead.
        if (PM_C_OPTIMIZER && !PM_C_OPTIMIZER.looksEnglish(prompt)) {
            return unchanged(this.STATUS.UNSUPPORTED_LANGUAGE,
                'not English: the rewrite rules and the validator cannot read it');
        }

        // A throw here used to reach content.js, which hid the card -- the same thing
        // the user sees when there is nothing to do. Say it failed instead.
        let produced;
        try {
            produced = this.candidates(prompt, settings.budgetMs, settings.preserve);
        } catch (error) {
            return unchanged(this.STATUS.FAILED, 'candidate generation threw: '
                + (error && error.message), { error: error });
        }

        // Score every candidate, keeping the rejected ones: the card shows WHY a harder
        // compression was not used, and "it was tried and it dropped your word limit" is
        // a better answer than silence.
        // The conservative tier IS the spell-corrected prompt, so every word it
        // introduces is a correction rather than an invention. It becomes the
        // allowance for the harder tiers, which are built on top of it.
        const corrected = (produced[0] && produced[0].text) || prompt;

        const scored = produced.map((candidate) => {
            const check = this.validate(prompt, candidate.text,
                { alsoAllow: corrected });
            return {
                mode: candidate.mode,
                text: candidate.text,
                tokens: PM_C_TOKENIZER ? PM_C_TOKENIZER.countTokens(candidate.text) : 0,
                valid: check.valid,
                violations: check.violations,
                ms: candidate.ms
            };
        });

        // `maxMode` is the user's strictness ceiling: "fixes only" allows the
        // conservative tier, "trim" up to balanced, "condense" everything.
        const ceiling = this.MODES.indexOf(settings.maxMode);
        const allowed = (mode) => ceiling === -1 || this.MODES.indexOf(mode) <= ceiling;
        const usable = scored.filter((candidate) =>
            candidate.valid && candidate.tokens < originalTokens && allowed(candidate.mode)
            && (!settings.mode || candidate.mode === settings.mode));

        // Shortest wins; a token tie goes to the shorter text. With the real encoder
        // "Please urgent ..." and "Urgent ..." cost the same (capitalising "Urgent"
        // splits it in two), and keeping the gentler tier on a tie left the filler in.
        let chosen = null;
        usable.forEach((candidate) => {
            if (!chosen || candidate.tokens < chosen.tokens
                || (candidate.tokens === chosen.tokens && candidate.text.length < chosen.text.length)) {
                chosen = candidate;
            }
        });

        // Nothing shorter survived, but the prompt had typos or grammar errors. Fixing
        // "diffrence" saves no tokens, and requiring a saving meant a correction was
        // never applied on its own -- the card stayed hidden and the typo went through.
        // A correction is worth a token; the card marks a rewrite that costs one.
        // Case and spacing alone ("explain" -> "Explain") are not worth interrupting for.
        let correctedOnly = false;
        // Case alone does not count -- except where it fixes something: "i" -> "I",
        // "kerala" -> "Kerala", "nasa" -> "NASA", a prompt typed in capitals. Only the
        // capital at the start of a sentence is cosmetic, so only that is folded away.
        // Not a lone "i": "i am" -> "I am" is a grammar fix, not a cosmetic capital.
        const loose = (s) => s.replace(/\s+/g, ' ').trim()
            .replace(/(^|[.!?]\s+)([a-z])(?=[a-z])/g, (m, lead, c) => lead + c.toUpperCase());
        // Among the corrected candidates the level allows, the shortest: fixing typos can
        // cost as many tokens as Trim saves ("btwn ram n rom plz" -> "between RAM and
        // ROM"), and falling back to the Fix text then put "please" back in.
        if (!chosen) {
            scored.filter((c) => c.valid && allowed(c.mode) && loose(c.text) !== loose(prompt)
                && (!settings.mode || c.mode === settings.mode))
                .forEach((c) => { if (!chosen || c.tokens < chosen.tokens) chosen = c; });
            if (chosen) correctedOnly = true;
        }

        const text = chosen ? chosen.text : prompt;
        const finalTokens = chosen ? chosen.tokens : originalTokens;
        const overheadMs = Date.now() - started;
        const repeats = Math.max(1, settings.repeats || 1);

        // Why the prompt did or did not change. "Nothing shorter exists" and "something
        // shorter exists but it dropped a requirement" look identical in the text and
        // mean opposite things about the prompt.
        const shorter = scored.filter((c) => !c.valid && c.tokens < originalTokens);
        let status;
        let reason;
        if (chosen) {
            status = this.STATUS.SUCCESSFUL;
            reason = correctedOnly
                ? 'nothing shorter passed every check; spelling and grammar corrections applied'
                : chosen.mode + ' is the shortest candidate that passed every check';
        } else if (shorter.length) {
            status = this.STATUS.UNSAFE_COMPRESSION;
            reason = shorter.map((c) => c.mode + ' (' + c.tokens + ' tokens) lost '
                + c.violations.map((v) => v.rule + ': ' + v.detail).join('; ')).join(' | ');
        } else {
            status = this.STATUS.ALREADY_OPTIMAL;
            reason = 'no candidate is shorter than the original';
        }
        if (produced.length < 3) {
            reason += ' (aggressive tier not generated: '
                + (produced.length && produced[produced.length - 1].ms >= (settings.budgetMs
                    || this.DEFAULT_BUDGET_MS) ? 'budget spent' : 'nothing further to remove')
                + ')';
        }

        return {
            status: status,
            reason: reason,
            original: prompt,
            text: text,
            mode: chosen ? chosen.mode : 'none',
            tokens: {
                original: originalTokens,
                optimized: finalTokens,
                saved: originalTokens - finalTokens,
                percent: originalTokens > 0
                    ? Math.round(((originalTokens - finalTokens) / originalTokens) * 100)
                    : 0,
                exact: PM_C_TOKENIZER ? PM_C_TOKENIZER.isExact() : false,
                encoding: PM_C_TOKENIZER ? PM_C_TOKENIZER.encoding() : 'unknown',
                // What the saving is worth if this prompt is sent more than once. A
                // one-off saving of four tokens is not worth a card; the same prompt in
                // a template sent a thousand times is.
                netSaved: (originalTokens - finalTokens) * repeats
            },
            candidates: scored,
            // Rejected candidates become warnings rather than disappearing.
            warnings: scored
                .filter((candidate) => !candidate.valid)
                .map((candidate) => ({
                    mode: candidate.mode,
                    lost: candidate.violations.map((v) => v.rule),
                    detail: candidate.violations[0] ? candidate.violations[0].detail : ''
                })),
            parts: this.extract(prompt),
            analysis: produced.analysis || null,
            overheadMs: overheadMs
        };
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterCompress = PromptMeterCompress;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterCompress };
}
