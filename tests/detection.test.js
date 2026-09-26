/**
 * Error detection across every category the pipeline claims to handle.
 *
 *     node tests/detection.test.js
 *
 * The reported failure was that PromptMeter caught some spelling mistakes and missed
 * others, with no obvious pattern. There was a pattern: candidates came only from the
 * consonant-skeleton index, so any typo that added, dropped or changed a CONSONANT
 * landed in a different bucket and was never compared. "exaple" reduces to "xpl" and
 * "example" to "xmpl"; the two never met.
 *
 * These cases are organised by the category they exercise rather than by the module that
 * happens to implement them, because the point is coverage of the problem, not of the
 * code.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
const S = PromptMeterSpelling;
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
    }
}

const out = (prompt) => O.optimizeWithReport(prompt).text;
const findings = (prompt) => O.optimizeWithReport(prompt).grammar;

function corrects(typo, expected) {
    const got = S.correctWord(typo);
    check('corrects "' + typo + '" -> "' + expected + '"', got === expected,
        'got ' + JSON.stringify(got));
}

function leaves(word) {
    const got = S.correctWord(word);
    check('leaves "' + word + '" alone', got === null, 'rewrote it to ' + JSON.stringify(got));
}

// ---------------------------------------------------------------------------
// The reported prompt, end to end
// ---------------------------------------------------------------------------
const REPORTED = 'make me a specisl prototype on ml ,make exaple';
const reported = O.optimizeWithReport(REPORTED);
check('reported prompt: "specisl" is corrected', /special/.test(reported.text), reported.text);
check('reported prompt: "exaple" is corrected', /example/.test(reported.text), reported.text);
check('reported prompt: "ml" becomes "ML"', /\bML\b/.test(reported.text), reported.text);
check('reported prompt: opens with a capital', /^[A-Z]/.test(reported.text), reported.text);
check('reported prompt: the repeated verb is merged',
    (reported.text.match(/make/gi) || []).length === 1, reported.text);
check('reported prompt: both spellings are reported as errors',
    reported.grammar.filter((f) => f.severity === 'error').length >= 2,
    JSON.stringify(reported.grammar));

// ---------------------------------------------------------------------------
// Spelling: the shapes a typo can take
// ---------------------------------------------------------------------------
corrects('exaple', 'example');       // dropped consonant
corrects('compleate', 'complete');   // spurious vowel
corrects('specisl', 'special');      // neighbouring key
corrects('teh', 'the');              // transposition
corrects('recieve', 'receive');      // transposed vowels
corrects('prototpye', 'prototype');  // transposition, long word
corrects('occassion', 'occasion');   // doubled letter
corrects('wan', 'want');             // unfinished word

// The neighbour rule must not become a licence to swap words.
leaves('stack');      // a/u are not neighbours
leaves('heap');       // e/o are not neighbours
leaves('viva');       // dropping a lone consonant is a different word, not a typo
leaves('stare');
leaves('scheduler');
leaves('automata');
leaves('recursion');

// ---------------------------------------------------------------------------
// Technical terminology must survive untouched
// ---------------------------------------------------------------------------
[
    'use numpy and pandas for the dataframe',
    'the kubernetes pod keeps restarting',
    'my postgres query needs an index',
    'write a regex for the tokenizer',
    'the webhook returns a 502 from nginx',
].forEach((prompt) => {
    const before = prompt.split(/\s+/);
    const after = out(prompt).toLowerCase();
    const lost = before.filter((w) => {
        const bare = w.replace(/[^a-z0-9]/gi, '').toLowerCase();
        return bare.length > 3 && !after.includes(bare);
    });
    check('technical terms survive: ' + JSON.stringify(prompt.slice(0, 38)),
        lost.length === 0, 'lost ' + lost.join(', ') + '  -> ' + out(prompt));
});

// ---------------------------------------------------------------------------
// Mathematical operators and programming syntax
// ---------------------------------------------------------------------------
check('inequalities survive', /3x\^2 - 4x \+ 1 >= 0/.test(out('Solve 3x^2 - 4x + 1 >= 0 for x')),
    out('Solve 3x^2 - 4x + 1 >= 0 for x'));
check('comparison operators survive', /!==/.test(out('why does a !== b in javascript')),
    out('why does a !== b in javascript'));
check('a fenced block survives verbatim',
    out('Fix this:\n```python\ndef f(x):\n    return x ** 2 + 1\n```').includes('x ** 2 + 1'));
check('an inline code span survives', out('what does `git rebase -i` do').includes('`git rebase -i`'),
    out('what does `git rebase -i` do'));
check('a variable name is not spell-corrected',
    out('rename the variable usr_cnt to something clearer').includes('usr_cnt'),
    out('rename the variable usr_cnt to something clearer'));
check('a thousands separator survives', out('the budget is 1,000,000 exactly').includes('1,000,000'));
check('a clock time survives', out('the meeting is at 14:30 sharp').includes('14:30'));
check('a URL survives', out('summarise https://example.com/a/b?c=1 for me').includes('https://example.com/a/b?c=1'),
    out('summarise https://example.com/a/b?c=1 for me'));

// ---------------------------------------------------------------------------
// Grammar, punctuation, capitalisation
// ---------------------------------------------------------------------------
check('subject-verb disagreement is found',
    findings('he go to school every day').some((f) => f.type === 'agreement'));
check('the article is fixed', /an apple/.test(out('i ate a apple yesterday')));
check('a sentence is capitalised', /^[A-Z]/.test(out('explain recursion to me')));
check('a missing space after a comma is added', /,\s/.test(out('explain this,then show the code')),
    out('explain this,then show the code'));

// ---------------------------------------------------------------------------
// Severity: every finding is classified, and the tiers mean something
// ---------------------------------------------------------------------------
const MIXED = 'i has a question and he go home, the enviroment is bad and its a apple';
const mixed = findings(MIXED);
check('every finding carries a severity',
    mixed.length > 0 && mixed.every((f) => ['error', 'suggestion', 'improvement'].includes(f.severity)),
    JSON.stringify(mixed));
check('findings are sorted most-certain first', (function () {
    const order = { error: 0, suggestion: 1, improvement: 2 };
    for (let i = 1; i < mixed.length; i++) {
        if (order[mixed[i].severity] < order[mixed[i - 1].severity]) return false;
    }
    return true;
}()), JSON.stringify(mixed.map((f) => f.severity)));
check('a misspelling is an error',
    mixed.some((f) => f.type === 'spelling' && f.severity === 'error'));
check('findings are de-duplicated', (function () {
    const labels = mixed.map((f) => f.label.toLowerCase());
    return new Set(labels).size === labels.length;
}()));
check('an unknown finding type defaults to suggestion, never error',
    O.classifyFindings([{ type: 'something-new', label: 'x' }])[0].severity === 'suggestion');

// ---------------------------------------------------------------------------
// Token accounting: a rewrite that costs tokens must say so
// ---------------------------------------------------------------------------
const costly = PromptMeterTokenizer.stats('teach me ml', 'Teach me machine learning in detail');
check('savings may be negative', costly.saved < 0, JSON.stringify(costly));
check('percent may be negative', costly.percent < 0, JSON.stringify(costly));
const saving = PromptMeterTokenizer.stats('please kindly explain recursion to me', 'Explain recursion');
check('a real saving is still positive', saving.saved > 0 && saving.percent > 0,
    JSON.stringify(saving));
check('identical text saves nothing', PromptMeterTokenizer.stats('abc def', 'abc def').saved === 0);

// ---------------------------------------------------------------------------
// Long prompts
// ---------------------------------------------------------------------------
const LONG = ('Hello there, I hope you are doing well. I have been working on this for a '
    + 'while now and I am quite stuck. ').repeat(12)
    + 'Explain how a B-tree index works in PostgreSQL and when it beats a hash index.';
const longOut = out(LONG);
check('a long prompt keeps its request', /B-tree/.test(longOut) && /hash index/i.test(longOut),
    longOut.slice(0, 120));
check('a long prompt actually gets shorter', longOut.length < LONG.length * 0.7,
    LONG.length + ' -> ' + longOut.length);
check('a long prompt does not throw', typeof longOut === 'string' && longOut.length > 0);

// ---------------------------------------------------------------------------
// Multilingual text: no crash, no invented corrections, nothing emptied
// ---------------------------------------------------------------------------
[
    ['Spanish', 'Explica la recursividad con un ejemplo sencillo'],
    ['German', 'Erklaere mir den Unterschied zwischen Prozess und Thread'],
    ['Japanese', '再帰について説明してください'],
    ['Hindi', 'मुझे मशीन लर्निंग समझाओ'],
    ['Russian', 'Объясни рекурсию'],
    ['mixed', 'explain करो machine learning simply'],
].forEach((pair) => {
    let result;
    try {
        result = O.optimizeWithReport(pair[1]);
    } catch (err) {
        check(pair[0] + ' does not throw', false, String(err));
        return;
    }
    check(pair[0] + ' is not emptied', result.text.trim().length > 0);
    check(pair[0] + ' invents no spelling corrections',
        !result.grammar.some((f) => f.type === 'spelling'),
        JSON.stringify(result.grammar));
});

// ---------------------------------------------------------------------------
// Ambiguous instructions are flagged, not rewritten
// ---------------------------------------------------------------------------
const AMBIGUOUS = 'make it better somehow';
const ambiguous = O.analyzePrompt(AMBIGUOUS);
check('a vague prompt is flagged',
    (ambiguous.quality || []).some((f) => f.id === 'vague-specification'),
    JSON.stringify(ambiguous.quality));
check('a vague prompt is not invented into a specific one',
    !/\d/.test(out(AMBIGUOUS)), out(AMBIGUOUS));
check('a dangling reference is flagged',
    (O.analyzePrompt('fix the code below').quality || [])
        .some((f) => f.id === 'dangling-reference'));

// ---------------------------------------------------------------------------
// Correct prompts must be left alone
// ---------------------------------------------------------------------------
[
    'Explain how binary search works with an example.',
    'Write a 200 word summary of this article in markdown.',
    'What is the capital of Poland?',
    'Solve 2x + 3 = 9 and show each step.',
    'List the HTTP status codes for client errors.',
].forEach((prompt) => {
    const result = O.optimizeWithReport(prompt);
    check('no errors invented in: ' + JSON.stringify(prompt.slice(0, 34)),
        result.grammar.filter((f) => f.severity === 'error').length === 0,
        JSON.stringify(result.grammar));
    const score = O.analyzePrompt(prompt).score;
    check('a correct prompt scores well: ' + JSON.stringify(prompt.slice(0, 26)),
        score >= 90, 'scored ' + score);
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------
['', '   ', '?', '...', '\n\n\n', '!!!!'].forEach((prompt) => {
    let threw = false;
    try {
        O.optimizeWithReport(prompt);
        O.analyzePrompt(prompt);
    } catch (err) {
        threw = true;
    }
    check('degenerate input does not throw: ' + JSON.stringify(prompt), !threw);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
