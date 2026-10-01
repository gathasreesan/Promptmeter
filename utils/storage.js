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

    /**
     * True when running inside an extension context with storage access.
     *
     * Also false once the extension has been reloaded or updated under an open tab: the
     * old content script keeps running, chrome.runtime.id goes undefined, and every
     * chrome.storage call throws "Extension context invalidated". That used to surface
     * as uncaught errors on each keystroke until the page was refreshed.
     */
    isAvailable: function () {
        try {
            return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local
                && !(chrome.runtime && !chrome.runtime.id);
        } catch (e) {
            return false;
        }
    },

    // --- Event and error log ------------------------------------------------------
    //
    // A ring buffer in chrome.storage ("eventLog"), viewable and downloadable from the
    // dashboard's Logs tab. Built to cost nothing on a keystroke:
    //   - entries are compact ({t, k, lvl, m, d}) and every string is capped,
    //   - writes are batched: log() only queues, and one read-modify-write flushes the
    //     queue after LOG_FLUSH_MS or when the tab is hidden,
    //   - the buffer keeps the newest LOG_MAX entries, so it can never grow unbounded,
    //   - a failed write (storage full, context gone) keeps the queue for the next try
    //     instead of throwing, so a flaky moment loses nothing.
    LOG_MAX: 1000,
    LOG_FLUSH_MS: 2000,
    logQueue: [],
    logTimer: null,

    /**
     * Records an event. `level` is 'info', 'warn' or 'error'.
     * @param {string} kind - Short event name: 'card-shown', 'apply', 'capture', ...
     * @param {string} message
     * @param {Object} [data] - Small details; long strings are truncated.
     */
    log: function (kind, message, data, level) {
        const clip = (value) => typeof value === 'string' && value.length > 300
            ? value.slice(0, 300) + '…' : value;
        const details = {};
        if (data && typeof data === 'object') {
            Object.keys(data).slice(0, 12).forEach((key) => { details[key] = clip(data[key]); });
        }
        this.logQueue.push({
            t: Date.now(), k: kind, lvl: level || 'info', m: clip(String(message || '')),
            d: Object.keys(details).length ? details : undefined,
            src: typeof location !== 'undefined' ? location.protocol.replace(':', '') : 'node'
        });
        if (this.logQueue.length > this.LOG_MAX) this.logQueue.splice(0, this.logQueue.length - this.LOG_MAX);
        if (!this.logTimer) this.logTimer = setTimeout(() => this.flushLog(), this.LOG_FLUSH_MS);
    },

    error: function (kind, err, data) {
        this.log(kind, (err && err.message) || String(err), Object.assign(
            { stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined }, data), 'error');
    },

    flushLog: function (callback) {
        clearTimeout(this.logTimer);
        this.logTimer = null;
        const done = () => { if (typeof callback === 'function') callback(); };
        if (!this.logQueue.length || !this.isAvailable()) return done();
        const batch = this.logQueue.splice(0);
        try {
            chrome.storage.local.get({ eventLog: [] }, (res) => {
                const log = (res.eventLog || []).concat(batch);
                chrome.storage.local.set({ eventLog: log.slice(-this.LOG_MAX) }, () => {
                    if (chrome.runtime && chrome.runtime.lastError) {
                        // Keep the entries for the next attempt rather than losing them.
                        this.logQueue.unshift(...batch);
                        this.logTimer = setTimeout(() => this.flushLog(), this.LOG_FLUSH_MS * 5);
                    }
                    done();
                });
            });
        } catch (e) {
            this.logQueue.unshift(...batch);
            done();
        }
    },

    getLog: function (callback) {
        this.getSettings({ eventLog: [] }, (res) => callback(res.eventLog || []));
    },

    clearLog: function (callback) {
        this.logQueue.length = 0;
        this.setSetting('eventLog', [], callback);
    },

    /** One line per entry, oldest first: "ISO  LEVEL  kind  message  {details}". */
    formatLog: function (entries) {
        return (entries || []).map((e) => [new Date(e.t).toISOString(), (e.lvl || 'info').toUpperCase().padEnd(5),
            e.k, e.m, e.d ? JSON.stringify(e.d) : ''].join('  ').trim()).join('\n');
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
        try {
            chrome.storage.local.get({ history: [] }, (result) => done((result && result.history) || []));
        } catch (e) {
            done([]);
        }
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
        try {
            chrome.storage.local.set({ history: history }, () => {
                if (chrome.runtime && chrome.runtime.lastError) {
                    this.log('storage', 'history write failed: ' + chrome.runtime.lastError.message, null, 'error');
                }
                done();
            });
        } catch (e) {
            this.error('storage', e);
            done();
        }
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

        // An unscored turn counts as a perfect 100 so old records don't drag the average
        // down. The test is `typeof === 'number'`, not `!== undefined`: analyzePrompt
        // now returns null for a prompt with nothing in it, and null passes an
        // undefined check, then adds as 0 -- an empty prompt would have pulled the
        // average down by a full hundred points per turn.
        const efficiencyTotal = history.reduce(
            (total, turn) => total + (
                typeof turn.efficiencyScore === 'number' && isFinite(turn.efficiencyScore)
                    ? turn.efficiencyScore
                    : 100
            ),
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

    // --- Settings, personal dictionary, fix reports -----------------------------------

    /** Edit levels, mapped to the hardest compression tier each allows. */
    STRICTNESS: { fixes: 'conservative', trim: 'balanced', condense: 'aggressive' },

    /** Reads keys with defaults; defaults are returned as-is without storage. */
    getSettings: function (defaults, callback) {
        if (!this.isAvailable()) return callback(Object.assign({}, defaults));
        try {
            chrome.storage.local.get(defaults, (res) => callback(res || Object.assign({}, defaults)));
        } catch (e) {
            callback(Object.assign({}, defaults));
        }
    },

    setSetting: function (key, value, callback) {
        if (!this.isAvailable()) return callback && callback();
        try {
            chrome.storage.local.set({ [key]: value }, () => callback && callback());
        } catch (e) {
            if (callback) callback();
        }
    },

    /**
     * Words the user has told the corrector to always leave alone. Lowercased and
     * deduplicated here so every caller agrees on what "the same word" is.
     */
    normalizeWord: function (word) {
        return String(word || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 64);
    },

    updateDictionary: function (change, callback) {
        this.getSettings({ dictionary: [] }, (res) => {
            const words = new Set(res.dictionary || []);
            change(words);
            const list = [...words].filter(Boolean).sort();
            this.setSetting('dictionary', list, () => callback && callback(list));
        });
    },

    addToDictionary: function (word, callback) {
        const clean = this.normalizeWord(word);
        this.updateDictionary((words) => { if (clean) words.add(clean); }, callback);
    },

    removeFromDictionary: function (word, callback) {
        const clean = this.normalizeWord(word);
        this.updateDictionary((words) => words.delete(clean), callback);
    },

    // A report is local only: it never leaves the machine unless the user exports it.
    maxReports: 200,

    addFixReport: function (report, callback) {
        this.getSettings({ fixReports: [] }, (res) => {
            const reports = (res.fixReports || []).concat(Object.assign(
                { timestamp: new Date().toISOString() }, report));
            this.setSetting('fixReports', reports.slice(-this.maxReports), callback);
        });
    },

    clearFixReports: function (callback) {
        this.setSetting('fixReports', [], callback);
    },

    /**
     * Rows to CSV. Pure, so the dashboard's export and the tests share it. Every field
     * is quoted, and a leading = + - @ is prefixed with ' so a spreadsheet does not run
     * a prompt that happens to start with "=" as a formula.
     * @param {Array<Object>} rows
     * @param {Array<[string, string]>} columns - [key, header] pairs.
     * @returns {string}
     */
    toCSV: function (rows, columns) {
        const cell = (value) => {
            let text = value === null || value === undefined ? '' : String(value);
            // Strings only: a negative number is data, not a formula.
            if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        };
        const lines = [columns.map(([, header]) => cell(header)).join(',')];
        (rows || []).forEach((row) => lines.push(columns.map(([key]) => cell(row[key])).join(',')));
        return lines.join('\r\n');
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
