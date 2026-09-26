/**
 * PromptMeter prompt analysis.
 *
 * The optimizer answers one question -- what should this prompt say instead? -- and it
 * answers it by rewriting. That is the right shape for waste and for language errors,
 * and the wrong shape for everything else: a prompt that contradicts itself, or asks for
 * more than any answer can hold, or points at a file nobody attached, cannot be fixed by
 * a rewrite. Only the person who wrote it knows what they meant.
 *
 * So this module reports rather than rewrites. It runs a set of INDEPENDENT detectors,
 * each one answering a single question about the prompt, and returns structured findings:
 *
 *     { category, severity, span, explanation, suggestion, confidence, needsClarification }
 *
 * Independence is the point. A detector that has to know what the others found cannot be
 * reasoned about, tested or replaced on its own. They overlap freely and the merge
 * happens once, afterwards, in mergeFindings().
 *
 * TWO OUTPUTS, NOT ONE.
 *
 *     corrected   The user's own prompt with genuine language errors fixed. Their
 *                 wording, their structure, their intent -- just spelled right.
 *     optimized   The shorter, clearer rewrite the optimizer produces.
 *
 * They are separated because they carry different risk. A spelling fix is safe and a
 * user rarely wants to review it; a structural rewrite changes how the request reads and
 * they might reasonably decline it. Collapsing the two into a single "here is your new
 * prompt" hides that difference.
 *
 * SEVERITY IS NOT THE SAME AS IMPORTANCE. A missing output format is not an error -- the
 * prompt is not wrong, it is merely unspecified, and plenty of prompts do not need one.
 * The tiers say how certain the finding is, not how much it matters:
 *
 *     error        Wrong by a rule that does not depend on context.
 *     suggestion   Probably a problem, but context could make it fine.
 *     improvement  Not wrong. Shorter, clearer or better structured if changed.
 *
 * THE SEMANTIC SEAM. Several of these questions genuinely need to understand the prompt
 * rather than pattern-match it: whether a term is ambiguous IN CONTEXT, whether the task
 * is complete, whether two requirements actually conflict. setSemanticAnalyzer() accepts
 * a function that does that, and everything here works without one -- the deterministic
 * detectors run, the semantic ones are skipped, and the result says which. There is no
 * LLM in this repository and no API key: see the note on setSemanticAnalyzer.
 */

const PM_A_PROTECT = (typeof PromptMeterProtect !== 'undefined')
    ? PromptMeterProtect
    : (typeof require !== 'undefined' ? require('./protect.js').PromptMeterProtect : null);

const PM_A_OPTIMIZER = (typeof PromptMeterOptimizer !== 'undefined')
    ? PromptMeterOptimizer
    : (typeof require !== 'undefined' ? require('./optimizer.js').PromptMeterOptimizer : null);

const PM_A_TOKENIZER = (typeof PromptMeterTokenizer !== 'undefined')
    ? PromptMeterTokenizer
    : (typeof require !== 'undefined' ? require('./tokenizer.js').PromptMeterTokenizer : null);

