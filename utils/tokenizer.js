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

    // Consecutive encoder failures. One bad input is not a broken encoder, and treating
    // it as one used to cost every later count in the session its precision.
    encoderFailures: 0,
    MAX_ENCODER_FAILURES: 3,

    // ChatGPT's own control markers, written out as text. A prompt containing the
    // literal "<|endofprompt|>" is refused by tiktoken -- it will not encode a special
    // token it was not told to allow -- and the bundled encoder does not forward the
    // option that permits it. This is not exotic: it is what a user types when asking
    // about prompt injection, chat templates or the format itself, and the corpus
    // contains such prompts.
    SPECIAL_RX: /<\|[^<>]{0,64}?\|>/g,

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
        this.encoderFailures = 0;
        this.cache.clear();
        return true;
    },

    /** True when counts come from a real encoder rather than the heuristic. */
    isExact: function () {
        return this.encoder !== null;
    },

    /**
     * Counts text containing literal special-token markers, by encoding around them.
     *
     * Each marker is encoded in two pieces so the encoder never sees a whole special
     * token and therefore never refuses it. Splitting prevents a few byte-pair merges
     * across the seams, so the total can be a token high -- measured at 10 against 9 for
     * a string identical but for one letter inside the marker. That is the honest cost,
     * and it buys an exact-ish count for a prompt that would otherwise have fallen back
     * to the heuristic AND taken every later count in the session with it.
     *
     * @param {string} text
     * @returns {number}
     */
    countAroundSpecial: function (text) {
        let total = 0;
        let last = 0;
        let hit;
        this.SPECIAL_RX.lastIndex = 0;
        while ((hit = this.SPECIAL_RX.exec(text)) !== null) {
            if (hit.index > last) {
                total += this.encoder(text.slice(last, hit.index)).length;
            }
            total += this.encoder(hit[0].slice(0, 1)).length
                + this.encoder(hit[0].slice(1)).length;
            last = hit.index + hit[0].length;
            // A zero-length match would spin here forever.
            if (this.SPECIAL_RX.lastIndex === hit.index) this.SPECIAL_RX.lastIndex++;
        }
        if (last < text.length) total += this.encoder(text.slice(last)).length;
        return total;
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
                this.encoderFailures = 0;
            } catch (err) {
                // TWO DIFFERENT FAILURES, and they used to be treated as one. Text the
                // encoder refuses is a property of THAT text; a broken encoder is a
                // property of the session. Retiring the encoder on the first refusal
                // meant one prompt containing "<|endofprompt|>" silently cost every
                // later count in the session its precision -- and printed a stack trace
                // on the user's page while doing it.
                try {
                    count = this.countAroundSpecial(text);
                    this.encoderFailures = 0;
                } catch (again) {
                    this.encoderFailures++;
                    if (this.encoderFailures >= this.MAX_ENCODER_FAILURES) {
                        console.error('[PromptMeter] token encoder failed '
                            + this.encoderFailures + ' times; using the estimate from '
                            + 'here on.', again);
                        this.encoder = null;
                        this.encoderName = null;
                    }
                    count = this.estimate(text);
                }
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
        // NOT clamped at zero. A rewrite can legitimately cost tokens -- correcting
        // "Explan" to "Explain" and "fnite" to "finite" adds characters, and expanding
        // an abbreviation adds words. Reporting that as "0 saved, 0%" tells the user
        // the change was free when it was not, and hides the one case where they
        // might reasonably decline it. Callers must handle a negative.
        const saved = before - after;

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
