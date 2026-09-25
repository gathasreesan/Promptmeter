/**
 * PromptMeter Tokenizer
 *
 * Counts tokens two ways and is honest about which one it used.
 *
 *   EXACT       A real BPE encoder, registered by the host page through setEncoder().
 *               utils/tiktoken.bundle.js supplies one when it is present.
 *   ESTIMATE    A character/word heuristic. Always available, never blocks, and is what
 *               the extension falls back to when no encoder is registered.
 *
 * Why the seam rather than importing a tokenizer directly: the content script is not
 * bundled. Every file in utils/ is loaded as a plain script from the manifest, so an npm
 * package cannot simply be required here. The encoder is injected instead, which also
 * keeps the ~1.7MB cl100k rank table out of the load path for anyone who has not built
 * it in.
 *
 * isExact() exists so the UI can say "5 tokens" versus "~5 tokens" truthfully. A carbon
 * figure derived from a guess should not be presented as a measurement.
 */
const PromptMeterTokenizer = {

    // Registered by setEncoder(). Null means fall back to the heuristic.
    encoder: null,
    encoderName: null,

    /**
     * Registers a BPE encoder.
     *
     * @param {Function} encode - Takes a string, returns an array of token ids (or any
     *        array-like whose length is the token count).
     * @param {string} name - Encoding name, for the UI and for debugging ("cl100k_base").
     */
    setEncoder: function (encode, name) {
        if (typeof encode !== 'function') return false;
        this.encoder = encode;
        this.encoderName = name || 'bpe';
        this.cache.clear();
        return true;
    },

    /** True when counts come from a real encoder rather than the heuristic. */
    isExact: function () {
        return this.encoder !== null;
    },

    /** Which encoding is in use, or "heuristic". */
    encoding: function () {
        return this.encoderName || 'heuristic';
    },

    // Counting runs on every keystroke, and the same prompt is re-counted as the user
    // pauses. A small cache keeps a real BPE encoder off the critical path without any
    // scheduling machinery.
    cache: new Map(),
    CACHE_LIMIT: 200,

    /**
     * Token count for a piece of text.
     *
     * @param {string} text
     * @returns {number} Tokens. 0 for empty or non-string input.
     */
    countTokens: function (text) {
        if (typeof text !== 'string' || text.trim() === '') return 0;

        const hit = this.cache.get(text);
        if (hit !== undefined) return hit;

        let count;
        if (this.encoder) {
            try {
                count = this.encoder(text).length;
            } catch (err) {
                // A broken encoder must not take the extension down with it. Drop back to
                // the heuristic permanently rather than throwing on every keystroke.
                console.error('[PromptMeter] token encoder failed, using the estimate.', err);
                this.encoder = null;
                this.encoderName = null;
                count = this.estimate(text);
            }
        } else {
            count = this.estimate(text);
        }

        // Plain FIFO eviction: insertion order is what Map iterates, so the oldest key is
        // the first one. Good enough for a 200-entry cache on one page.
        if (this.cache.size >= this.CACHE_LIMIT) {
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(text, count);
        return count;
    },

    /**
     * Heuristic estimate, used when no encoder is registered.
     *
     * Blends the two rules of thumb OpenAI publishes -- about 1.33 tokens per word, and
     * about one token per four characters -- because each is wrong in a different
     * direction: the word rule under-counts long or unusual words, and the character rule
     * over-counts ordinary prose. CJK text has no spaces, so the word rule degenerates
     * there and the character rule carries the estimate on its own.
     *
     * @param {string} text
     * @returns {number}
     */
    estimate: function (text) {
        const clean = text.trim();
        const chars = clean.length;
        const words = clean.split(/\s+/).filter(Boolean).length;

        const charEstimate = Math.round(chars / 4);
        // Below roughly one space per twenty characters the text is not word-delimited.
        if (words === 0 || chars / words > 20) return Math.max(1, charEstimate);

        const wordEstimate = Math.round(words * 1.33);
        return Math.max(1, Math.round((wordEstimate + charEstimate) / 2));
    },

    /**
     * Before/after counts for one optimization.
     *
     * @param {string} original
     * @param {string} optimized
     * @returns {Object} { originalTokens, optimizedTokens, saved, percent, exact, encoding }
     */
    stats: function (original, optimized) {
        const before = this.countTokens(original);
        const after = this.countTokens(optimized);
        const saved = Math.max(0, before - after);

        return {
            originalTokens: before,
            optimizedTokens: after,
            saved: saved,
            percent: before > 0 ? Math.round((saved / before) * 100) : 0,
            exact: this.isExact(),
            encoding: this.encoding()
        };
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterTokenizer = PromptMeterTokenizer;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterTokenizer };
}
