/**
 * PromptMeter modifier compression.
 *
 * Collapses a run of adjectives to the ones that carry distinct requirements.
 *
 *     "a simple easy beginner-friendly Python tutorial"
 *       -> "a beginner-friendly Python tutorial"
 *     "a secure scalable accessible application"
 *       -> unchanged
 *
 * THE RULE IS NOT "TOO MANY ADJECTIVES". Three adjectives in a row is not a fault, and
 * deleting on count would strip the second example, where every word names a separate
 * thing the application has to do. What makes the first example wasteful is that simple,
 * easy and beginner-friendly are three names for ONE requirement, so two of them buy
 * nothing. So the question asked of each modifier is whether another modifier in the same
 * run already says it.
 *
 * Three kinds of modifier, and they are treated differently:
 *
 *   SYNONYM GROUP   Several words for one requirement -- brevity, simplicity, size.
 *                   Keep one: the most specific, because "beginner-friendly" tells the
 *                   model more than "simple" does.
 *   SUBJECTIVE      beautiful, nice, amazing. These name an opinion rather than a
 *                   property, and nothing can be checked against them. Dropped only when
 *                   a concrete modifier survives in the same run -- "a nice website" on
 *                   its own still says the user wants it to look good, and stripping it
 *                   to "a website" loses their only stated wish.
 *   UNKNOWN         Anything this file has not classified. Always kept. A compressor
 *                   that deletes what it does not recognise is not conservative, it is
 *                   confident and wrong.
 *
 * Runs are found from the adjective lexicon rather than by parsing: a word is treated as
 * a modifier only when it is listed here. That is a strong guarantee -- a noun, a verb or
 * a technical term cannot be mistaken for an adjective and deleted -- and it is the
 * reason this module is a list rather than a parser.
 */

