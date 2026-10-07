/**
 * Release gate: every defect found by fuzzing the card's real code path over the
 * corpus before the live demo, each pinned by the case that exposed it.
 *
 *     node tests/release.test.js
 *
 * Loads the content scripts the way Chrome does -- manifest order, one shared scope --
 * and calls PromptMeterCompress.compress with the card's own 40ms budget, so what is
 * tested is what the card shows.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, performance,
    chrome: { storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
              runtime: { getURL: (p) => p } },
});
context.window = context;
manifest.content_scripts[0].js.filter((f) => f !== 'content.js').forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
});
const C = vm.runInContext('PromptMeterCompress', context);
const card = (text, budget) => C.compress(text, { budgetMs: budget || 40, preserve: new Set() }).text;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
    if (condition) { passed++; return; }
    failed++;
    console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
}

const NL = String.fromCharCode(10);
const PARAGRAPH = 'The industrial revolution changed everything about how people worked and '
    + 'lived. Factories replaced small workshops across the country. Cities grew quickly as '
    + 'families moved from farms to find jobs. Working conditions were often dangerous and '
    + 'wages were low. Children also worked long hours in mills and mines. Over time new '
    + 'laws improved safety and limited the working day.';

// Both budgets: the card's 40ms, and 1ms -- a slow machine where every budget is blown
// and the compressor takes its fallback path. A demo PC is not this one.
[40, 1].forEach((budget) => {
    const tag = ' [' + budget + 'ms]';

    // -----------------------------------------------------------------------
    // 1. A "2" that is a COUNT is not txt-speak for "to".
    //    "At the second stop, 2 get off" came back as "to get off": a number deleted
    //    from a maths word problem, and the validator agreed because it expands digits
    //    with the same rule.
    // -----------------------------------------------------------------------
    [
        'You are driving a bus. At the first stop, 5 people get on. At the second stop, 2 get off, and 3 get on.',
        '2 get off at the next stop',
        '5 got on and 2 get off',
        'if 2 go and 3 stay, how many are left',
    ].forEach((input) => {
        const got = card(input, budget);
        check('the count 2 survives' + tag + ': ' + JSON.stringify(input.slice(0, 40)),
            /\b2\b/.test(got) && !/\bto (?:get|go)\b/.test(got.replace(/how many/, '')), got);
    });
    // ...and txt-speak still expands, including after txt-speak.
    [
        ['I want 2 go home', /want to go/],
        ['how 2 make pasta', /to make pasta/i],
        ['can u tell me wat 2 do if my phone fell in water', /what to do/],
        ['what 2 do now', /to do now/],
    ].forEach(([input, want]) => {
        const got = card(input, budget);
        check('txt-speak 2 still becomes "to"' + tag + ': ' + input, want.test(got), got);
    });

    // -----------------------------------------------------------------------
    // 2. An instruction above a pasted paragraph is never dropped.
    //    "paraphrase" alone on a line read as a two-word fragment and was pruned, so the
    //    paragraph went to the model with the instruction deleted. The editing verbs
    //    were missing from the imperative list entirely.
    // -----------------------------------------------------------------------
    ['paraphrase', 'revise', 'shorten', 'rephrase', 'polish', 'proofread', 'reword',
     'simplify', 'edit', 'correct', 'expand', 'summarise this:', 'translate to hindi:',
     'make this better', 'fix the grammar'].forEach((verb) => {
        ['"' + NL + NL, ':' + NL, NL + NL].forEach((joint) => {
            const input = verb + ' ' + joint + PARAGRAPH + (joint.charAt(0) === '"' ? '"' : '');
            const got = card(input, budget);
            const head = verb.split(' ')[0].replace(':', '');
            check('the instruction survives' + tag + ': ' + JSON.stringify(verb + joint.trim()),
                got.toLowerCase().indexOf(head.toLowerCase()) !== -1
                // Translate's own word may legitimately be capitalised.
                || new RegExp(head, 'i').test(got),
                got.slice(0, 80));
            check('the paragraph survives' + tag + ': ' + JSON.stringify(verb),
                /industrial revolution/i.test(got) && /working day/i.test(got), got.slice(0, 80));
        });
    });

    // -----------------------------------------------------------------------
    // 3. A format template keeps every line, including a placeholder marker.
    //    "n) Riddle." was a fragment outside the A-H list-marker range and was dropped,
    //    taking with it the format the prompt was specifying.
    // -----------------------------------------------------------------------
    const RIDDLES = 'Generate 10 riddles with their answers. The format should be:' + NL
        + 'n) Riddle.' + NL + 'Ans: Answer of the riddle.';
    check('the placeholder format line survives' + tag, card(RIDDLES, budget).indexOf('n) Riddle.') !== -1,
        card(RIDDLES, budget));
    ['x) Item.', 'k) Step.', '12) Question.'].forEach((marker) => {
        const input = 'Write ten quiz questions about photosynthesis for a class of students. '
            + 'Use this exact format for every one of them:' + NL + marker + NL + 'Answer: the answer.';
        check('marker ' + marker + ' survives' + tag, card(input, budget).indexOf(marker) !== -1,
            card(input, budget));
    });
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
