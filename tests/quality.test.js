/**
 * Prompt-quality scoring, and the input shapes that have historically broken it.
 *
 *     node tests/quality.test.js
 *
 * Covers the cases the scorer has to survive rather than only the ones it is good at:
 * empty input, code, mathematical operators, special characters, multilingual text,
 * contradictions, ambiguity and duplicates. Several of these used to return a confident
 * 100/100, which is a worse failure than a wrong number -- it tells the user their
 * prompt is perfect when the scorer simply could not read it.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
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

/** The set of quality rule ids that fired. */
function ids(prompt) {
    const result = O.analyzePrompt(prompt);
    return (result.quality || []).map((f) => f.id);
}

function fires(name, prompt, id) {
    const got = ids(prompt);
    check(name, got.indexOf(id) !== -1, 'expected ' + id + ', got [' + got.join(', ') + ']');
}

function silent(name, prompt, id) {
    const got = ids(prompt);
    check(name, got.indexOf(id) === -1, 'unexpected ' + id + ' on ' + JSON.stringify(prompt));
}

// ---------------------------------------------------------------------------
// Empty and degenerate input
// ---------------------------------------------------------------------------
// An empty prompt used to score 100 -- the one input that cannot be good scored best,
// and every empty box pulled the dashboard average up.
check('empty string is unscored, not perfect', O.analyzePrompt('').score === null);
check('empty string says so', O.analyzePrompt('').scored === false);
check('whitespace only is unscored', O.analyzePrompt('   \n\t  ').score === null);
check('null input is unscored', O.analyzePrompt(null).score === null);
check('undefined input is unscored', O.analyzePrompt(undefined).score === null);
check('a number is unscored', O.analyzePrompt(42).score === null);
check('a real prompt is scored', O.analyzePrompt('Explain recursion').scored === true);

// ---------------------------------------------------------------------------
// Scores stay inside their range whatever fires
// ---------------------------------------------------------------------------
const AWFUL = 'hi there!! thanks so much in advance, i was just wondering if u could '
    + 'possibly maybe help me out with some stuff and things, make it good and nice '
    + 'and detailed but brief, thx thx and';
const awful = O.analyzePrompt(AWFUL);
check('a bad prompt stays at or above 0', awful.score >= 0, 'got ' + awful.score);
check('a bad prompt scores well below 100', awful.score < 70, 'got ' + awful.score);
check('a bad prompt reports several issues', awful.quality.length >= 2);
check('every finding carries its metric definition',
    awful.quality.every((f) => typeof f.metric === 'string' && f.metric.length > 20));
check('every finding carries a penalty', awful.quality.every((f) => f.penalty > 0));

// ---------------------------------------------------------------------------
// Code, operators and special characters must not be read as prose
// ---------------------------------------------------------------------------
const CODE = 'Fix this:\n```python\ndef f(x):\n    return x ** 2 + 1\n```';
check('a code prompt is scored', O.analyzePrompt(CODE).scored === true);
silent('code present, so no dangling reference', CODE, 'dangling-reference');
fires('code referenced but absent is flagged', 'Fix the code below', 'dangling-reference');

check('optimizer preserves the code body',
    O.optimizeWithReport(CODE).text.indexOf('x ** 2 + 1') !== -1,
    O.optimizeWithReport(CODE).text);

const MATH = 'Solve for x: 3x^2 - 4x + 1 >= 0 and show each step';
check('maths keeps its operators',
    /3x\^2 - 4x \+ 1 >= 0/.test(O.optimizeWithReport(MATH).text),
    O.optimizeWithReport(MATH).text);
silent('a maths prompt with steps needs no format note', MATH, 'missing-output-format');

const SPECIAL = 'Explain what @#$%^&*()_+-=[]{}|;:\'",.<>/?`~ do in a shell';
check('special characters do not throw', O.analyzePrompt(SPECIAL).scored === true);
check('special characters survive the optimizer',
    O.optimizeWithReport(SPECIAL).text.indexOf('@#$%^&*') !== -1);

// A data payload is not padding: the request survives and the data must too.
const PAYLOAD = 'Output the 3rd and 7th element of the following list:\n'
    + '[1, 5, 8, 11, 15, 20, 24, 30]';
check('a list payload survives',
    O.optimizeWithReport(PAYLOAD).text.indexOf('[1, 5, 8, 11, 15, 20, 24, 30]') !== -1,
    O.optimizeWithReport(PAYLOAD).text);

const FIELDS = 'Calculate the price.\nItem: Apple iPad Pro\nQuantity: 3';
check('label/value rows survive',
    /Quantity: 3/.test(O.optimizeWithReport(FIELDS).text),
    O.optimizeWithReport(FIELDS).text);

// ---------------------------------------------------------------------------
// The quality dimensions
// ---------------------------------------------------------------------------
fires('a generative ask with no format', 'Write a blog post about cats',
    'missing-output-format');
silent('a generative ask WITH a format', 'Write a 500 word blog post about cats in markdown',
    'missing-output-format');
silent('a factual question needs no format', 'What is the capital of Poland?',
    'missing-output-format');

fires('opposing requirements', 'Give me a detailed but brief summary of the war',
    'contradiction');
fires('opposing requirements, reversed', 'I want a comprehensive yet concise overview',
    'contradiction');
