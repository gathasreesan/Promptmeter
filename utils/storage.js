/**
 * PromptMeter Storage Service
 *
 * The single read/write path to Chrome local storage. Handles FIFO capping of the
 * history and aggregate usage statistics.
 *
 * Every method degrades gracefully when chrome.storage is unavailable (for example the
 * dashboard opened as a plain page), reporting an empty history rather than throwing.
 */
const PromptMeterStorage = {
    // Caps stored history so the extension stays lightweight
    maxHistorySize: 500,

    /** True when running inside an extension context with storage access. */
    isAvailable: function () {
        return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
    },

    /**
     * Retrieve the entire history of logged turns.
     * @param {Function} callback - Passed the history array (empty if storage is unavailable).
     */
    getHistory: function (callback) {
        const done = (history) => {
            if (typeof callback === 'function') callback(history);
        };

        if (!this.isAvailable()) return done([]);
        chrome.storage.local.get({ history: [] }, (result) => done(result.history || []));
    },

    /**
     * Overwrite the stored history.
     * @param {Array} history - The full history array to persist.
     * @param {Function} callback - Optional, passed the history that was written.
     */
    setHistory: function (history, callback) {
        const done = () => {
            if (typeof callback === 'function') callback(history);
        };

        if (!this.isAvailable()) return done();
        chrome.storage.local.set({ history: history }, done);
    },

    /**
     * Append one conversation turn, evicting the oldest once the cap is reached.
     * @param {Object} turnData - The turn object { prompt, response, ... }
     * @param {Function} callback - Optional callback on completion.
     */
    saveTurn: function (turnData, callback) {
        if (!turnData) return;

        this.getHistory((history) => {
            history.push(turnData);

            if (history.length > this.maxHistorySize) {
                history.shift();
                console.log(`🧹 PromptMeter [Storage]: Evicted oldest record (cap ${this.maxHistorySize}).`);
            }

            this.setHistory(history, () => {
                if (typeof callback === 'function') callback();
            });
        });
    },

    /**
     * Wipe all historical turn logs.
     * @param {Function} callback - Optional, passed the (now empty) history.
     */
    clearHistory: function (callback) {
        this.setHistory([], (history) => {
            console.log("🗑️ PromptMeter [Storage]: Historical records cleared.");
            if (typeof callback === 'function') callback(history);
        });
    },

    /**
     * Delete a single conversation turn by its timestamp.
     * @param {string} timestamp - ISO timestamp of the turn to delete.
     * @param {Function} callback - Optional, passed the updated history array.
     */
    deleteTurn: function (timestamp, callback) {
        if (!timestamp) return;

        this.getHistory((history) => {
            this.setHistory(history.filter(turn => turn.timestamp !== timestamp), (updated) => {
                console.log(`🗑️ PromptMeter [Storage]: Turn record deleted (${timestamp}).`);
                if (typeof callback === 'function') callback(updated);
            });
        });
    },

    /**
     * Sums and averages a history array. Pure, so the dashboard can aggregate the records
     * already held in component state without a second round trip to storage.
     * @param {Array} history - Array of captured turns.
     * @returns {Object} Aggregated usage statistics.
     */
    aggregate: function (history = []) {
        const sum = (field) => history.reduce((total, turn) => total + (turn[field] || 0), 0);
        const round = (value) => parseFloat(value.toFixed(4));

        // An unscored turn counts as a perfect 100 so old records don't drag the average down
        const efficiencyTotal = history.reduce(
            (total, turn) => total + (turn.efficiencyScore !== undefined ? turn.efficiencyScore : 100),
            0
        );

        return {
            totalQueries: history.length,
            totalTokens: sum('totalTokens'),
            totalElectricity: round(sum('electricity')),
            totalCarbon: round(sum('carbon')),
            totalTokensSaved: sum('tokensSaved'),
            totalCarbonSaved: sum('carbonSaved'),
            avgEfficiency: history.length > 0 ? Math.round(efficiencyTotal / history.length) : 0
        };
    },

    /**
     * Fetches history and returns its aggregate statistics.
     * @param {Function} callback - Passed the aggregated stats object.
     */
    getStats: function (callback) {
        this.getHistory((history) => {
            if (typeof callback === 'function') callback(this.aggregate(history));
        });
    }
};

// Export for global (content script / popup) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterStorage = PromptMeterStorage;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterStorage };
}
