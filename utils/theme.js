/**
 * PromptMeter Theme Service
 *
 * One stored preference — "light", "dark" or "auto" — shared by the dashboard, the
 * popup and the coach card injected into ChatGPT, so the extension never looks
 * half-themed.
 *
 * How a mode reaches the CSS:
 *   light / dark  ->  data-theme="light" | "dark" on <html>, which wins over everything
 *   auto          ->  the attribute is removed, letting prefers-color-scheme decide
 *
 * The preference is written to chrome.storage.local (shared across extension surfaces)
 * and mirrored into localStorage, which is readable synchronously so a page can paint
 * the right theme on first frame instead of flashing white.
 */
const PromptMeterTheme = {
    MODES: ['light', 'dark', 'auto'],
    DEFAULT: 'auto',
    STORAGE_KEY: 'theme',
    MIRROR_KEY: 'promptmeter_theme',

    /** True when running with extension storage available. */
    isExtension: function () {
        return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
    },

    /** Coerces any stored value into a valid mode. */
    normalize: function (mode) {
        return this.MODES.indexOf(mode) !== -1 ? mode : this.DEFAULT;
    },

    /**
     * Reads the preference synchronously from the localStorage mirror.
     * Used for the very first paint, before async storage has answered.
     * @returns {string} One of MODES.
     */
    readSync: function () {
        try {
            return this.normalize(window.localStorage.getItem(this.MIRROR_KEY));
        } catch (e) {
            // Storage can throw in private windows or when site data is blocked
            return this.DEFAULT;
        }
    },

    /**
     * Reads the authoritative preference from extension storage.
     * @param {Function} callback - Passed the resolved mode.
     */
    read: function (callback) {
        const done = (mode) => {
            if (typeof callback === 'function') callback(this.normalize(mode));
        };

        if (!this.isExtension()) return done(this.readSync());

        const stored = {};
        stored[this.STORAGE_KEY] = this.DEFAULT;
        chrome.storage.local.get(stored, (result) => done(result[this.STORAGE_KEY]));
    },

    /**
     * Persists the preference to both extension storage and the local mirror.
     * @param {string} mode - One of MODES.
     * @param {Function} callback - Optional completion callback.
     */
    write: function (mode, callback) {
        const value = this.normalize(mode);

        try {
            window.localStorage.setItem(this.MIRROR_KEY, value);
        } catch (e) { /* mirror is an optimisation, not a requirement */ }

        if (!this.isExtension()) {
            if (typeof callback === 'function') callback(value);
            return;
        }

        const payload = {};
        payload[this.STORAGE_KEY] = value;
        chrome.storage.local.set(payload, () => {
            if (typeof callback === 'function') callback(value);
        });
    },

    /**
     * Applies a mode to the document.
     * @param {string} mode - One of MODES.
     * @param {Element} root - Defaults to <html>.
     */
    apply: function (mode, root) {
        const target = root || (typeof document !== 'undefined' ? document.documentElement : null);
        if (!target) return;

        const value = this.normalize(mode);
        if (value === 'auto') {
            target.removeAttribute('data-theme');
        } else {
            target.setAttribute('data-theme', value);
        }
    },

    /**
     * Resolves what "auto" currently means, for UI that needs the concrete theme.
     * @param {string} mode - One of MODES.
     * @returns {string} "light" or "dark".
     */
    resolve: function (mode) {
        const value = this.normalize(mode);
        if (value !== 'auto') return value;

        const prefersDark = typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches;
        return prefersDark ? 'dark' : 'light';
    },

    /**
     * Reads the stored preference and applies it immediately, then keeps the document
     * in step with later changes from any other extension surface.
     * @param {Function} onChange - Optional, called with the mode whenever it changes.
     */
    start: function (onChange) {
        this.apply(this.readSync());
        this.read((mode) => {
            this.apply(mode);
            if (typeof onChange === 'function') onChange(mode);
        });

        if (this.isExtension() && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes[this.STORAGE_KEY]) return;

                const mode = this.normalize(changes[this.STORAGE_KEY].newValue);
                try {
                    window.localStorage.setItem(this.MIRROR_KEY, mode);
                } catch (e) { /* mirror only */ }

                this.apply(mode);
                if (typeof onChange === 'function') onChange(mode);
            });
        }
    }
};

// Export for global (content script / popup) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterTheme = PromptMeterTheme;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterTheme };
}
