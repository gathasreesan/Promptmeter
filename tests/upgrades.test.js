/**
 * The round of fixes found by probing the optimizer with ordinary conversational prompts.
 *
 *     node tests/upgrades.test.js
 *
 * Every case here comes from a measured failure, not from imagination. Four were
 * CORRECTNESS faults -- the optimizer was making prompts worse, not merely leaving
 * tokens on the table -- and those are the ones worth a suite:
 *
 *   1. "the main points that are discussed" -> "that is discussed". A relative pronoun
 *      was read as a singular demonstrative, so a sentence the user got right came back
 *      broken.
 *   2. "I have a question about machine learning" -> "Machine learning". The frame was
 *      carrying the only verb, and stripping it left a noun phrase that asks for nothing.
 *   3. "can you clarify" -> "clarity". The dictionary did not contain "clarify", so the
 *      corrector found a near neighbour and rewrote a correctly spelled word.
 *   4. "at the end of the day ..." was masked whole as a stack frame, so the optimizer
 *      could not touch one word of any prompt whose line began "at ".
 *
 * The rest are efficiency: filler families that measured as uncovered.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'modifiers', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
const S = PromptMeterSpelling;
const P = PromptMeterProtect;
const M = PromptMeterModifiers;
const C = PromptMeterCondense;
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

const tidy = (text) => String(text).replace(/[.\s]+$/, '').trim().toLowerCase();

/** The optimized prompt, compared ignoring case and trailing punctuation. */
function rewrites(prompt, expected) {
    const got = O.optimizeWithReport(prompt).text;
    check(JSON.stringify(prompt.slice(0, 52)) + ' -> ' + JSON.stringify(expected),
        tidy(got) === tidy(expected), 'got ' + JSON.stringify(got));
}

/** The prompt must survive the pipeline unchanged apart from capitalization. */
function unchanged(prompt) {
    const got = O.optimizeWithReport(prompt).text;
    check('unchanged: ' + JSON.stringify(prompt.slice(0, 52)),
        tidy(got) === tidy(prompt), 'got ' + JSON.stringify(got));
}

/** The prompt must get shorter by at least `words` words. */
function shrinks(prompt, words) {
    const report = O.optimizeWithReport(prompt);
    check('shrinks by >= ' + words + ': ' + JSON.stringify(prompt.slice(0, 44)),
        report.savedWords >= words,
        'saved ' + report.savedWords + ', got ' + JSON.stringify(report.text));
}

// ---------------------------------------------------------------------------
// 1. A relative "that" takes its antecedent's number
// ---------------------------------------------------------------------------
// "that" is a demonstrative only at the start of a clause. Anywhere else it refers back
// to a noun, and that noun sets the verb.
[
    'Write a summary of the main points that are discussed in the article',
    'list the tests that are failing',
    'show me the files that were changed',
    'name the options that have defaults',
    'the records that are missing a date',
    'find the users that do not have an email'
].forEach((prompt) => {
    const got = O.optimizeWithReport(prompt).text;
    check('relative "that" keeps its plural verb: ' + JSON.stringify(prompt.slice(0, 40)),
        !/that\s+(?:is|was|has|does)\b/i.test(got), 'got ' + JSON.stringify(got));
});

// ...while a demonstrative "that" opening a clause is still corrected.
check('a clause-initial demonstrative "that" is still fixed',
    /that\s+is/i.test(PromptMeterGrammar.correct('That are the wrong files', []).text));

// ---------------------------------------------------------------------------
// 2. A question frame carries the verb
// ---------------------------------------------------------------------------
rewrites('I have a question about recursion', 'Explain recursion');
rewrites('Quick question about the event loop', 'Explain the event loop');
rewrites('Hey there! I hope you are doing well. I have a question about machine learning algorithms.',
    'Explain machine learning algorithms.');
// When the real question follows, the frame is preamble and goes as before.
rewrites('I have a question about Python: why does list.sort() return None?',
    'Python: why does list.sort() return None?');
rewrites('I have a quick question about closures, can you explain them',
    'Closures, explain them');
// Only the frame's own sentence is folded.
rewrites('I have a question about X. Also write a test for Y.',
    'Explain X. Also write a test for Y.');
// No topic after the frame: nothing to fold onto, so it is left for the strippers.
unchanged('I have a question');

// Whatever the frame becomes, the result has to ask for something.
[
    'I have a question about recursion',
    'Quick question about the event loop',
    'I have a question about machine learning'
].forEach((prompt) => {
    const got = O.optimizeWithReport(prompt).text;
    const asks = new RegExp('\\b(?:' + C.ASK_WORDS.join('|') + ')\\b', 'i').test(got)
        || got.indexOf('?') !== -1;
    check('result still asks for something: ' + JSON.stringify(prompt.slice(0, 40)),
        asks, 'got ' + JSON.stringify(got));
});