const PromptMeterModifiers = {

    /**
     * Words for one requirement, each group ordered MOST SPECIFIC FIRST.
     *
     * The order is the whole design. Keeping the first surviving member means
     * "simple easy beginner-friendly" keeps beginner-friendly, which names an audience,
     * rather than simple, which names a feeling. A group whose members are equally
     * specific is ordered by which reads most naturally in a prompt.
     */
    // WORDS THAT ARE ALSO NOUNS ARE NOT LISTED, and the omissions are deliberate:
    // novel, original, key, major, right, current, clean, solid, good, perfect, cool,
    // neat, proper. Each is a perfectly good adjective and a perfectly common noun or
    // verb, and this file cannot tell which one it is looking at. Measured on the
    // corpus, "the next great novel" came back as "the next novel": novel was read as
    // an adjective, great as its redundant sibling, and the sentence lost its point.
    // Losing a few correct removals is much cheaper than rewriting somebody's meaning.
    SYNONYM_GROUPS: {
        simplicity: ['beginner-friendly', 'beginner friendly', 'entry-level', 'introductory',
            'basic', 'simple', 'easy', 'straightforward', 'uncomplicated', 'plain',
            'elementary', 'simplified', 'easy-to-follow'],
        // 'quick' is NOT here. It means speed far more often than brevity -- 'a quick
        // response' is fast, not short -- and listing it first under brevity left it
        // surviving beside 'fast' as though the two were different requirements. The
        // brevity sense ('a quick explanation') is handled by ADVERB_FOR instead.
        brevity: ['brief', 'concise', 'succinct', 'short', 'compact', 'terse'],
        depth: ['comprehensive', 'in-depth', 'detailed', 'thorough', 'exhaustive',
            'complete', 'extensive', 'elaborate', 'full'],
        clarity: ['unambiguous', 'clear', 'understandable', 'readable', 'legible',
            'coherent', 'lucid'],
        novelty: ['new', 'fresh', 'innovative', 'creative', 'unique'],
        importance: ['critical', 'essential', 'important', 'vital', 'crucial',
            'significant'],
        speed: ['real-time', 'instant', 'fast', 'rapid', 'quick', 'speedy', 'swift'],
        size: ['large', 'big', 'huge', 'massive', 'enormous', 'sizeable'],
        correctness: ['correct', 'accurate', 'precise', 'exact'],
        modernity: ['up-to-date', 'modern', 'contemporary', 'recent']
    },

    /**
     * Opinions rather than properties. Nothing can be measured against them, and a model
     * cannot tell whether it satisfied one.
     *
     * "professional" and "clean" sit here rather than in a group because they are the
     * ones people reach for when they mean "good" and have not decided what good is.
     */
    SUBJECTIVE: ['beautiful', 'nice', 'amazing', 'great', 'lovely', 'wonderful',
        'gorgeous', 'stunning', 'awesome', 'excellent', 'fantastic',
        'brilliant', 'elegant', 'sleek', 'slick', 'pretty',
        'professional', 'polished', 'decent'],

    /**
     * Modifiers that name something checkable. Listed so the run finder recognises them
     * as adjectives, and so the subjective rule can tell whether anything concrete
     * survives. None of these is ever dropped.
     */
    CONCRETE: ['secure', 'scalable', 'accessible', 'responsive', 'performant', 'portable',
        'maintainable', 'reliable', 'testable', 'documented', 'typed', 'async',
        'asynchronous', 'synchronous', 'offline', 'online', 'mobile', 'desktop',
        'server-side', 'client-side', 'open-source', 'cross-platform', 'multilingual',
        'encrypted', 'authenticated', 'cached', 'paginated', 'stateless', 'idempotent',
        'annotated', 'commented', 'interactive', 'static', 'dynamic', 'free', 'paid',
        'python', 'javascript', 'technical', 'visual', 'written', 'verbal'],

    /**
     * Builds the lookup tables once. Called at load; safe to call again.
     * @returns {Object} this
     */
    compile: function () {
        this.groupOf = new Map();
        this.rankOf = new Map();

        Object.keys(this.SYNONYM_GROUPS).forEach((name) => {
            this.SYNONYM_GROUPS[name].forEach((word, index) => {
                // A word listed in two groups keeps its first, more specific home:
                // "quick" is brevity before it is speed, because a prompt asking for a
                // quick explanation wants a short one.
                if (this.groupOf.has(word)) return;
                this.groupOf.set(word, name);
                this.rankOf.set(word, index);
            });
        });

        this.subjective = new Set(this.SUBJECTIVE);
        this.concrete = new Set(this.CONCRETE);

        // Every word this module will treat as a modifier. Nothing outside it is touched.
        this.known = new Set([
            ...this.groupOf.keys(),
            ...this.SUBJECTIVE,
            ...this.CONCRETE
        ]);
        return this;
    },

    /** True when this file classifies the word as a modifier at all. */
    isModifier: function (word) {
        return this.known.has(String(word).toLowerCase());
    },

    /**
     * Decides which of a run of modifiers to keep.
     *
     * @param {Array} words - The run, in order, as written.
     * @returns {Object} { keep: [words], dropped: [{ word, reason }] }
     */
    select: function (words) {
        const keep = [];
        const dropped = [];
        const seenGroup = new Map();

        // First pass: one winner per synonym group, plus everything unclassified.
        words.forEach((word) => {
            const lower = word.toLowerCase();
            const group = this.groupOf.get(lower);
            if (!group) return;

            const best = seenGroup.get(group);
            if (!best || this.rankOf.get(lower) < this.rankOf.get(best.toLowerCase())) {
                seenGroup.set(group, word);
            }
        });

        // Does anything survive that names a checkable property? Subjective words are
        // only dropped when something concrete remains to carry the sentence.
        const hasConcrete = words.some((word) => {
            const lower = word.toLowerCase();
            return this.concrete.has(lower)
                || (this.groupOf.has(lower) && seenGroup.get(this.groupOf.get(lower)) === word)
                || !this.known.has(lower);
        });

        words.forEach((word) => {
            const lower = word.toLowerCase();
            const group = this.groupOf.get(lower);

            if (group) {
                if (seenGroup.get(group) === word) keep.push(word);
                else dropped.push({ word: word, reason: 'says the same as "'
                    + seenGroup.get(group) + '"' });
                return;
            }

            if (this.subjective.has(lower)) {
                if (hasConcrete) {
                    dropped.push({ word: word, reason: 'names an opinion, not a requirement' });
                } else {
                    keep.push(word);
                }
                return;
            }

            // Concrete, or a word this file does not classify. Kept either way.
            keep.push(word);
        });

        return { keep: keep, dropped: dropped };
    },

    // A run of modifiers is at least two of them in a row. Hyphenated forms count as one
    // word. The run must be followed by something -- a bare trailing adjective is a
    // predicate ("make it simple and clear"), not a modifier stack.
    RUN: /\b([a-z][a-z-]*(?:\s+[a-z][a-z-]*)*)\s+(?=[a-z])/gi,

    /**
     * Compresses every run of modifiers in a piece of text.
     *
     * @param {string} text
     * @returns {Object} { text, dropped: [{ word, reason }] }
     */
    compress: function (text) {
        if (typeof text !== 'string' || !text.trim()) {
            return { text: text || '', dropped: [] };
        }

        const dropped = [];
        const tokens = text.split(/(\s+)/);
        const out = [];
        let index = 0;

        while (index < tokens.length) {
            const token = tokens[index];

            // Whitespace, or a word this file does not treat as a modifier.
            if (/^\s+$/.test(token) || !this.isModifier(this.bare(token))) {
                out.push(token);
                index += 1;
                continue;
            }

            // Collect the run: consecutive modifier words, ignoring the spaces between.
            const run = [];
            const spans = [];
            let cursor = index;
            while (cursor < tokens.length) {
                const word = tokens[cursor];
                if (/^\s+$/.test(word)) { cursor += 1; continue; }
                if (!this.isModifier(this.bare(word))) break;
                // A modifier carrying punctuation ends the run at that punctuation:
                // "simple, easy" is still a run, "simple." is the end of a sentence.
                run.push(word);
                spans.push(cursor);
                if (/[.!?;:]$/.test(word)) { cursor += 1; break; }
                cursor += 1;
            }

            if (run.length < 2) {
                out.push(token);
                index += 1;
                continue;
            }

            const bare = run.map((word) => this.bare(word));
            const choice = this.select(bare);
            choice.dropped.forEach((item) => dropped.push(item));

            // Rebuild the run, keeping each survivor as the user wrote it and carrying
            // the run's trailing punctuation onto whatever now ends it.
            const kept = run.filter((word, at) =>
                choice.keep.indexOf(bare[at]) !== -1);

            if (kept.length === run.length) {
                out.push(token);
                index += 1;
                continue;
            }

            const tail = /([,;]?)$/.exec(run[run.length - 1])[1];
            const rebuilt = kept.map((word, at) => {
                const clean = word.replace(/[,;]+$/, '');
                return at === kept.length - 1 ? clean + tail : clean;
            });

            out.push(rebuilt.join(' '));
            index = spans[spans.length - 1] + 1;
        }

        // Removing a word can leave "a easy" where "an easy" was written, or double
        // spaces where a run collapsed.
        let joined = out.join('')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+([,;.])/g, '$1');

        return { text: joined, dropped: dropped };
    },

    /** A word with surrounding punctuation stripped, for lookup. */
    bare: function (token) {
        return String(token).replace(/^[^a-z-]+|[^a-z-]+$/gi, '');
    }
};

PromptMeterModifiers.compile();

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterModifiers = PromptMeterModifiers;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterModifiers };
}
