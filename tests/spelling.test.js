/**
 * PromptMeter spelling corrector regression suite.
 *
 * Dependency-free. Run with:  node tests/spelling.test.js
 *
 * The corrector guesses at words nobody wrote a rule for, which makes it the most
 * dangerous component in the pipeline. A missed typo costs nothing; a wrong correction
 * silently changes what the user asked for, and they may never notice. So the balance of
 * this file is deliberate: most of it asserts that correctly-spelled text, and technical
 * vocabulary in particular, comes back untouched.
 *
 * The three cases that shaped the design are all here as regressions:
 *
 *   SUBSTITUTIONS   an early version rewrote "stack" to "stuck" and "leaf" to "life"
 *   INFLECTIONS     the truncation rule turned "except" into "exception", inverting
 *                   "explain everything except the math part"
 *   EDIT SIZE       a flat distance cap let "access" reach "css"
 */
const { PromptMeterSpelling } = require('../utils/spelling.js');
const { PromptMeterOptimizer } = require('../utils/optimizer.js');

let passed = 0;
const failures = [];

const record = (name, ok, detail) => {
    if (ok) { passed++; return; }
    failures.push(`${name}\n      ${detail}`);
};

/** The word must be corrected to exactly this. */
const corrects = (typo, expected) => {
    const got = PromptMeterSpelling.correctWord(typo);
    record(`[corrects] ${JSON.stringify(typo)}`, got === expected,
        `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};

/** The word must be left exactly as written. */
const keeps = (word, why) => {
    const got = PromptMeterSpelling.correctWord(word);
    record(`[keeps] ${JSON.stringify(word)}${why ? ` (${why})` : ''}`, got === null,
        `rewrote it to ${JSON.stringify(got)}`);
};

// ---------------------------------------------------------------------------
// 1. Corrections it should make
// ---------------------------------------------------------------------------

// Dropped letters -- the dominant shape in fast typing.
corrects('havng', 'having');
corrects('shrt', 'short');
corrects('wrk', 'work');
corrects('diffrence', 'difference');
corrects('necesary', 'necessary');
corrects('tomorow', 'tomorrow');
corrects('betwen', 'between');
corrects('complexty', 'complexity');

// Transpositions.
corrects('teh', 'the');
corrects('recieve', 'receive');
corrects('undrestand', 'understand');
corrects('langauge', 'language');

// Insertions.
corrects('compleate', 'complete');

// Truncation.
corrects('monda', 'monday');

// ---------------------------------------------------------------------------
// 2. Technical vocabulary must survive
// ---------------------------------------------------------------------------

// Each of these was, or could plausibly be, rewritten into a different real word.
keeps('stack', 'was rewritten to "stuck"');
keeps('heap', 'was rewritten to "hope"');
keeps('leaf', 'was rewritten to "life"');
keeps('enum', 'was rewritten to "name"');
keeps('cuda', 'was rewritten to "code"');
keeps('ssl', 'was rewritten to "sell"');
keeps('cors', 'was rewritten to "course"');
keeps('access', 'was rewritten to "css"');

for (const word of ['numpy', 'redis', 'kubernetes', 'docker', 'nginx', 'flask', 'axios',
    'regex', 'jwt', 'oauth', 'grpc', 'webhook', 'cron', 'mutex', 'socket', 'proxy',
    'schema', 'queue', 'graph', 'node', 'async', 'await', 'lambda', 'tuple', 'commit']) {
    keeps(word);
}

// ---------------------------------------------------------------------------
// 3. Real words must never be inflected by the truncation rule
// ---------------------------------------------------------------------------

// "except" -> "exception" inverted the meaning of a prompt; the rule now refuses any
// completion whose added letters form a productive suffix.
for (const word of ['except', 'advance', 'accept', 'expect', 'complete', 'inform',
    'work', 'help', 'return', 'process', 'object', 'insert', 'select', 'result']) {
    keeps(word, 'a real word must not gain a suffix');
}

// ---------------------------------------------------------------------------
// 4. Text-level behaviour
// ---------------------------------------------------------------------------

const report = PromptMeterSpelling.correct('i m havng exam on monda and it is shrt');
record('[text] corrections are reported',
    report.corrections.length >= 3 &&
    report.corrections.every(c => typeof c.from === 'string' && typeof c.to === 'string'),
    `got ${JSON.stringify(report.corrections)}`);

record('[text] capitalization is preserved',
    PromptMeterSpelling.correct('Monda is the day').text.startsWith('Monday'),
    `got ${JSON.stringify(PromptMeterSpelling.correct('Monda is the day').text)}`);

// Identifiers are not prose and must not be touched.
for (const identifier of ['getUserById', 'MAX_RETRY', 'user_id', "don't", 'HTTP']) {
    const out = PromptMeterSpelling.correct(`check ${identifier} now`).text;
    record(`[text] identifier survives: ${JSON.stringify(identifier)}`,
        out.includes(identifier), `got ${JSON.stringify(out)}`);
}

// A mid-sentence capital is a name, not a misspelling.
record('[text] a mid-sentence capitalized word is left alone',
    PromptMeterSpelling.correct('ask Monda about it').text.includes('Monda'),
    `got ${JSON.stringify(PromptMeterSpelling.correct('ask Monda about it').text)}`);

// Placeholders are opaque.
const masked = `fix \uE0000\uE001 and teh bug`;
record('[text] protected placeholders survive',
    PromptMeterSpelling.correct(masked).text.includes('\uE0000\uE001'),
    `got ${JSON.stringify(PromptMeterSpelling.correct(masked).text)}`);

// ---------------------------------------------------------------------------
// 5. Correctly-spelled prompts must come back unchanged
// ---------------------------------------------------------------------------

const CLEAN = [
    'Write a Python script that parses nginx access logs and extracts the slowest endpoints',
    'Explain the difference between a mutex and a semaphore with an example',
    'Refactor this React component to use hooks instead of class lifecycle methods',
    'Compare quicksort and mergesort in terms of worst case time complexity',
    'Summarize the causes of the French Revolution in five bullet points',
    'Convert this SQL query into a MongoDB aggregation pipeline',
    'The webhook fires twice for a single event, what could cause that',
    'Given a binary tree, write a function to find its maximum depth',
    'Explain gradient descent, backpropagation and overfitting in neural networks',
    'Write unit tests with pytest covering the empty input edge case',
    'Explain everything except the math part',
];
for (const prompt of CLEAN) {
    const result = PromptMeterSpelling.correct(prompt);
    record(`[clean] unchanged: ${JSON.stringify(prompt.slice(0, 40))}`,
        result.corrections.length === 0,
        `changed ${JSON.stringify(result.corrections)}`);
}

// ---------------------------------------------------------------------------
// 6. End to end, through the optimizer
// ---------------------------------------------------------------------------

const endToEnd = [
    ['i m havng exam on Monda teach me ml make it shrt', ['teach me ml', 'short']],
    ['hey tmrw is mi exm teach me ML', ['teach me ml']],
    ['plz explain teh diffrence betwen list and tuple', ['difference', 'between', 'tuple']],
    ['can u wrk out the complexty of this algoritm', ['work', 'complexity', 'algorithm']],
];
for (const [prompt, expected] of endToEnd) {
    const out = PromptMeterOptimizer.optimizePrompt(prompt).toLowerCase();
    const missing = expected.filter(fragment => !out.includes(fragment));
    record(`[end-to-end] ${JSON.stringify(prompt.slice(0, 40))}`, missing.length === 0,
        `missing ${JSON.stringify(missing)}\n      got: ${JSON.stringify(out)}`);
}

// The situational preamble must go even when it was typed in shorthand.
record('[end-to-end] an abbreviated preamble is still stripped',
    !PromptMeterOptimizer.optimizePrompt('i m havng exam on Monda teach me ml make it shrt')
        .toLowerCase().includes('exam'),
    'the exam preamble survived');

// ---------------------------------------------------------------------------
// 7. Regressions from the first-letter and skeleton-length guards
// ---------------------------------------------------------------------------

// A correction that strips the opening letter turns one real word into another. This
// family was found by sweeping common English, and "every" -> "very" reached production
// output before the guard existed: "Explain every feature" became "Explain very feature".
for (const word of ['every', 'along', 'apart', 'aside', 'ahead', 'around', 'across']) {
    keeps(word, 'the first letter must survive');
}

// A one-consonant skeleton carries no evidence, and short words are the weak spot.
for (const word of ['bee', 'hoe', 'ore', 'boy', 'cup', 'cold', 'rain', 'men', 'rat', 'hat']) {
    keeps(word);
}

// Truncation completes only calendar names. A general prefix rule turned "mark" into
// "market", "count" into "country" and "star" into "start".
for (const word of ['mark', 'count', 'star', 'ever', 'plan', 'form', 'port', 'sign']) {
    keeps(word, 'not a calendar name');
}
corrects('tuesda', 'tuesday');
corrects('januar', 'january');

// ---------------------------------------------------------------------------
// 8. Commonly misspelled words, covered by exact pairs
// ---------------------------------------------------------------------------

// These are nearly all SUBSTITUTIONS, the one edit shape this module refuses on purpose,
// so they are carried as exact pairs in optimizer.js instead. Verified through the
// optimizer so the two halves are tested where they actually meet.
for (const [typo, fixed] of [
    ['seperate', 'separate'], ['occassion', 'occasion'], ['definately', 'definitely'],
    ['embarass', 'embarrass'], ['accomodate', 'accommodate'], ['arguement', 'argument'],
    ['begining', 'beginning'], ['calender', 'calendar'], ['collegue', 'colleague'],
    ['concious', 'conscious'], ['enviroment', 'environment'], ['existance', 'existence'],
    ['goverment', 'government'], ['independant', 'independent'], ['knowlegde', 'knowledge'],
    ['maintenence', 'maintenance'], ['managment', 'management'], ['noticable', 'noticeable'],
    ['occured', 'occurred'], ['persistant', 'persistent'], ['recomend', 'recommend'],
    ['relevent', 'relevant'], ['remeber', 'remember'], ['succesful', 'successful'],
    ['truely', 'truly'], ['wierd', 'weird'], ['thier', 'their'], ['recieved', 'received'],
    ['lenght', 'length'], ['varible', 'variable'], ['retreive', 'retrieve'],
]) {
    const out = PromptMeterOptimizer.optimizePrompt(`explain ${typo} briefly`).toLowerCase();
    record(`[misspelling] ${JSON.stringify(typo)} -> ${JSON.stringify(fixed)}`,
        out.includes(fixed) && !out.includes(typo), `got ${JSON.stringify(out)}`);
}

// No key in that table may be a real word: replacing one would corrupt correct text.
const realWordKeys = Object.keys(PromptMeterOptimizer.spellingTypos)
    .filter(key => PromptMeterSpelling.known(key));
record('[misspelling] no typo key is a real dictionary word',
    realWordKeys.length === 0, `these are real words: ${JSON.stringify(realWordKeys)}`);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log('\nFailures:\n');
    failures.forEach((failure, index) => console.log(`  ${index + 1}. ${failure}\n`));
    process.exit(1);
}
console.log('\nAll spelling checks passed.');
