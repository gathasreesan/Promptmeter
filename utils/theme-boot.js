/**
 * PromptMeter Theme Bootstrap
 *
 * Runs before first paint and stamps the saved theme onto <html>, so an extension page
 * never flashes light before its stylesheet or React app takes over.
 *
 * This lives in its own file rather than an inline <script> because extension pages run
 * under the MV3 policy `script-src 'self'`, which blocks inline execution outright.
 *
 * It deliberately duplicates the MIRROR_KEY literal from theme.js instead of depending
 * on it: this has to run first, standalone, with nothing else loaded.
 */
(function () {
    try {
        var mode = window.localStorage.getItem('promptmeter_theme');
        if (mode === 'light' || mode === 'dark') {
            document.documentElement.setAttribute('data-theme', mode);
        }
    } catch (e) {
        // Private mode or blocked site data: fall back to prefers-color-scheme
    }
})();
