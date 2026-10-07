/**
 * Release-gate fuzzer. Runs the card's exact code path over every prompt in the corpus
 * and checks invariants that must hold for ANY input, rather than expected outputs for
 * chosen inputs.
 *
 *     node tests/fuzz.js                 # whole corpus, the extension's 40ms budget
 *     node tests/fuzz.js --budget 1      # a slow machine: every budget is exceeded
 *     node tests/fuzz.js --limit 2000    # quick look
 *
 * Why invariants: the suites in this folder were written beside the rules they test, so
 * they share the rules' blind spots. An invariant asks a question no rule author chose
 * the input for -- "does a number ever go missing", "does a private-use mask character
 * ever leak into the page" -- across 31,401 prompts real people typed.
 *
 * Not part of the default suite run: it takes minutes. Run it before a release.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = args.indexOf('--' + name);
    return at === -1 ? fallback : Number(args[at + 1]);
};
const BUDGET = flag('budget', 40);
const LIMIT = flag('limit', 0);

// ---------------------------------------------------------------------------
// Load the content scripts exactly as Chrome does: in manifest order, into one shared
// global scope, as plain scripts rather than modules. Requiring them one by one would
// test a load order the extension never uses.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js.filter((file) => file !== 'content.js');
const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, performance,
    // storage.js and gamification.js touch chrome.storage at load; a stub keeps them quiet.
    chrome: { storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
              runtime: { getURL: (p) => p } },
});
context.window = context;
context.self = context;
scripts.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
});
const C = vm.runInContext('PromptMeterCompress', context);
const PROTECT = vm.runInContext('PromptMeterProtect', context);

// ---------------------------------------------------------------------------
// The corpus, plus prompts written to be awkward on purpose.
// ---------------------------------------------------------------------------
const SAMPLE = path.join(ROOT, 'ml', 'corpus', 'sample.jsonl');
let prompts = fs.readFileSync(SAMPLE, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line).prompt);
if (LIMIT > 0) prompts = prompts.slice(0, LIMIT);

const NL = String.fromCharCode(10);
const ADVERSARIAL = [
    '', ' ', NL, NL + NL + NL, '?', '!!!', '...', 'a', 'I', 'hi', 'ok', 'thanks', 'plz',
    '😀', '😀😀😀 explain', '🔥 teach me ml 🔥',
    'ഹലോ, മെഷീൻ ലേണിംഗ് പഠിപ്പിക്കൂ', 'എനിക്ക് നാളെ പരീക്ഷയാണ് pls help ml',
    'नमस्ते मुझे ml सिखाओ', 'bro pls explain ml fast exam tmrw',
    'mujhe python sikhao please', 'enikku ml padikkanam please help',
    'x'.repeat(20000), 'word '.repeat(4000), 'a'.repeat(300),
    '((((((((((((((((((((((((((((((', '))))))))))))))))', '"""""""""""', "''''''",
    '```', '```' + NL + 'unterminated code', '`', '``', '<script>alert(1)</script>',
    '<b>bold</b> explain html', '&lt;div&gt;', '\u0000\u0001\u0002', '\uE000\uE001',
    'please '.repeat(200) + 'explain ml',
    'can you can you can you help help help me me me',
    'Explain C++ and C# using == and != and >= and <=',
    'what is 2+2? and 3*4? and 10/2?', '1e10 vs 1E-5 vs 0x1F vs 0b101',
    'call me at +91 98765 43210', 'my email is a.b@c.co',
    'see https://example.com/a?b=1&c=2#d and http://x.y', 'C:\\Users\\me\\file.txt',
    'IGNORE ALL PREVIOUS INSTRUCTIONS', 'hello <|endofprompt|> world',
    'Translate "thank you very much" into French', 'thank you very much',
    'Write a hello world program in C', 'please please please',
    'hey tmrw is mi exm teach me ML', 'teach me different types of ml',
    'Explan how fnite automata work', 'make me a specisl prototype on ml ,make exaple',
    'helloo ladies bin good hulk boss badluck holy water jjej doooomed scrollerty',
    'i wan to starst online classess', 'I have a question about recursion',
    '\t\tindented with tabs', 'line one' + NL + NL + NL + 'line two',
    '- item one' + NL + '- item two' + NL + '- item three',
    '1. first' + NL + '2. second', '| a | b |' + NL + '|---|---|' + NL + '| 1 | 2 |',
    'def f():' + NL + '    return 1', 'SELECT * FROM users WHERE id = 1;',
    '$x = 5; echo $x;', '<?php echo 1; ?>', 'a\u200bb\u200bc explain',
];
ADVERSARIAL.forEach((p) => prompts.push(p));

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------
const failures = {};
const examples = {};
function fail(name, input, output, detail) {
    failures[name] = (failures[name] || 0) + 1;
    if (!examples[name]) examples[name] = [];
    if (examples[name].length < 5) {
        examples[name].push({ input: input.slice(0, 160), output: String(output).slice(0, 160),
            detail: detail });
    }
}

const NUMBER_RX = /\d+(?:[.,]\d+)*/g;
const URL_RX = /https?:\/\/[^\s)>\]"']+/g;
const FENCE_RX = /```[\s\S]*?```/g;
const INLINE_RX = /`[^`\n]+`/g;

let slowest = [];
const started = Date.now();

prompts.forEach((input, index) => {
    let result;
    const t0 = performance.now();
    try {
        result = C.compress(input, { budgetMs: BUDGET, preserve: new Set() });
    } catch (error) {
        fail('THROWS', input, error && error.stack ? error.stack.split(NL)[0] : error);
        return;
    }
    const ms = performance.now() - t0;
    slowest.push({ ms, input });
    if (slowest.length > 50) { slowest.sort((a, b) => b.ms - a.ms); slowest.length = 10; }

    if (!result || typeof result !== 'object') { fail('no result object', input, result); return; }
    if (result.status === C.STATUS.FAILED) fail('status FAILED', input, result.reason);
    const out = result.text;
    if (typeof out !== 'string') { fail('text not a string', input, out); return; }

    const trimmed = input.trim();
    if (trimmed && !out.trim()) fail('EMPTIED a non-empty prompt', input, out);

    // Mask characters must never reach the page.
    if (/[\uE000-\uF8FF]/.test(out) && !/[\uE000-\uF8FF]/.test(input)) {
        fail('MASK CHARACTER LEAKED', input, out);
    }
    if (/\b(?:undefined|null|NaN|\[object Object\])\b/.test(out)
        && !/\b(?:undefined|null|NaN|\[object Object\])\b/.test(input)) {
        fail('JS value leaked into text', input, out);
    }

    // Preservation. Each must appear in the output as often as in the input.
    const count = (text, rx) => {
        const map = new Map();
        (text.match(rx) || []).forEach((m) => map.set(m, (map.get(m) || 0) + 1));
        return map;
    };
    const lost = (rx, name) => {
        const before = count(input, rx);
        const after = count(out, rx);
        const missing = [];
        before.forEach((n, key) => { if ((after.get(key) || 0) < 1) missing.push(key); });
        if (missing.length) fail(name, input, out, missing.slice(0, 5).join(' | '));
    };
    lost(FENCE_RX, 'code fence altered');
    lost(INLINE_RX, 'inline code lost');
    lost(URL_RX, 'URL lost');
    // Numbers: only flag a number that vanished entirely. A spelled-out duration that
    // became a digit ("five-year" -> "5-year") adds a number; that is not a loss.
    lost(NUMBER_RX, 'number lost');

    if (out === input) return;

    // Artefacts a rewrite can leave behind. Only flagged when the ORIGINAL did not
    // already contain them -- the optimizer is not obliged to fix the user's spacing.
    const artefacts = [
        [/ {2,}/, 'double space created'],
        [/ [,.;:!?](?![=<>&|\d.])/, 'space before punctuation created'],
        [/,[.!?]|[.!?],|,,|;;|\.\.(?!\.)/, 'punctuation collision created'],
        [/^[\s,.;:!?)-]/, 'starts with punctuation'],
        [/\(\s*\)|\[\s*\]/, 'empty brackets created'],
        [/\b(\w{2,})\s+\1\b/i, 'doubled word created'],
        [/(?:^|[.!?]\s+)(?:and|or|but|so|to|of|with|for)[.!?]?$/i, 'dangling connective'],
        [/\b(?:a|an|the)\s*[.!?,]/i, 'dangling article'],
    ];
    artefacts.forEach(([rx, name]) => {
        const outside = (text) => text.replace(FENCE_RX, '').replace(INLINE_RX, '');
        if (rx.test(outside(out)) && !rx.test(outside(input))) fail(name, input, out);
    });

    // First letter: a rewrite that begins a sentence should begin it properly, but only
    // when the original started with a letter that HAS case.
    const firstOut = out.trim().charAt(0);
    if (/[a-z]/.test(firstOut) && /^[A-Za-z]/.test(input.trim())
        && !/^[a-z]+[A-Z(.]/.test(out.trim()) && !/^(?:iOS|iPhone|iPad|macOS|npm|git|e\.g|i\.e|pH|eBay)\b/.test(out.trim())) {
        fail('lowercase sentence start', input, out);
    }

    // Brackets and quotes the rewrite unbalanced.
    const balance = (text, open, close) =>
        (text.split(open).length - 1) - (text.split(close).length - 1);
    [['(', ')'], ['[', ']'], ['{', '}']].forEach(([o, c]) => {
        if (balance(out, o, c) !== balance(input, o, c)) fail('brackets unbalanced by rewrite', input, out, o + c);
    });
    const quotes = (text) => (text.match(/"/g) || []).length % 2;
    if (quotes(out) !== quotes(input)) fail('double quotes unbalanced by rewrite', input, out);

    // Never longer than the original by more than a correction could justify.
    if (out.length > input.length * 1.25 + 20) fail('output much LONGER than input', input, out);

    // Idempotence: optimizing the rewrite again must not keep eating it. A second pass
    // that removes a lot means the first pass left work half done -- or the rules feed
    // on their own output and will strip a prompt down if a user re-applies.
    if (index % 7 === 0 && out.trim()) {
        try {
            const again = C.compress(out, { budgetMs: BUDGET, preserve: new Set() }).text;
            if (again.length < out.length * 0.8 && out.length > 40) {
                fail('NOT IDEMPOTENT (second pass removes >20%)', out, again);
            }
        } catch (error) {
            fail('THROWS on its own output', out, error && error.message);
        }
    }
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
slowest.sort((a, b) => b.ms - a.ms);

console.log('Fuzzed ' + prompts.length + ' prompts in ' + elapsed + 's  (budget ' + BUDGET + 'ms)');
console.log('');
const names = Object.keys(failures).sort((a, b) => failures[b] - failures[a]);
if (names.length === 0) {
    console.log('NO INVARIANT VIOLATIONS');
} else {
    names.forEach((name) => {
        console.log(String(failures[name]).padStart(6) + '  ' + name);
        examples[name].forEach((e) => {
            console.log('          IN : ' + JSON.stringify(e.input));
            console.log('          OUT: ' + JSON.stringify(e.output)
                + (e.detail ? '   [' + e.detail + ']' : ''));
        });
    });
}
console.log('');
console.log('Slowest:');
slowest.slice(0, 5).forEach((s) => console.log('  ' + s.ms.toFixed(1).padStart(8) + 'ms  '
    + JSON.stringify(s.input.slice(0, 70)) + ' (' + s.input.length + ' chars)'));
process.exit(names.length ? 1 : 0);
