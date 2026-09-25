/**
 * Theme switcher for preview.html.
 *
 * Its own file rather than an inline <script>, for the same reason theme-boot.js is:
 * extension pages run under `script-src 'self'`. The preview is opened over file://
 * where an inline script would work, but keeping the rule consistent means the page
 * can be dropped into the extension unchanged if it ever ships as a debug surface.
 *
 * It drives the same data-theme attribute the real surfaces use, through the same
 * PromptMeterTheme.apply(), so what the preview shows is what the extension resolves.
 * It deliberately does NOT write the preference to storage: checking dark mode here
 * should not silently re-theme somebody's actual extension.
 */
(function () {
    var switcher = document.getElementById('switcher');
    if (!switcher) return;

    function select(mode) {
        if (typeof PromptMeterTheme !== 'undefined') {
            PromptMeterTheme.apply(mode);
        } else if (mode === 'auto') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', mode);
        }

        var buttons = switcher.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].setAttribute(
                'aria-pressed', String(buttons[i].dataset.mode === mode)
            );
        }
    }

    switcher.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-mode]');
        if (button) select(button.dataset.mode);
    });

    select('auto');
}());
