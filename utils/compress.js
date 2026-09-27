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
        /\bin\s+(?:python|javascript|typescript|java|c\+\+|c#|go|rust|ruby|php|sql)\s*\d*\.?\d*/gi
    ],

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
        .concat(text.match(/"[^"\n]{4,}"/g) || []),

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

        // Numbers. A changed numeral is a changed requirement -- "under 300 words"
        // becoming "under 30 words" is a different prompt that still reads fine.
        const beforeNumbers = this.numbersIn(original);
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
            const kept = carriers.filter((word) => present.has(word)).length;
            const lostMeaning = carriers.length > 0 && kept * 2 < carriers.length;

            if (lostNumber || lostMeaning) {
                violations.push({ rule: 'constraint', detail: constraint });
            }
        });

        // A named output format must still be named.
        const candidateFormats = new Set((candidate.match(this.OUTPUT_FORMATS) || [])
            .map((f) => f.toLowerCase()));
        parts.format.forEach((format) => {
            if (!candidateFormats.has(format)) {
                violations.push({ rule: 'format', detail: format });
            }
        });

        // The task itself. If the original asked to explain, the candidate may not ask
        // to write -- compression may shorten a request, never redirect it.
        const taskVerb = (text) => {
            const hit = /\b(explain|write|create|build|make|give|list|show|tell|describe|compare|summari[sz]e|translate|fix|debug|generate|design|draft|suggest|recommend|calculate|solve|analy[sz]e|review|rewrite|convert|implement|teach|outline)\b/i.exec(text);
            return hit ? hit[1].toLowerCase() : null;
        };
        const before = taskVerb(original);
        const after = taskVerb(candidate);
        if (before && after && before !== after) {
            violations.push({ rule: 'task', detail: before + ' -> ' + after });
        }
        if (before && !after) {
            violations.push({ rule: 'task', detail: 'the request verb is gone' });
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
            .filter((word) => !originalWords.has(word));
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
    candidates: function (prompt, budgetMs) {
        const budget = typeof budgetMs === 'number' ? budgetMs : this.DEFAULT_BUDGET_MS;
        const started = Date.now();
        const out = [];
        const spent = () => Date.now() - started;

        if (!PM_C_ANALYSIS || !PM_C_OPTIMIZER) return out;

        // One call produces both tiers: analyze() returns the corrected text and the
        // optimized text together. Budget-checking between them would discard the
        // better one after paying for it, which is what an earlier version did -- a
        // prompt that compressed 51 tokens to 27 shipped at 49 because the clock ran
        // out on a candidate that was already in hand.
        const analysis = PM_C_ANALYSIS.analyze(prompt);
        out.push({ mode: 'conservative', text: analysis.corrected, ms: spent() });
        out.push({ mode: 'balanced', text: analysis.optimized, ms: spent() });

        // The aggressive tier is the first one that costs anything extra, so it is the
        // first the budget can refuse. It also only earns its cost on a prompt with room
        // to lose: below this there is nothing for a second condensing pass to find.
        const words = prompt.split(/\s+/).filter(Boolean).length;
        if (spent() >= budget || words < 12 || !PM_C_CONDENSE) return out;

        // Raising the new-terms floor keeps FEWER sentences: a sentence now has to carry
        // four unseen content words to survive, not two.
        const harder = PM_C_CONDENSE.condense(analysis.optimized,
            { minWords: 6, minNewTerms: 4 });
        if (harder && harder !== analysis.optimized) {
            out.push({ mode: 'aggressive', text: harder, ms: spent() });
        }

        return out;
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
     * @param {number} [options.repeats] - How many times this prompt will be sent, for
     *        the net-saving figure. Defaults to 1.
     * @returns {Object} {
     *     original, text, mode, tokens, candidates, warnings, parts, overheadMs
     *   }
     */
    compress: function (prompt, options) {
        const settings = options || {};
        const started = Date.now();

        const blank = {
            original: prompt || '', text: prompt || '', mode: 'none',
            tokens: null, candidates: [], warnings: [], parts: this.extract(''),
            overheadMs: 0
        };
        if (typeof prompt !== 'string' || !prompt.trim()) return blank;

        const produced = this.candidates(prompt, settings.budgetMs);
        const originalTokens = PM_C_TOKENIZER ? PM_C_TOKENIZER.countTokens(prompt) : 0;

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

        const usable = scored.filter((candidate) =>
            candidate.valid && candidate.tokens < originalTokens
            && (!settings.mode || candidate.mode === settings.mode));

        // Shortest wins. Ties go to the gentler tier, which is the order they arrive in.
        let chosen = null;
        usable.forEach((candidate) => {
            if (!chosen || candidate.tokens < chosen.tokens) chosen = candidate;
        });

        const text = chosen ? chosen.text : prompt;
        const finalTokens = chosen ? chosen.tokens : originalTokens;
        const overheadMs = Date.now() - started;
        const repeats = Math.max(1, settings.repeats || 1);

        return {
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
