/**
 * PromptMeter Storage Wrapper Service
 * 
 * Centralizes read/write calls to Chrome Local Storage, handles data capping (FIFO),
 * and calculates aggregate usage statistics for user analytics.
 */
const PromptMeterStorage = {
    // Configurable maximum history size to keep extension lightweight
    maxHistorySize: 500,

    /**
     * Retrieve the entire history of logged turns.
     * @param {Function} callback - Callback function passed the history array.
     */
    getHistory: function (callback) {
        chrome.storage.local.get({ history: [] }, (result) => {
            if (typeof callback === 'function') {
                callback(result.history || []);
            }
        });
    },

    /**
     * Save a single conversation turn data block to history.
     * Enforces the storage cap size (evicts oldest turns if size exceeds maxHistorySize).
     * @param {Object} turnData - The turn object { prompt, response, ... }
     * @param {Function} callback - Optional callback on completion.
     */
    saveTurn: function (turnData, callback) {
        if (!turnData) return;

        this.getHistory((history) => {
            history.push(turnData);

            // Enforce size limit (FIFO eviction)
            if (history.length > this.maxHistorySize) {
                history.shift(); // Remove the oldest turn
                console.log(`🧹 PromptMeter [Storage]: Evicted oldest record (history size exceeded ${this.maxHistorySize}).`);
            }

            chrome.storage.local.set({ history: history }, () => {
                if (typeof callback === 'function') {
                    callback();
                }
            });
        });
    },

    /**
     * Completely wipe historical turn logs.
     * @param {Function} callback - Optional callback on completion.
     */
    clearHistory: function (callback) {
        chrome.storage.local.set({ history: [] }, () => {
            console.log("🗑️ PromptMeter [Storage]: Historical records cleared.");
            if (typeof callback === 'function') {
                callback();
            }
        });
    },

    /**
     * Calculates sum and average analytics across all conversation records.
     * Useful for powering the dashboard charts and counters.
     * @param {Function} callback - Callback function passed the aggregated stats object.
     */
    getStats: function (callback) {
        this.getHistory((history) => {
            const stats = {
                totalQueries: history.length,
                totalTokens: 0,
                totalElectricity: 0,
                totalCarbon: 0,
                totalWater: 0,
                avgEfficiency: 0
            };

            if (history.length === 0) {
                if (typeof callback === 'function') callback(stats);
                return;
            }

            let cumulativeEfficiency = 0;

            history.forEach(turn => {
                stats.totalTokens += turn.totalTokens || 0;
                stats.totalElectricity += turn.electricity || 0;
                stats.totalCarbon += turn.carbon || 0;
                stats.totalWater += turn.water || 0;
                cumulativeEfficiency += (turn.efficiencyScore !== undefined) ? turn.efficiencyScore : 100;
            });

            stats.avgEfficiency = Math.round(cumulativeEfficiency / history.length);

            // Clean up float rounding errors
            stats.totalElectricity = parseFloat(stats.totalElectricity.toFixed(4));
            stats.totalCarbon = parseFloat(stats.totalCarbon.toFixed(4));
            stats.totalWater = parseFloat(stats.totalWater.toFixed(4));

            if (typeof callback === 'function') {
                callback(stats);
            }
        });
    }
};