silent('one requirement alone is not a contradiction', 'Give me a brief summary',
    'contradiction');

fires('an instruction that stops part-way', 'Summarise this article and',
    'truncated-instruction');
silent('a finished instruction', 'Summarise this article in three bullets.',
    'truncated-instruction');

fires('no request at all', 'The weather is nice today in Paris', 'no-clear-request');
silent('an imperative is a request', 'Determine the volume of a cube with sides 4 cm',
    'no-clear-request');
silent('a question is a request', 'Why is the sky blue?', 'no-clear-request');
silent('a stated want is a request', 'I need a list of European capitals',
    'no-clear-request');

fires('vague words carrying the whole spec', 'make it better and nicer somehow',
    'vague-specification');
silent('a concrete constraint cancels vagueness', 'Write a good summary in 200 words',
    'vague-specification');
// Quoted material is the user's content, not their specification.
silent('vague words inside a quote do not count',
    'Translate this to French: "good morning"', 'vague-specification');

// ---------------------------------------------------------------------------
// Multilingual input
// ---------------------------------------------------------------------------
// The rules are English and cannot judge these. What matters is that they neither throw
// nor invent findings they have no basis for.
[
    ['Spanish', 'Explica la recursividad con un ejemplo sencillo'],
    ['German', 'Erkläre mir bitte den Unterschied zwischen Prozess und Thread'],
    ['Hindi', 'मुझे मशीन लर्निंग समझाओ'],
    ['Japanese', '再帰について簡単に説明してください'],
    ['Arabic', 'اشرح لي كيفية عمل البحث الثنائي'],
    ['Malayalam', 'എനിക്ക് മെഷീൻ ലേണിംഗ് പഠിപ്പിക്കൂ'],
    ['mixed', 'explain करो machine learning simply'],
].forEach((pair) => {
    const name = pair[0];
    const prompt = pair[1];
    let result;
    try {
        result = O.analyzePrompt(prompt);
    } catch (err) {
        check(name + ' does not throw', false, String(err));
        return;
    }
    check(name + ' is scored without throwing',
        result.scored === true && typeof result.score === 'number');
    check(name + ' score stays in range', result.score >= 0 && result.score <= 100);

    let optimized;
    try {
        optimized = O.optimizeWithReport(prompt).text;
    } catch (err) {
        check(name + ' optimizes without throwing', false, String(err));
        return;
    }
    check(name + ' is not emptied by the optimizer',
        typeof optimized === 'string' && optimized.trim().length > 0,
        JSON.stringify(optimized));
});

// ---------------------------------------------------------------------------
// Length is information, not a verdict
// ---------------------------------------------------------------------------
// "Do not reward length alone" -- a short complete prompt must not be marked down, and
// padding a prompt out must not raise its score.
check('a short complete prompt scores full marks',
    O.analyzePrompt('Explain recursion').score === 100,
    'got ' + O.analyzePrompt('Explain recursion').score);

const TERSE = 'List the HTTP status codes for client errors';
const PADDED = 'Hi there! I was just wondering if you could possibly help me out. '
    + 'I would really like to know, if it is not too much trouble, what the various '
    + 'HTTP status codes for client errors happen to be. Thanks so much in advance!';
check('padding a prompt does not raise its score',
    O.analyzePrompt(PADDED).score <= O.analyzePrompt(TERSE).score,
    'terse ' + O.analyzePrompt(TERSE).score + ' vs padded ' + O.analyzePrompt(PADDED).score);

// ---------------------------------------------------------------------------
// Duplicates and history
// ---------------------------------------------------------------------------
const HISTORY = [{ prompt: 'Explain recursion', timestamp: new Date().toISOString() }];
check('an immediate repeat is penalised',
    O.analyzePrompt('Explain recursion', HISTORY).score
    < O.analyzePrompt('Explain recursion').score);
check('history does not break scoring of a new prompt',
    O.analyzePrompt('Explain closures', HISTORY).score === 100);
check('an empty history is fine', O.analyzePrompt('Explain recursion', []).score === 100);

// ---------------------------------------------------------------------------
// Every rule is documented, and the ids the dashboard reads are stable
// ---------------------------------------------------------------------------
const EXPECTED_IDS = ['missing-output-format', 'dangling-reference', 'contradiction',
    'vague-specification', 'no-clear-request', 'truncated-instruction'];
EXPECTED_IDS.forEach((id) => {
    check('rule ' + id + ' exists', O.qualityRules.some((r) => r.id === id));
});
O.qualityRules.forEach((rule) => {
    check('rule ' + rule.id + ' documents its metric',
        typeof rule.metric === 'string' && rule.metric.length > 40);
    check('rule ' + rule.id + ' has a sane penalty',
        rule.per > 0 && rule.cap >= rule.per && rule.cap <= 20);
    check('rule ' + rule.id + ' has a human label',
        typeof rule.label === 'string' && rule.label.length > 5);
});

// A rule that throws must not take the score down with it.
const broken = { id: 'broken', label: 'x', metric: 'y'.repeat(50), per: 5, cap: 5,
    test: function () { throw new Error('boom'); } };
O.qualityRules.push(broken);
try {
    check('a throwing rule is skipped, not fatal',
        O.analyzePrompt('Explain recursion').scored === true);
} finally {
    O.qualityRules.pop();
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
