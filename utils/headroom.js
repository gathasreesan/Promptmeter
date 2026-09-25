/**
 * PromptMeter Context Headroom
 *
 * Estimates how much of a model's context window a conversation has used, and how much
 * is left for the next prompt.
 *
 *     remaining = max(0, contextLimit - estimatedUsedTokens - reservedOutputTokens)
 *
 * EVERYTHING HERE IS AN ESTIMATE, and the gap is not small. A content script sees the
 * text in the page. It cannot see:
 *
 *   - the system prompt, which is not in the DOM
 *   - tools, function definitions or retrieved documents the server attaches
 *   - server-side truncation or summarisation of older turns
 *   - images, files and audio, whose token cost is not a function of their text
 *   - the model's own reasoning tokens, where the model produces them
 *
 * So the true figure is always HIGHER than what this reports, and by an unknown margin.
 * report() therefore returns `estimate: true` and callers must present the number as an
 * estimate. A user who trusts a "62% used" readout and then loses the start of their
 * conversation has been misled by this module.
 *
 * Context limits are NOT hard-coded per model. Published limits change, differ by tier,
 * and are not observable from the page, so guessing one and labelling it "GPT-4" would be
 * inventing a fact. configure() takes the limit; the default is deliberately generic.
 */
const PromptMeterHeadroom = {

    config: {
        // Tokens the window holds in total. Generic on purpose -- see the note above.
        // The UI should let the user set this for whatever model they are actually using.
        contextLimit: 8192,

        // Held back so the model has room to answer. A prompt that fills the window
        // leaves nothing for a reply.
        reservedOutputTokens: 1024,

        // Fraction of usable space below which the report starts warning.
        warnBelow: 0.20,
        criticalBelow: 0.08
    },

    /**
     * Overrides any subset of the configuration.
     * @param {Object} settings - Any of contextLimit, reservedOutputTokens, warnBelow,
     *        criticalBelow. Unknown keys and invalid values are ignored.
     * @returns {Object} The configuration in force after the update.
     */
    configure: function (settings) {
        if (!settings || typeof settings !== 'object') return this.config;

        const positive = ['contextLimit', 'reservedOutputTokens'];
        for (const key of positive) {
            const value = settings[key];
            if (typeof value === 'number' && isFinite(value) && value >= 0) {
                this.config[key] = Math.floor(value);
            }
        }
        for (const key of ['warnBelow', 'criticalBelow']) {
            const value = settings[key];
            if (typeof value === 'number' && value >= 0 && value <= 1) {
                this.config[key] = value;
            }
        }
        return this.config;
    },

    /**
     * Headroom for a conversation.
     *
     * @param {number} usedTokens - Estimated tokens already in the conversation.
     * @param {number} nextPromptTokens - Tokens the prompt about to be sent would add.
     * @returns {Object} {
     *     contextLimit, reservedOutputTokens, usedTokens, usableTokens,
     *     remaining, percentUsed, level, message, estimate
     *   }
     */
    report: function (usedTokens, nextPromptTokens) {
        const limit = this.config.contextLimit;
        const reserved = Math.min(this.config.reservedOutputTokens, limit);

        const used = Math.max(0, toNumber(usedTokens) + toNumber(nextPromptTokens));

        // Space a prompt may actually occupy, once the reply's room is set aside.
        const usable = Math.max(0, limit - reserved);
        const remaining = Math.max(0, limit - used - reserved);

        // Measured against usable space, not the raw limit: a window whose every
        // remaining token is reserved for the answer has no headroom for a prompt, and
        // reporting that as "space left" would be the wrong signal.
        const freeFraction = usable > 0 ? remaining / usable : 0;
        const percentUsed = usable > 0
            ? Math.min(100, Math.round((used / usable) * 100))
            : 100;

        let level = 'ok';
        let message = null;
        if (remaining === 0) {
            level = 'full';
            message = 'This prompt may not fit. Older turns are likely to be dropped.';
        } else if (freeFraction <= this.config.criticalBelow) {
            level = 'critical';
            message = 'Very little context left. Start a new chat to keep the full history.';
        } else if (freeFraction <= this.config.warnBelow) {
            level = 'warn';
            message = 'Context is filling up. Consider starting a new chat soon.';
        }

        return {
            contextLimit: limit,
            reservedOutputTokens: reserved,
            usedTokens: used,
            usableTokens: usable,
            remaining: remaining,
            percentUsed: percentUsed,
            level: level,
            message: message,
            // Never remove this. It is what stops the UI calling the number a measurement.
            estimate: true
        };
    }
};

/** Non-numbers count as zero, so a missing argument cannot poison the arithmetic. */
function toNumber(value) {
    return (typeof value === 'number' && isFinite(value) && value > 0) ? value : 0;
}

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterHeadroom = PromptMeterHeadroom;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterHeadroom };
}
