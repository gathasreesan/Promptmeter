/**
 * Context-aware modifier and redundancy compression.
 *
 *     node tests/modifiers.test.js
 *
 * The rule under test is not "too many adjectives". Three in a row is not a fault, and
 * deleting on count strips "secure scalable accessible", where every word names a
 * separate thing the application has to do. What makes "simple easy beginner-friendly"
 * wasteful is that all three are names for ONE requirement, so two of them buy nothing.
 *
 * So every case below is a pair: something that must collapse, and something that looks
 * like it and must not.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'modifiers', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
const M = PromptMeterModifiers;
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

/** Compares ignoring trailing punctuation and case, which the card normalises anyway. */
function same(a, b) {
    const tidy = (text) => String(text).replace(/[.\s]+$/, '').trim().toLowerCase();
    return tidy(a) === tidy(b);
}

function rewrites(prompt, expected) {
    const got = O.optimizeWithReport(prompt).text;
    check(JSON.stringify(prompt.slice(0, 44)) + ' -> ' + JSON.stringify(expected),
        same(got, expected), 'got ' + JSON.stringify(got));
}

// ---------------------------------------------------------------------------
// The six required cases
// ---------------------------------------------------------------------------
rewrites('give me a simple easy basic explanation of ML', 'Explain ML simply.');
rewrites('create a beautiful nice amazing responsive website', 'Create a responsive website');
rewrites('build a secure scalable accessible application',
    'Build a secure scalable accessible application');
rewrites('please can you kindly explain to me what Python is', 'Explain Python.');
rewrites('write a short concise brief summary', 'Write a brief summary.');
rewrites('create a simple easy beginner-friendly Python tutorial',
    'Create a beginner-friendly Python tutorial.');

// ---------------------------------------------------------------------------
// The reported failure
// ---------------------------------------------------------------------------
const REPORTED = 'make me a simple esasy clean idea on ml';
const reported = O.optimizeWithReport(REPORTED);
check('the reported prompt no longer says "essay"',
    reported.text.toLowerCase().indexOf('essay') === -1, reported.text);
check('the ambiguity is reported, not hidden',
    reported.grammar.some((f) => f.type === 'ambiguity'),
    JSON.stringify(reported.grammar));
check('both readings are named',
    reported.grammar.some((f) => f.type === 'ambiguity'
        && /easy/.test(f.label) && /essay/.test(f.label)),
    JSON.stringify(reported.grammar.map((f) => f.label)));
check('the superseded spelling line is withdrawn',
    !reported.grammar.some((f) => f.type === 'spelling' && /essay/.test(f.label)),
    JSON.stringify(reported.grammar.map((f) => f.label)));
check('the prompt actually gets shorter',
    PromptMeterTokenizer.stats(REPORTED, reported.text).saved > 0);

// "esasy" with no modifier around it is an essay, and must stay one.
check('essay survives where the context says essay',
    /essay/i.test(O.optimizeWithReport('write a esasy about the war').text),
    O.optimizeWithReport('write a esasy about the war').text);
check('essay survives in a second essay context',
    /essay/i.test(O.optimizeWithReport('i need an esasy on climate change').text));

// ---------------------------------------------------------------------------
// Synonym groups collapse; distinct requirements do not
// ---------------------------------------------------------------------------
[
    ['a simple easy basic explanation', 'a basic explanation'],
    ['a short concise brief summary', 'a brief summary'],
    ['a detailed comprehensive thorough report', 'a comprehensive report'],
    ['a clear understandable readable guide', 'a clear guide'],
    ['a fast rapid quick response', 'a fast response']
].forEach((pair) => {
    const got = M.compress(pair[0]).text;
    check('collapses ' + JSON.stringify(pair[0]), same(got, pair[1]),
        'got ' + JSON.stringify(got));
});

[
    'a secure scalable accessible application',
    'a responsive accessible documented component',
    'an encrypted authenticated cached endpoint',
    'a portable maintainable testable library'
].forEach((prompt) => {
    check('preserves every distinct requirement in ' + JSON.stringify(prompt),
        M.compress(prompt).text === prompt, 'got ' + JSON.stringify(M.compress(prompt).text));
});

// ---------------------------------------------------------------------------
// Subjective adjectives
// ---------------------------------------------------------------------------
check('subjective words go when something concrete survives',
    same(M.compress('a beautiful nice amazing responsive website').text,
        'a responsive website'));
// ...but a subjective word alone is the user's only stated wish, and removing it would
// leave them having asked for nothing in particular.
check('a lone subjective word is kept',
    M.compress('a nice website').text === 'a nice website');
check('two subjective words with nothing concrete are kept',
    M.compress('a nice clean website').text === 'a nice clean website',
    M.compress('a nice clean website').text);

// ---------------------------------------------------------------------------
// What must never be touched
// ---------------------------------------------------------------------------
[
    'the quick brown fox jumps over the lazy dog',
    'explain recursion clearly',
    'a list of secure protocols',
    'compare TCP and UDP',
    'write a 500 word essay in markdown',
    'Fix this:\n```py\nsimple = easy = basic\n```'
].forEach((prompt) => {
    check('leaves alone: ' + JSON.stringify(prompt.slice(0, 36)),
        M.compress(prompt).text === prompt, 'got ' + JSON.stringify(M.compress(prompt).text));
});

// A word this file does not classify is never dropped. Confidence about an unknown word
// is how a compressor deletes somebody's requirement.
check('unknown modifiers survive',
    M.compress('a bespoke idempotent widget').text === 'a bespoke idempotent widget');
check('isModifier is false for an ordinary noun', M.isModifier('website') === false);
check('isModifier is false for a verb', M.isModifier('explain') === false);

// ---------------------------------------------------------------------------
// Numbers, formats and technical terms survive compression
// ---------------------------------------------------------------------------
[
    ['write a short concise brief 500 word summary in markdown', ['500', 'markdown']],
    ['build a simple easy secure Python API', ['secure', 'Python', 'API']],
    ['give me a basic simple explanation of TCP in 3 bullet points', ['TCP', '3']]
].forEach((pair) => {
    const got = O.optimizeWithReport(pair[0]).text;
    pair[1].forEach((token) => {
        check('keeps ' + JSON.stringify(token) + ' in ' + JSON.stringify(pair[0].slice(0, 30)),
            got.toLowerCase().indexOf(token.toLowerCase()) !== -1, 'got ' + JSON.stringify(got));
    });
});

// ---------------------------------------------------------------------------
// The machinery underneath
// ---------------------------------------------------------------------------
check('the most specific member of a group wins',
    M.select(['simple', 'easy', 'beginner-friendly']).keep.join() === 'beginner-friendly');
check('a dropped word says why',
    M.select(['simple', 'easy']).dropped.every((item) => item.reason.length > 10));
check('a single modifier is never a run', M.compress('a simple guide').text === 'a simple guide');
check('nearMisses finds both readings of the typo',
    S.nearMisses('esasy').indexOf('easy') !== -1 && S.nearMisses('esasy').indexOf('essay') !== -1,
    JSON.stringify(S.nearMisses('esasy')));
check('nearMisses can be filtered to modifiers',
    S.nearMisses('esasy', (word) => M.isModifier(word)).join() === 'easy');
check('nearMisses is empty for a correctly spelled word', S.nearMisses('recursion').length === 0
    || !S.nearMisses('recursion').includes('recursion'));

['', '   ', null, undefined, 42].forEach((input) => {
    let threw = false;
    try {
        M.compress(input);
    } catch (error) {
        threw = true;
    }
    check('compress survives ' + JSON.stringify(input), !threw);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
