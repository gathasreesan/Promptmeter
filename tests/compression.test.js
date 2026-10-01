/**
 * Semantic compression: candidates, the validator, and token accounting.
 *
 *     node tests/compression.test.js
 *
 * The validator is what these mostly test. Compression that shortens a prompt is easy;
 * compression that shortens it without quietly changing what was asked is the whole
 * problem, and every rule below is a way that has gone wrong.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer', 'analysis', 'compress'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const K = PromptMeterCompress;
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

const rejects = (name, original, candidate, rule) => {
    const result = K.validate(original, candidate);
    check(name, !result.valid && result.violations.some((v) => v.rule === rule),
        JSON.stringify(result.violations));
};

const accepts = (name, original, candidate) => {
    const result = K.validate(original, candidate);
    check(name, result.valid, JSON.stringify(result.violations));
};

// ---------------------------------------------------------------------------
// The validator: things that must survive
// ---------------------------------------------------------------------------
rejects('a dropped number is caught',
    'Write a summary in exactly 300 words', 'Write a summary', 'numbers');
rejects('a CHANGED number is caught -- the prompt still reads fine',
    'Write a summary in exactly 300 words', 'Write a summary in exactly 30 words', 'numbers');
rejects('a dropped code block is caught',
    'Fix this:\n```py\nx = 1\n```', 'Fix this', 'verbatim');
rejects('a dropped inline span is caught',
    'what does `git rebase -i` do', 'what does rebase do', 'verbatim');
rejects('a dropped URL is caught',
    'summarise https://example.com/a for me', 'summarise it for me', 'verbatim');
rejects('a dropped quoted passage is caught',
    'Translate "good morning everyone" to French', 'Translate to French', 'verbatim');
rejects('a dropped constraint is caught',
    'Explain recursion. Do not use code.', 'Explain recursion.', 'constraint');
rejects('a dropped output format is caught',
    'List the steps in markdown', 'List the steps', 'format');
rejects('a changed task verb is caught',
    'Explain how sorting works', 'Write how sorting works', 'task');
rejects('losing the request entirely is caught',
    'Explain how sorting works', 'sorting and how it works', 'task');
rejects('an invented requirement is caught',
    'Write a blog post about cats', 'Write a 500 word blog post about cats', 'invention');
rejects('an empty candidate is caught', 'Explain recursion', '   ', 'empty');

// ---------------------------------------------------------------------------
// The validator: things that must NOT be flagged
// ---------------------------------------------------------------------------
accepts('removing a greeting is fine',
    'Hi there! Explain recursion to me please.', 'Explain recursion to me.');
accepts('removing padding while keeping the constraint is fine',
    'I was wondering if you could please write a summary in exactly 300 words, thanks!',
    'Write a summary in exactly 300 words');
accepts('a reworded constraint keeping its content is fine',
    'Keep it to no more than 300 words', 'Keep it under 300 words');
accepts('preserved code is fine',
    'Please fix this for me:\n```py\nx = 1\n```', 'Fix this:\n```py\nx = 1\n```');
accepts('an unchanged prompt is trivially valid',
    'Explain recursion', 'Explain recursion');

// A spelling correction introduces a word the original did not contain. Without the
// allowance that reads as invention, and it rejected 15.7% of the conservative tier --
// the tier that does nothing but fix spelling.
check('a spelling fix is not an invention', K.validate(
    'explain recusrion to me', 'explain recursion to me',
    { alsoAllow: 'explain recursion to me' }).valid);
check('...and without the allowance it would be flagged',
    !K.validate('explain recusrion to me', 'explain recursion to me').valid);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
const RICH = 'Hi! I am on a deadline. Write a 500 word summary of the RFC in markdown, '
    + 'using only the standard library. Do not add opinions.';
const parts = K.extract(RICH);
check('the objective is the request, not the opening apology',
    /write a 500 word summary/i.test(parts.objective), parts.objective);
check('the preamble is context', parts.context.some((c) => /deadline/i.test(c)));
check('the word limit is a constraint',
    parts.constraints.some((c) => /500\s+word/i.test(c)), JSON.stringify(parts.constraints));
check('the prohibition is a constraint',
    parts.constraints.some((c) => /do not|only/i.test(c)), JSON.stringify(parts.constraints));
check('markdown is recognised as a format', parts.format.indexOf('markdown') !== -1,
    JSON.stringify(parts.format));
check('RFC is kept as terminology', parts.terminology.indexOf('RFC') !== -1,
    JSON.stringify(parts.terminology));
check('code is captured as reference material',
    K.extract('Fix this:\n```py\nx = 1\n```').reference.length > 0);
check('an empty prompt extracts to empty', K.extract('').objective === '');

// ---------------------------------------------------------------------------
// Candidates and the cost budget
// ---------------------------------------------------------------------------
const WORDY = 'Hi there! I hope you are well. I have been stuck on this for hours. '
    + 'Could you please explain how a B-tree index works in PostgreSQL, and when it '
    + 'beats a hash index? Keep it under 300 words. Thanks so much in advance!';

const tiers = K.candidates(WORDY, 1000);
check('tiers are produced', tiers.length >= 2, JSON.stringify(tiers.map((t) => t.mode)));
check('the first tier is the safest', tiers[0].mode === 'conservative');
check('every tier is a known mode',
    tiers.every((t) => K.MODES.indexOf(t.mode) !== -1));
check('a harder tier is shorter than a gentler one',
    tiers[tiers.length - 1].text.length <= tiers[0].text.length);

// A budget of zero still buys the tiers that cost nothing extra: one analyze() call
// produces both the corrected and the optimized text.
const broke = K.candidates(WORDY, 0);
check('a spent budget still returns the free tiers', broke.length >= 2,
    JSON.stringify(broke.map((t) => t.mode)));
check('a spent budget skips the tier that costs extra',
    broke.every((t) => t.mode !== 'aggressive'));
check('a short prompt skips the aggressive tier',
    K.candidates('Explain recursion', 1000).every((t) => t.mode !== 'aggressive'));

// ---------------------------------------------------------------------------
// compress(): selection, accounting, and refusing to compress
// ---------------------------------------------------------------------------
const wordy = K.compress(WORDY, { repeats: 100 });
check('a wordy prompt compresses', wordy.tokens.saved > 0, JSON.stringify(wordy.tokens));
check('the constraint survives', /300 words/.test(wordy.text), wordy.text);
check('the subject survives', /B-tree/.test(wordy.text) && /PostgreSQL/i.test(wordy.text));
check('the chosen mode is reported', K.MODES.indexOf(wordy.mode) !== -1);
check('the chosen candidate is the shortest valid one', (function () {
    const valid = wordy.candidates.filter((c) => c.valid
        && c.tokens < wordy.tokens.original);
    return valid.every((c) => c.tokens >= wordy.tokens.optimized);
}()));
check('net saving scales with repeats',
    wordy.tokens.netSaved === wordy.tokens.saved * 100, JSON.stringify(wordy.tokens));
check('overhead is recorded', typeof wordy.overheadMs === 'number');
check('the tokenizer is named', typeof wordy.tokens.encoding === 'string');

// Already-tight prompts must be returned untouched rather than mangled to show a number.
[
    'Explain recursion',
    'explain C++ and C# using == and !=',
    'Solve 2x + 3 = 9 and show each step.',
    'What is the capital of Poland?'
].forEach((prompt) => {
    const result = K.compress(prompt);
    check('a tight prompt is left alone: ' + JSON.stringify(prompt.slice(0, 30)),
        result.text === prompt && result.mode === 'none',
        result.mode + ' -> ' + result.text);
});

// Forcing a mode restricts the selection to it.
const forced = K.compress(WORDY, { mode: 'conservative' });
check('a forced mode is honoured',
    forced.mode === 'conservative' || forced.mode === 'none', forced.mode);

// Rejected candidates surface as warnings rather than vanishing.
check('warnings name the mode and what was lost',
    wordy.warnings.every((w) => w.mode && Array.isArray(w.lost)));

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------
['', '   ', null, undefined, 42].forEach((input) => {
    let threw = false;
    let result;
    try {
        result = K.compress(input);
    } catch (error) {
        threw = true;
    }
    check('compress survives ' + JSON.stringify(input), !threw && result && result.mode === 'none');
});

// ---------------------------------------------------------------------------
// The compressed prompt never costs more than the original
// ---------------------------------------------------------------------------
// This is the floor the whole system rests on: compression that lengthens a prompt is
// worse than doing nothing, and doing nothing is always available.
[
    WORDY, 'Explain recursion', 'hey plz teach me ml tmrw', 'explain C++ using == and !=',
    'Write exactly 5 bullet points in markdown about TCP.',
    'Fix this:\n```js\nlet x = 1\n```'
].forEach((prompt) => {
    const result = K.compress(prompt);
    check('never longer: ' + JSON.stringify(prompt.slice(0, 28)),
        result.tokens.optimized <= result.tokens.original,
        result.tokens.original + ' -> ' + result.tokens.optimized);
});

// ---------------------------------------------------------------------------
// Why a prompt did not change: five outcomes that look the same in the text
// ---------------------------------------------------------------------------
const S = K.STATUS;
const statusOf = (prompt, name, expected) => {
    const result = K.compress(prompt, { budgetMs: 1e5 });
    check(name + ' -> ' + expected, result.status === expected,
        result.status + ': ' + result.reason);
    return result;
};

// Repetitive exam prompt. Every sentence asks to "explain", so condense() held them all
// as core and the aggressive tier came out identical to balanced. The restated
// sentence goes now; the topics, the table and the exam context do not.
const DBMS = 'Please please explain normalization in DBMS for my exam. I have an exam tomorrow on DBMS and I really need to understand normalization in DBMS. Can you please explain 1NF, 2NF, 3NF and BCNF in DBMS with examples? Please explain each normal form with an example table so I can prepare for my DBMS exam. Basically I just want you to explain normalization clearly for the exam.';
const dbms = statusOf(DBMS, 'repetitive DBMS prompt', S.SUCCESSFUL);
check('DBMS: the aggressive tier exists and is the one chosen', dbms.mode === 'aggressive', dbms.mode);
check('DBMS: the shortest valid candidate wins', dbms.candidates
    .filter((c) => c.valid).every((c) => c.tokens >= dbms.tokens.optimized));
check('DBMS: every normal form and the table survive',
    ['1NF', '2NF', '3NF', 'BCNF', 'table'].every((w) => dbms.text.indexOf(w) !== -1), dbms.text);

// Already tight. Nothing is shorter, so "unchanged" here is the right answer -- and
// the maths is not skipped as code: a padded version of it does compress.
const MATH = 'Minimize f(x, y) = x^2 + 3y^2 - 2xy + 4x subject to x + y <= 10, x >= 0 and y >= 0. Use the Lagrange multiplier method and the KKT conditions, show every step, and verify that the solution is a global minimum by checking the Hessian.';
check('math prompt is unchanged', statusOf(MATH, 'tight optimisation prompt', S.ALREADY_OPTIMAL).text === MATH);
statusOf('Hi! I hope you are well. ' + MATH + ' Thanks so much in advance!',
    'padded optimisation prompt is not skipped as technical', S.SUCCESSFUL);

// Malayalam. It used to come back as its first sentence -- the sum-of-evens function
// and the request for an explanation both gone -- and validate, because every check
// reads [a-z] and found nothing to object to.
const ML = 'ദയവായി എനിക്ക് പൈത്തണിൽ ഒരു ഫംഗ്ഷൻ എഴുതാൻ സഹായിക്കാമോ? ഒരു ലിസ്റ്റിലെ എല്ലാ ഇരട്ട സംഖ്യകളുടെയും തുക കണ്ടെത്തുന്ന ഒരു ഫംഗ്ഷൻ എഴുതുക. ദയവായി കോഡിന് വിശദീകരണം നൽകുക.';
check('Malayalam prompt comes back whole',
    statusOf(ML, 'Malayalam prompt', S.UNSUPPORTED_LANGUAGE).text === ML);
check('condense no longer prunes a script it cannot read',
    PromptMeterCondense.condense(ML) === ML);

// Constraint-heavy creative prompt: nothing to cut, every rule stays.
const STORY = 'Write a short story of exactly 300 words about a lighthouse keeper. It must be written in second person, present tense. Do not use the word "ocean". Include exactly three lines of dialogue, end with a question, and never name the keeper. The tone must be melancholic but hopeful.';
check('creative prompt is unchanged',
    statusOf(STORY, 'constraint-heavy story prompt', S.ALREADY_OPTIMAL).text === STORY);
const paddedStory = statusOf('Hey! I have always loved lighthouses. ' + STORY + ' Thanks a lot!',
    'padded story prompt', S.SUCCESSFUL);
check('padded story keeps its constraints', paddedStory.text.indexOf(STORY) !== -1, paddedStory.text);

// Shorter candidates exist but each drops a requirement said politely. These used to
// validate: "to not mention" matched no constraint pattern.
const haiku = statusOf('Can you write a haiku about rain? I would like it to not mention water at all. I hope that makes sense and I appreciate your help very much.',
    'polite negative constraint', S.UNSAFE_COMPRESSION);
check('unsafe: the original is returned', haiku.text === haiku.original);
check('unsafe: the reason names the lost constraint', /mention/.test(haiku.reason), haiku.reason);
rejects('a requirement wrapped in "appreciate it if" is caught',
    'Write me a short story. I would really appreciate it if the story had a twist ending.',
    'Write me a short story.', 'constraint');

// A throw inside generation is a failure, not "already optimal".
const realAnalyze = PromptMeterAnalysis.analyze;
PromptMeterAnalysis.analyze = () => { throw new Error('boom'); };
const broken = statusOf(WORDY, 'generation throws', S.FAILED);
PromptMeterAnalysis.analyze = realAnalyze;
check('failed: the original is returned and the error kept',
    broken.text === WORDY && /boom/.test(broken.reason), broken.reason);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