const PromptMeterAnalysis = {

    CATEGORIES: [
        'spelling', 'grammar', 'punctuation', 'repetition', 'ambiguity',
        'missing-context', 'contradiction', 'scope', 'output-format', 'structure'
    ],

    SEVERITIES: ['error', 'suggestion', 'improvement'],

    // ---------------------------------------------------------------------------
    // Finding construction
    // ---------------------------------------------------------------------------

    /**
     * Builds one finding. Every field is named rather than positional, because a
     * detector that gets two of them the wrong way round produces a plausible-looking
     * result that is quietly wrong.
     *
     * @param {Object} parts
     * @param {string} parts.category - One of CATEGORIES.
     * @param {string} parts.severity - One of SEVERITIES.
     * @param {string} parts.explanation - Why this is a problem, in the user's terms.
     * @param {string} [parts.text] - The exact span the finding is about.
     * @param {number} [parts.start] - Offset of that span in the prompt.
     * @param {string} [parts.suggestion] - What to do instead. Omitted when only the
     *        author can decide -- an invented suggestion is an invented requirement.
     * @param {number} [parts.confidence] - 0..1. How sure the detector is.
     * @param {boolean} [parts.needsClarification] - True when the fix depends on
     *        something only the author knows.
     * @param {string} [parts.question] - The clarification to ask, if any.
     * @returns {Object}
     */
    finding: function (parts) {
        return {
            category: parts.category,
            severity: parts.severity,
            span: (parts.text === undefined || parts.text === null) ? null : {
                text: parts.text,
                start: typeof parts.start === 'number' ? parts.start : -1,
                end: typeof parts.start === 'number' ? parts.start + parts.text.length : -1
            },
            explanation: parts.explanation,
            suggestion: parts.suggestion || null,
            confidence: typeof parts.confidence === 'number' ? parts.confidence : 0.6,
            needsClarification: Boolean(parts.needsClarification),
            question: parts.question || null,
            source: parts.source || 'rule'
        };
    },

    // ---------------------------------------------------------------------------
    // Detectors. Each takes the prompt and returns an array of findings, and each
    // knows nothing about the others.
    // ---------------------------------------------------------------------------

    /**
     * Words repeated back to back, and whole phrases repeated in the prompt.
     *
     * "teh teh teh" is three tokens carrying one word of meaning. This is separate from
     * the optimizer's collapse of the same text: the optimizer fixes it silently, and a
     * user who cannot see WHY their prompt shrank has no reason to trust the rewrite.
     */
    detectRepetition: function (prompt, masked) {
        const findings = [];

        // Immediate repeats: "the the", "teh teh teh".
        const doubled = /\b(\w+)(\s+\1\b)+/gi;
        let match;
        while ((match = doubled.exec(masked)) !== null) {
            const times = match[0].trim().split(/\s+/).length;
            findings.push(this.finding({
                category: 'repetition',
                severity: 'error',
                text: match[0],
                start: match.index,
                explanation: '"' + match[1] + '" is repeated ' + times + ' times in a row.',
                suggestion: match[1],
                confidence: 0.97
            }));
        }

        // A content word used many times over. Three or more repeats of the same
        // non-trivial word is usually a prompt circling its own subject.
        const counts = new Map();
        const words = masked.toLowerCase().match(/[a-z]{5,}/g) || [];
        words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
        counts.forEach((count, word) => {
            if (count < 3) return;
            findings.push(this.finding({
                category: 'repetition',
                severity: 'improvement',
                text: word,
                explanation: '"' + word + '" appears ' + count + ' times. Saying it once is '
                    + 'usually enough.',
                confidence: 0.5
            }));
        });

        return findings;
    },

    // Numbers that constrain the answer, so two of them can be compared.
    QUANTITY: /\b(?:exactly|precisely|no more than|at most|at least|only|just|up to)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)\s+(\w+)/gi,

    WORD_NUMBERS: {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
        nine: 9, ten: 10, twenty: 20, fifty: 50, hundred: 100
    },

    /**
     * Requirements that pull against each other.
     *
     * Two shapes, because they fail differently. The first is a pair of opposing
     * adjectives in one breath -- "detailed but brief". The second is arithmetic: a
     * prompt that caps its own length and then asks for more content than the cap can
     * hold. "Write exactly five words and provide ten detailed examples" cannot be
     * satisfied, and no amount of rewriting fixes it -- only the author can say which
     * half they meant.
     */
    detectContradiction: function (prompt, masked) {
        const findings = [];

        const SHORT = 'brief|short|concise|succinct|quick|simple|minimal|summary';
        const LONG = 'detailed|comprehensive|thorough|exhaustive|in[\\s-]depth|complete|elaborate|extensive';
        const joiner = '(?:\\s+(?:but|yet|while|although|though|and)\\s+(?:also\\s+|still\\s+)?)';
        [
            new RegExp('\\b(?:' + SHORT + ')' + joiner + '(?:' + LONG + ')\\b', 'i'),
            new RegExp('\\b(?:' + LONG + ')' + joiner + '(?:' + SHORT + ')\\b', 'i')
        ].forEach((pattern) => {
            const hit = masked.match(pattern);
            if (!hit) return;
            findings.push(this.finding({
                category: 'contradiction',
                severity: 'error',
                text: hit[0],
                start: hit.index,
                explanation: 'These two requirements pull against each other, so the model '
                    + 'has to pick one and you do not get to choose which.',
                confidence: 0.85,
                needsClarification: true,
                question: 'Which matters more here, brevity or detail?'
            }));
        });

        // A hard length cap next to a request for content that cannot fit inside it.
        const cap = masked.match(/\b(?:exactly|no more than|at most|only|just|in)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(words?|sentences?|lines?|characters?)\b/i);
        if (cap) {
            const size = this.WORD_NUMBERS[cap[1].toLowerCase()] || parseInt(cap[1], 10);
            const unit = cap[2].toLowerCase();
            const demand = masked.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple)\s+(?:\w+\s+){0,2}?(examples?|points?|reasons?|steps?|items?|paragraphs?|sections?)\b/i);

            if (demand) {
                const many = this.WORD_NUMBERS[demand[1].toLowerCase()]
                    || parseInt(demand[1], 10) || 3;
                // One example cannot be built from fewer than a couple of words, so a cap
                // below the count is unsatisfiable however generously it is read.
                const impossible = /^words?$/.test(unit) ? size < many * 2 : size < many;
                if (impossible) {
                    findings.push(this.finding({
                        category: 'contradiction',
                        severity: 'error',
                        text: cap[0] + ' ... ' + demand[0],
                        explanation: 'The prompt caps the answer at ' + size + ' ' + unit
                            + ' and also asks for ' + many + ' ' + demand[2].toLowerCase()
                            + '. Both cannot be satisfied at once.',
                        confidence: 0.9,
                        needsClarification: true,
                        question: 'Should the ' + size + ' ' + unit + ' limit apply, or the '
                            + many + ' ' + demand[2].toLowerCase() + '?'
                    }));
                }
            }
        }

        return findings;
    },

    // Phrases that ask for an unbounded amount of answer.
    UNBOUNDED: [
        [/\b(?:explain|cover|include|tell me)\s+everything\b/i,
            'asks for "everything", which has no end'],
        [/\bevery(?:thing|\s+(?:detail|aspect|possible|single))\b/i,
            'asks for every case, which no single answer can cover'],
        [/\b(?:all|complete|full|entire)\s+(?:the\s+)?(?:details|topics|algorithms|concepts|methods|cases|history)\b/i,
            'asks for a complete survey of a whole field'],
        [/\bfrom\s+scratch\b.*\bproduction[\s-]ready\b/i,
            'asks for a production system built from nothing'],
        [/\bteach\s+me\s+(?:everything|all)\b/i, 'asks to be taught a whole subject at once']
    ],

    /**
     * Requests too large for one answer.
     *
     * Distinct from the optimizer's scope rules, which score a prompt on how many
     * deliverables it names. This asks a narrower question: does the prompt contain a
     * phrase that removes the boundary altogether? "Explain everything" is not a long
     * request, it is an unbounded one, and the two need different advice.
     */
    detectUnrealisticScope: function (prompt, masked) {
        const findings = [];

        this.UNBOUNDED.forEach((rule) => {
            const hit = masked.match(rule[0]);
            if (!hit) return;
            findings.push(this.finding({
                category: 'scope',
                severity: 'suggestion',
                text: hit[0],
                start: hit.index,
                explanation: 'This ' + rule[1] + '. The model will pick an arbitrary '
                    + 'subset, and it may not be the part you wanted.',
                confidence: 0.8,
                needsClarification: true,
                question: 'Which parts matter most? Naming two or three gets a better '
                    + 'answer than asking for all of them.'
            }));
        });

        // A chain of "and"s in a single request is several requests wearing one coat.
        const conjunctions = (masked.match(/\band\b/gi) || []).length;
        if (conjunctions >= 3 && masked.split(/\s+/).length < 60) {
            findings.push(this.finding({
                category: 'scope',
                severity: 'improvement',
                explanation: 'This joins ' + (conjunctions + 1) + ' requests with "and". '
                    + 'Asking them one at a time usually gets a better answer to each.',
                confidence: 0.55
            }));
        }

        return findings;
    },

    // Words whose referent has to be guessed.
    VAGUE_QUALITY: /\b(good|better|best|nice|proper|decent|clean|modern|professional|beautiful|optimal|efficient)\b/gi,

    /**
     * Terms that do not pin anything down, and references with nothing to refer to.
     *
     * "Make it good" names a quality nobody can check. The finding carries no
     * suggestion on purpose: what "good" means here is exactly the thing the prompt
     * failed to say, and filling it in would be inventing a requirement.
     */
    detectAmbiguity: function (prompt, masked) {
        const findings = [];
        const seen = new Set();
        let match;

        // One finding for all of them, not one each. "a nice clean modern professional
        // website" has four of these words and one problem, and four near-identical
        // rows is the kind of panel people learn to scroll past.
        const vague = [];
        let first = -1;
        this.VAGUE_QUALITY.lastIndex = 0;
        while ((match = this.VAGUE_QUALITY.exec(masked)) !== null) {
            const word = match[1].toLowerCase();
            if (seen.has(word)) continue;
            seen.add(word);
            vague.push(match[1]);
            if (first === -1) first = match.index;
        }

        if (vague.length) {
            const list = vague.map((w) => '"' + w + '"').join(', ');
            findings.push(this.finding({
                category: 'ambiguity',
                severity: 'suggestion',
                text: vague[0],
                start: first,
                explanation: vague.length === 1
                    ? list + ' means something different to everyone. The model will '
                        + 'guess a definition and answer against that.'
                    : list + ' each mean something different to everyone, so none of '
                        + 'them narrows the answer.',
                confidence: 0.7,
                needsClarification: true,
                question: 'What would make it ' + list.split(', ')[0] + ' for you? '
                    + 'One or two concrete properties is enough.'
            }));
        }

        // A pronoun opening the prompt has nothing behind it to refer to.
        const opener = masked.match(/^\s*(?:make|fix|improve|change|update|rewrite|do)\s+(it|this|that|them|these|those)\b/i);
        if (opener) {
            findings.push(this.finding({
                category: 'ambiguity',
                severity: 'error',
                text: opener[1],
                start: opener.index,
                explanation: '"' + opener[1] + '" is the first thing the prompt mentions, '
                    + 'so there is nothing for it to point at.',
                confidence: 0.85,
                needsClarification: true,
                question: 'What should be changed? Paste it or name it.'
            }));
        }

        return findings;
    },

    // Requests that produce something buildable, where a stack or audience changes
    // the answer substantially.
    // The adjective slot matters: "make a nice clean modern professional website" is
    // the same request as "make a website", and without it the detector missed every
    // prompt that described what it wanted before naming it.
    BUILD_REQUEST: /\b(?:create|build|make|write|design|develop|implement)\s+(?:a|an|the|me\s+a)?\s*(?:\w+\s+){0,4}?(website|web\s?app|app|application|api|service|dashboard|game|bot|script|tool|system|platform)\b/i,

    /**
     * Context the answer depends on and the prompt did not supply.
     *
     * Deliberately narrow, and deliberately not an error. A prompt that omits its
     * audience is not wrong -- most prompts omit most things, and a detector that says
     * so on every prompt is noise. This fires only where the missing piece changes the
     * shape of the answer rather than its polish.
     */
    detectMissingContext: function (prompt, masked) {
        const findings = [];

        const build = masked.match(this.BUILD_REQUEST);
        if (build) {
            const hasPurpose = /\b(?:for|that|which|to)\s+\w+/i.test(masked.slice(build.index + build[0].length));
            const hasAudience = /\b(?:for|aimed at|targeting)\s+(?:a|an|my|our|beginners?|students?|clients?|users?|kids?|children)/i.test(masked);
            if (!hasPurpose && !hasAudience) {
                findings.push(this.finding({
                    category: 'missing-context',
                    severity: 'suggestion',
                    text: build[0],
                    start: build.index,
                    explanation: 'The prompt asks for a ' + build[1].toLowerCase()
                        + ' without saying what it is for. What it does changes almost '
                        + 'every decision in the answer.',
                    confidence: 0.6,
                    needsClarification: true,
                    question: 'What should the ' + build[1].toLowerCase() + ' do, and who '
                        + 'is it for?'
                }));
            }
        }

        return findings;
    },

    // ---------------------------------------------------------------------------
    // Semantic seam
    // ---------------------------------------------------------------------------

    semanticAnalyzer: null,
    semanticName: null,

    /**
     * Registers a contextual analyzer -- a language model, a local model, an API.
     *
     * THERE IS NONE IN THIS REPOSITORY, AND THAT IS DELIBERATE. PromptMeter runs in a
     * content script on every keystroke and its premise is that prompt text never leaves
     * the machine; calling a hosted model would break both. The seam exists so that a
     * host WITH a model -- the dashboard, a build that bundles a small local one, an
     * opt-in provider the user configures -- can supply one, exactly as
     * PromptMeterTokenizer.setEncoder() accepts a real BPE encoder.
     *
     * ml/generate_synthetic.py already speaks to Anthropic and OpenAI and is the natural
     * place to wire one for offline analysis of a corpus.
     *
     * @param {Function} analyze - async (prompt) => Array of raw findings. Each may
     *        carry category, severity, explanation, suggestion, confidence, text.
     * @param {string} [name] - For the UI and for debugging.
     * @returns {boolean} False when the argument is not callable.
     */
    setSemanticAnalyzer: function (analyze, name) {
        if (typeof analyze !== 'function') return false;
        this.semanticAnalyzer = analyze;
        this.semanticName = name || 'semantic';
        return true;
    },

    /** Whether contextual analysis is available at all. */
    hasSemanticAnalyzer: function () {
        return this.semanticAnalyzer !== null;
    },

    /**
     * Runs the registered analyzer, if there is one.
     *
     * Everything it returns is normalised through finding() and marked source:
     * 'semantic', so a reader can always tell which findings were reasoned about and
     * which were pattern-matched. A model that throws, times out or returns nonsense
     * leaves the deterministic findings untouched -- contextual analysis is an addition
     * here, never a dependency.
     *
     * @param {string} prompt
     * @returns {Promise<Array>}
     */
    runSemantic: function (prompt) {
        if (!this.semanticAnalyzer) return Promise.resolve([]);

        return Promise.resolve()
            .then(() => this.semanticAnalyzer(prompt))
            .then((raw) => (Array.isArray(raw) ? raw : []).map((item) => this.finding({
                category: this.CATEGORIES.indexOf(item.category) !== -1
                    ? item.category : 'ambiguity',
                severity: this.SEVERITIES.indexOf(item.severity) !== -1
                    ? item.severity : 'suggestion',
                text: item.text,
                start: typeof item.start === 'number'
                    ? item.start
                    : (item.text ? prompt.indexOf(item.text) : undefined),
                explanation: item.explanation || 'Flagged by contextual analysis.',
                suggestion: item.suggestion,
                // A model's own confidence is its opinion of itself. It is capped so a
                // contextual finding never outranks a deterministic one that the code
                // can actually justify.
                confidence: Math.min(0.9, typeof item.confidence === 'number' ? item.confidence : 0.6),
                needsClarification: item.needsClarification,
                question: item.question,
                source: 'semantic'
            })))
            .catch((error) => {
                console.warn('[PromptMeter] semantic analysis failed; '
                    + 'using the deterministic findings only.', error);
                return [];
            });
    },

    // ---------------------------------------------------------------------------
    // Merge
    // ---------------------------------------------------------------------------

    SEVERITY_RANK: { error: 0, suggestion: 1, improvement: 2 },

    /**
     * Whether two findings are about the same part of the prompt.
     *
     * A finding with no span is treated as covering whatever its category covers,
     * so a rule that says "this prompt is vague" merges with one that says
     * "'good' is vague" and the located one keeps its span. Two spans match when
     * they overlap at all, not when they are equal: "explain everything" and
     * "everything" are two readings of one phrase.
     *
     * @param {Object} a
     * @param {Object} b
     * @returns {boolean}
     */
    sameGround: function (a, b) {
        if (!a.span || !b.span) return true;
        if (a.span.start < 0 || b.span.start < 0) {
            const x = a.span.text.toLowerCase();
            const y = b.span.text.toLowerCase();
            return x === y || x.indexOf(y) !== -1 || y.indexOf(x) !== -1;
        }
        return a.span.start < b.span.end && b.span.start < a.span.end;
    },

    /**
     * Removes duplicates without losing distinct problems.
     *
     * Two findings are the same problem when they are the same category over the same
     * span. Same span, different category is NOT a duplicate: "make it good" is both
     * ambiguous and missing an output format, and collapsing those would drop half the
     * advice. When two do merge, the more certain reading wins and the higher confidence
     * is kept, because one detector having a clearer view is the normal case.
     *
     * @param {Array} findings
     * @returns {Array} Sorted by severity, then confidence.
     */
    mergeFindings: function (findings) {
        const kept = [];

        (findings || []).forEach((item) => {
            if (!item || !item.explanation) return;

            // Same category over the same ground is one problem, however two
            // detectors worded it. Exact span equality is not enough: two rules can
            // match "explain everything" and "everything", and a rule with no span
            // at all can be describing the very thing another one located.
            const existing = kept.find((other) =>
                other.category === item.category && this.sameGround(other, item));

            if (!existing) {
                kept.push(item);
                return;
            }

            if (this.SEVERITY_RANK[item.severity] < this.SEVERITY_RANK[existing.severity]) {
                existing.severity = item.severity;
            }
            // The better-evidenced detector also wrote the better sentence: a rule
            // that located the exact word can say more than one that only knows the
            // prompt is vague somewhere. Take its wording along with its confidence.
            if (item.confidence > existing.confidence) {
                existing.explanation = item.explanation;
                if (item.question) existing.question = item.question;
                if (item.span) existing.span = item.span;
            }
            existing.confidence = Math.max(existing.confidence, item.confidence);
            existing.needsClarification = existing.needsClarification || item.needsClarification;
            if (!existing.suggestion && item.suggestion) existing.suggestion = item.suggestion;
            if (!existing.question && item.question) existing.question = item.question;
            // A finding both a rule and a model reached is better evidenced than either.
            if (existing.source !== item.source) existing.source = 'rule+semantic';
            // Keep whichever span actually locates the problem.
            if (!existing.span && item.span) existing.span = item.span;
        });

        return kept.sort((a, b) => (
            this.SEVERITY_RANK[a.severity] - this.SEVERITY_RANK[b.severity] ||
            b.confidence - a.confidence
        ));
    },

    // ---------------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------------

    /**
     * Analyses a prompt and produces both outputs.
     *
     * Synchronous, and therefore deterministic-only. Contextual analysis is async by
     * nature; analyzeWithSemantics() is the version that waits for it. The split is so
     * the card can render immediately on a keystroke and fill in the slower findings
     * when they arrive, rather than showing nothing until a model replies.
     *
     * @param {string} prompt
     * @returns {Object} {
     *     findings, corrected, optimized, clarifications, assumptions, tokens,
     *     semanticAvailable
     *   }
     */
    analyze: function (prompt) {
        const empty = {
            findings: [], corrected: '', optimized: '', clarifications: [],
            assumptions: [], tokens: null, semanticAvailable: this.hasSemanticAnalyzer()
        };
        if (typeof prompt !== 'string' || !prompt.trim()) return empty;

        // Detectors read the MASKED text so a pronoun inside a code sample, or the word
        // "good" inside a quoted passage, is not the user's own vagueness.
        const masked = PM_A_PROTECT ? PM_A_PROTECT.mask(prompt).masked : prompt;

        const report = PM_A_OPTIMIZER
            ? PM_A_OPTIMIZER.optimizeWithReport(prompt)
            : { text: prompt, grammar: [], scope: [] };

        const language = (report.grammar || []).map((issue) => this.finding({
            category: issue.type === 'spelling' ? 'spelling'
                : (issue.type === 'punctuation' || issue.type === 'capitalization')
                    ? 'punctuation' : 'grammar',
            severity: issue.severity || 'suggestion',
            explanation: issue.label,
            // The optimizer has already applied these, so the suggestion is the fix
            // itself rather than advice about it.
            confidence: issue.severity === 'error' ? 0.95 : 0.7
        }));

        const quality = PM_A_OPTIMIZER
            ? PM_A_OPTIMIZER.qualityIssues(prompt).map((issue) => this.finding({
                category: issue.id === 'missing-output-format' ? 'output-format'
                    : issue.id === 'dangling-reference' ? 'missing-context'
                        : issue.id === 'contradiction' ? 'contradiction'
                            : issue.id === 'vague-specification' ? 'ambiguity'
                                : issue.id === 'no-clear-request' ? 'ambiguity'
                                    : 'structure',
                severity: issue.id === 'dangling-reference' || issue.id === 'no-clear-request'
                    ? 'error' : 'suggestion',
                // issue.label is the user-facing sentence; issue.metric is the rule's
                // own definition and reads like documentation ("Fires when...").
                explanation: issue.label,
                detail: issue.metric,
                confidence: 0.65,
                needsClarification: issue.id !== 'truncated-instruction'
            }))
            : [];

        const structural = (report.scope || []).map((issue) => this.finding({
            category: 'scope',
            severity: 'improvement',
            explanation: issue.label,
            confidence: 0.6
        }));

        const findings = this.mergeFindings([].concat(
            language,
            quality,
            structural,
            this.detectRepetition(prompt, masked),
            this.detectContradiction(prompt, masked),
            this.detectUnrealisticScope(prompt, masked),
            this.detectAmbiguity(prompt, masked),
            this.detectMissingContext(prompt, masked)
        ));

        return {
            findings: findings,
            corrected: this.correctOnly(prompt),
            optimized: report.text,
            clarifications: findings
                .filter((item) => item.needsClarification && item.question)
                .map((item) => item.question)
                .filter((question, index, all) => all.indexOf(question) === index),
            // Nothing is assumed on the user's behalf. The field exists so a host that
            // DOES make assumptions has somewhere honest to declare them.
            assumptions: [],
            tokens: PM_A_TOKENIZER ? PM_A_TOKENIZER.stats(prompt, report.text) : null,
            semanticAvailable: this.hasSemanticAnalyzer()
        };
    },

    /**
     * The prompt with language errors fixed and nothing else touched.
     *
     * This is the conservative output: the user's own wording, their own structure,
     * their own order. Only spelling, grammar and the punctuation the grammar engine
     * repairs. None of the stripping, merging or rewriting the optimizer does.
     *
     * @param {string} prompt
     * @returns {string}
     */
    correctOnly: function (prompt) {
        if (typeof prompt !== 'string' || !prompt.trim()) return '';
        if (!PM_A_PROTECT || !PM_A_OPTIMIZER) return prompt;

        const masked = PM_A_PROTECT.mask(prompt);
        let fixed = PM_A_OPTIMIZER.correctGrammarAndSpelling(masked.masked, []);

        // An immediately repeated word is a language error, not a style choice, so
        // it belongs in the corrected output too -- "teh teh teh" spell-corrects to
        // "the the the", which is still not English. Numbers are excluded: two
        // adjacent identical numbers are usually one value ("1 1/2").
        fixed = fixed.replace(/\b(?!\d)(\w+)(\s+\1\b)+/gi, '$1');

        return PM_A_PROTECT.unmask(fixed, masked.spans);
    },

    /**
     * analyze(), plus whatever the registered contextual analyzer adds.
     * @param {string} prompt
     * @returns {Promise<Object>} The same shape as analyze().
     */
    analyzeWithSemantics: function (prompt) {
        const base = this.analyze(prompt);
        if (!this.hasSemanticAnalyzer()) return Promise.resolve(base);

        return this.runSemantic(prompt).then((semantic) => {
            const findings = this.mergeFindings(base.findings.concat(semantic));
            return Object.assign({}, base, {
                findings: findings,
                clarifications: findings
                    .filter((item) => item.needsClarification && item.question)
                    .map((item) => item.question)
                    .filter((question, index, all) => all.indexOf(question) === index)
            });
        });
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterAnalysis = PromptMeterAnalysis;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterAnalysis };
}