// ---------------------------------------------------------------------------
// 3. The dictionary must contain every word the project's own rules call English
// ---------------------------------------------------------------------------
// This is the guard, not the patch. A word missing from the dictionary is not merely
// unrecognised: the corrector finds a near neighbour and rewrites a correctly spelled
// word into a WRONG one, which is how "can you clarify" became "clarity".
const claimed = new Set();
const claim = (value) => {
    if (typeof value !== 'string') return;
    const word = value.trim().toLowerCase();
    // Single words only. A multi-word replacement is a phrase, not a dictionary entry.
    if (/^[a-z][a-z'-]{2,}$/.test(word)) claimed.add(word);
};
[O.typoMap, O.spellingMap, O.slangMap, O.acronymMap].forEach((map) => {
    if (map) Object.keys(map).forEach((key) => claim(map[key]));
});
[C.ASK_WORDS, C.BARE_ASK, M.SUBJECTIVE, M.CONCRETE].forEach((list) => {
    if (list) list.forEach(claim);
});
if (M.SYNONYM_GROUPS) {
    Object.keys(M.SYNONYM_GROUPS).forEach((group) =>
        M.SYNONYM_GROUPS[group].forEach(claim));
}
const unknown = [...claimed].filter((word) => !/[^a-z]/.test(word) && !S.known(word));
check('every word the rules treat as English is in the dictionary ('
    + claimed.size + ' checked)', unknown.length === 0, 'missing: ' + unknown.join(' '));

// The specific words that were rewriting themselves into something else.
'clarify simplify classify refactor revise derive elaborate asynchronous idempotent'
    .split(' ').forEach((word) => {
        check('"' + word + '" is spelled correctly already', S.known(word));
    });
[
    ['the answer is unclear, can you clarify', 'clarity'],
    ['please simplify this function', 'simplicity'],
    ['refactor the parser', 'refactory']
].forEach((pair) => {
    const got = O.optimizeWithReport(pair[0]).text;
    check('"' + pair[0].slice(0, 30) + '" is not corrupted into "' + pair[1] + '"',
        got.toLowerCase().indexOf(pair[1]) === -1, 'got ' + JSON.stringify(got));
});

// ---------------------------------------------------------------------------
// 4. A stack frame needs a location; prose starting with "at" is not code
// ---------------------------------------------------------------------------
const BS = String.fromCharCode(92);
[
    '    at Object.<anonymous> (C:' + BS + 'x' + BS + 'y.js:3:9)',
    '    at Module._compile (node:internal/modules/cjs/loader:1847:20)',
    '    at /app/index.js:10:5',
    '    at new Promise (<anonymous>)',
    '\tat com.example.Foo.bar(Foo.java:42)',
    '    at foo (native)'
].forEach((frame) => {
    check('stack frame is still protected: ' + JSON.stringify(frame.trim().slice(0, 40)),
        P.mask(frame).spans.length > 0);
});
[
    'at the end of the day what matters is performance',
    'at first I thought the answer was obvious',
    'at least tell me where to start',
    'at this point explain the algorithm'
].forEach((prompt) => {
    check('prose is not masked as code: ' + JSON.stringify(prompt.slice(0, 40)),
        P.mask(prompt).spans.length === 0,
        JSON.stringify(P.mask(prompt).spans));
});
// A fully masked prompt is a prompt the extension silently does nothing for, so the
// consequence is checked too, not only the cause.
shrinks('at the end of the day what matters is performance', 4);

// No ordinary prompt should ever be masked in its entirety.
[
    'write a poem about the sea', 'explain why recursion is hard to learn',
    'tell me about the history of Rome', 'compare cats and dogs as pets',
    'in the morning I want to revise my notes', 'summarise the plot of Hamlet',
    'from the beginning explain how sorting works', 'teach me the basics of chess'
].forEach((prompt) => {
    check('not wholly masked: ' + JSON.stringify(prompt.slice(0, 36)),
        P.mask(prompt).spans.indexOf(prompt) === -1);
});

// ---------------------------------------------------------------------------
// 4b. A code KEYWORD is not code; code punctuation is
// ---------------------------------------------------------------------------
// Reading a prompt as code makes the optimizer hand it back untouched, so every prompt
// opening with if/for/while/class/return/let/const was a silent no-op.
[
    'if you ask me the answer is obvious, explain why',
    'for each student calculate the average grade',
    'while I was reading I noticed a mistake, fix it',
    'class sizes in schools are growing, discuss why',
    'return the book to the library, translate that to French',
    'def is short for define, explain the Python keyword',
    'async work is hard to reason about, explain it simply',
    'let me know what you think about this poem',
    'var is the old way to declare a variable in JS, explain',
    'const values cannot change, is that right',
    'function of the heart in the human body, describe it',
    'switch the order of these two paragraphs'
].forEach((prompt) => {
    check('prose is not read as code: ' + JSON.stringify(prompt.slice(0, 40)),
        O.isCodeSnippet(prompt) === false);
});

// ...and real code still is. Four of these were MISSED by the old rule, which required a
// word character after the keyword and so could not see a paren.
[
    'if (x > 1) { return 2; }',
    'for (let i = 0; i < n; i++) {',
    'while (running) {',
    'class Foo extends Bar {',
    'return a + b;',
    'def main():',
    'async function go() {',
    'let x = 1;',
    'const y = 2;',
    'var z = 3;',
    'function add(a, b) {',
    'switch (kind) {',
    'if x == 1:',
    'for item in items:'
].forEach((snippet) => {
    check('code is still detected: ' + JSON.stringify(snippet.slice(0, 32)),
        O.isCodeSnippet(snippet) === true);
});

// ---------------------------------------------------------------------------
// 5. Filler families that measured as uncovered
// ---------------------------------------------------------------------------
rewrites('in my opinion I think that it is very important to understand the basics of algorithms',
    'Understand the basics of algorithms');
rewrites('what are some of the best practices that I should follow when writing unit tests',
    'Best practices for writing unit tests');
rewrites('the reason why I am asking is that I need to understand closures',
    'Understand closures');
rewrites('I just want to know how to center a div', 'How to center a div');
rewrites('honestly speaking, explain recursion', 'Explain recursion');
rewrites('to be honest I think that this code is too slow, optimise it',
    'This code is too slow, optimise it');
rewrites('so basically I am trying to figure out why my code is not working properly and I need help',
    'Figure out why my code is not working properly');
rewrites('I am currently working on a project and I was hoping you might be able to assist me',
    'Assist me with a project.');
rewrites('do you think you might be able to write a test', 'Write a test');

// Every one of those must shrink, which is the point of the rules.
[
    ['at the end of the day what matters is performance', 4],
    ['if you ask me the answer is obvious, explain why', 3],
    ['as far as I know Python is interpreted, confirm this', 3],
    ['the way I see it we should use a queue, review that', 3]
].forEach((pair) => shrinks(pair[0], pair[1]));

// ---------------------------------------------------------------------------
// The guards. Each of these looks like something above and must not be touched.
// ---------------------------------------------------------------------------
[
    // The importance IS the subject here, not a wrapper round it.
    'Explain why it is important to write tests',
    'Why is it important to use HTTPS',
    // A symptom, not an opinion frame.
    'I feel dizzy, what could cause that',
    // "believe"/"think" without a clause to strip.
    'I believe you are wrong, prove it',
    'I think differently about this',
    // "best practices" as a noun phrase, not a question template.
    'Describe the best practices document',
    // The "hello world" program keeps its hello.
    'Write a hello world program in C',
    // An operator is not sentence punctuation.
    'Explain C++ and C# using == and !='
].forEach(unchanged);

// ---------------------------------------------------------------------------
// 6. Stretched spelling collapses to a real word
// ---------------------------------------------------------------------------
[
    ['doooomed scrollerty', 'doomed'],
    ['pleaaase help me', 'help'],
    ['sooooo confusing', 'confusing'],
    ['thaaaanks a lot', 'thanks'],
    ['that is greeeeat', 'great'],
    ['I neeeeed this', 'need']
].forEach((pair) => {
    const got = O.optimizeWithReport(pair[0]).text.toLowerCase();
    check('stretched spelling collapses: ' + JSON.stringify(pair[0]),
        got.indexOf(pair[1]) !== -1, 'got ' + JSON.stringify(got));
});
// A real doubled letter is not a stretch.
['discuss the committee', 'address the bookkeeper', 'llama and python',
 'the aardvark and the bee'].forEach((prompt) => {
    const got = O.optimizeWithReport(prompt).text.toLowerCase();
    prompt.split(' ').filter((word) => /([a-z])\1/.test(word)).forEach((word) => {
        check('real double letters survive in ' + JSON.stringify(word),
            got.indexOf(word) !== -1, 'got ' + JSON.stringify(got));
    });
});

// ---------------------------------------------------------------------------
// 7. Nothing here may cost preservation
// ---------------------------------------------------------------------------
[
    ['at the end of the day we shipped 3 features in 2 sprints, summarise', ['3', '2']],
    ['I have a question about https://example.com/docs', ['https://example.com/docs']],
    ['in my opinion `sort()` is wrong, explain', ['sort()']],
    ['what are some of the best practices for writing "clean" code', ['"clean"']],
    ['I just want to know how to fix:\n```py\nx = 1\n```', ['x = 1']]
].forEach((pair) => {
    const got = O.optimizeWithReport(pair[0]).text;
    pair[1].forEach((token) => {
        check('preserves ' + JSON.stringify(token) + ' in ' + JSON.stringify(pair[0].slice(0, 28)),
            got.indexOf(token) !== -1, 'got ' + JSON.stringify(got));
    });
});

// ---------------------------------------------------------------------------
// 8. Nothing throws, and nothing returns empty
// ---------------------------------------------------------------------------
['', '   ', '?', '!!!', 'a', 'at', 'at the', 'I have a question about',
 'in my opinion', 'honestly speaking', 'be able to'].forEach((prompt) => {
    let threw = false;
    let got = null;
    try {
        got = O.optimizeWithReport(prompt);
    } catch (error) {
        threw = true;
    }
    check('survives ' + JSON.stringify(prompt), !threw && got !== null);
    if (got && prompt.trim()) {
        check('does not empty out ' + JSON.stringify(prompt), got.text.trim().length > 0,
            'got ' + JSON.stringify(got.text));
    }
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
