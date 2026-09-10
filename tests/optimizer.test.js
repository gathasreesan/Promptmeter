/**
 * PromptMeter optimizer regression suite.
 *
 * Dependency-free. Run with:  node tests/optimizer.test.js
 *
 * The three properties that matter, in priority order:
 *   1. VERBATIM  - protected spans (code, URLs, paths, quotes, identifiers) come back
 *                  byte for byte. A violation here corrupts the user's prompt.
 *   2. PRESERVED - words that carry the user's actual instruction survive.
 *   3. STRIPPED  - filler, pleasantries and noise are removed.
 *
 * A failure in (1) or (2) is a correctness bug. A failure in (3) is a coverage gap.
 */
const { PromptMeterOptimizer } = require('../utils/optimizer.js');
const { PromptMeterProtect } = require('../utils/protect.js');
const { PromptMeterCondense } = require('../utils/condense.js');

let passed = 0;
const failures = [];

const record = (name, ok, detail) => {
    if (ok) { passed++; return; }
    failures.push(`${name}\n      ${detail}`);
};

/** Every listed fragment must appear unchanged in the optimized output. */
const verbatim = (name, prompt, fragments) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    const lost = fragments.filter(f => !out.includes(f));
    record(`[verbatim] ${name}`, lost.length === 0,
        `lost ${JSON.stringify(lost)}\n      got: ${JSON.stringify(out)}`);
};

/** Every listed word must still be present (case-insensitively). */
const preserved = (name, prompt, words) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt).toLowerCase();
    const lost = words.filter(w => !out.includes(w.toLowerCase()));
    record(`[preserved] ${name}`, lost.length === 0,
        `lost ${JSON.stringify(lost)}\n      got: ${JSON.stringify(out)}`);
};

/** No listed fragment may survive in the output. */
const stripped = (name, prompt, fragments) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt).toLowerCase();
    const kept = fragments.filter(f => out.includes(f.toLowerCase()));
    record(`[stripped] ${name}`, kept.length === 0,
        `kept ${JSON.stringify(kept)}\n      got: ${JSON.stringify(out)}`);
};

/** The prompt must come back completely untouched. */
const untouched = (name, prompt) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    record(`[untouched] ${name}`, out === prompt,
        `changed to: ${JSON.stringify(out)}`);
};

// ---------------------------------------------------------------------------
// 1. Protected spans -- must survive verbatim
// ---------------------------------------------------------------------------

verbatim('fenced code block',
    'please fix this thanks:\n```js\nfunction add(a, b) { return a + b; }\n```',
    ['```js\nfunction add(a, b) { return a + b; }\n```']);

verbatim('inline code',
    'could you please explain what `Array.prototype.reduce` does, thanks!',
    ['`Array.prototype.reduce`']);

verbatim('indented code block',
    'hey can you review this pls\n\n    def foo():\n        return 42\n\nthanks a lot',
    ['    def foo():\n        return 42']);

verbatim('url with query string',
    'hi! could you please summarise https://example.com/docs?page=2&sort=asc thanks',
    ['https://example.com/docs?page=2&sort=asc']);

verbatim('windows path', 'plz open C:\\Users\\gatha\\Documents\\report.txt asap',
    ['C:\\Users\\gatha\\Documents\\report.txt']);

verbatim('unix path', 'kindly check /var/log/nginx/error.log for me thanks',
    ['/var/log/nginx/error.log']);

verbatim('quoted material must stay exact',
    'please translate "could you kindly help me please" into French, thanks!',
    ['"could you kindly help me please"']);

verbatim('identifiers and calls',
    'hey um can you please explain getUserById() and MAX_RETRY_COUNT thanks',
    ['getUserById()', 'MAX_RETRY_COUNT']);

verbatim('snake_case and camelCase',
    'plz rename user_profile_id to userProfileId asap thanks',
    ['user_profile_id', 'userProfileId']);

verbatim('shell command with flags',
    'could you please tell me what npm install --save-dev --legacy-peer-deps does, thanks',
    ['--save-dev', '--legacy-peer-deps']);

verbatim('env vars and templates',
    'hi, please set $DATABASE_URL and ${API_KEY} and {{user_name}} thanks',
    ['$DATABASE_URL', '${API_KEY}', '{{user_name}}']);

verbatim('version numbers and hashes',
    'plz check if v2.14.3 broke commit 9f8a7b6c5d4e3f2a thanks so much',
    ['v2.14.3', '9f8a7b6c5d4e3f2a']);

verbatim('html tags', 'hey could you please explain <div class="row"> and </section> thanks',
    ['<div class="row">', '</section>']);

verbatim('stack trace',
    'plz help!! TypeError: Cannot read properties of undefined (reading \'map\')',
    ['TypeError: Cannot read properties of undefined']);

verbatim('email address', 'kindly send it to support@example.co.uk thanks in advance',
    ['support@example.co.uk']);

verbatim('sql keeps its shape inside a fence',
    'please optimise this thanks:\n```sql\nSELECT * FROM users WHERE id = 1;\n```',
    ['```sql\nSELECT * FROM users WHERE id = 1;\n```']);

untouched('pure code is returned unchanged',
    'const x = 1;\nfunction go() {\n  return x + 1;\n}\nconsole.log(go());');

untouched('prompt that is only protected spans',
    'https://example.com/a/b/c');

// ---------------------------------------------------------------------------
// 2. Meaning preservation -- junk words that are real content must survive
// ---------------------------------------------------------------------------

preserved('"like" as a preposition', 'show me a list like this one',
    ['list', 'like', 'this one']);

preserved('"like" as a verb', 'I like python, explain decorators', ['like', 'decorators']);

preserved('"so" as a conjunction of meaning', 'explain why the loop is so slow',
    ['loop', 'slow']);

preserved('technical content survives heavy stripping',
    'hello!! sorry for the dumb question, could you please explain how binary search works? thanks!',
    ['binary search', 'works']);

preserved('multi-clause instruction kept',
    'hi there, please write a python function that reads a csv and returns a dict, thanks a lot',
    ['python', 'csv', 'dict']);

preserved('question word retained',
    'um, i was just wondering, why does my query run slowly?',
    ['why', 'query', 'slow']);

preserved('negation is never dropped',
    'please explain why this does not work, thanks',
    ['not work']);

preserved('numbers and quantities kept',
    'kindly give me 5 examples of recursion asap',
    ['5', 'examples', 'recursion']);

// ---------------------------------------------------------------------------
// 3. Junk removal -- noise must go
// ---------------------------------------------------------------------------

stripped('greetings and sign-offs',
    'Hello ChatGPT! Could you please explain closures? Thanks in advance!',
    ['hello', 'chatgpt', 'thanks', 'in advance', 'please']);

stripped('hedging and apology',
    'sorry if this is a dumb question but how do i reverse a string',
    ['sorry', 'dumb question']);

stripped('keyboard noise', 'asdfgh explain recursion', ['asdfgh']);

stripped('urgency padding', 'explain recursion asap it is urgent', ['asap', 'urgent']);

stripped('filler interjections',
    'um, uh, you know, i mean, how do i sort a list',
    ['um', 'uh', 'you know', 'i mean']);

stripped('meta commentary',
    'quick question, just to clarify, what is a promise',
    ['quick question', 'just to clarify']);

stripped('permission seeking',
    'is it possible to explain how hashing works',
    ['is it possible to']);

stripped('emoji spam', 'explain recursion 😅😅😅 thanks', ['😅']);

stripped('doubled intensifiers', 'this is very very slow, explain why', ['very very']);

stripped('gratitude tail', 'explain generics. much appreciated, cheers!',
    ['much appreciated', 'cheers']);

// ---------------------------------------------------------------------------
// 4. Structural invariants
// ---------------------------------------------------------------------------

const invariantCorpus = [
    'Hello ChatGPT, could you please write write a python script? thank you!',
    'plz help me to fix my funciton in js',
    'explain `useEffect` and https://react.dev/reference thanks',
    'um asdfgh sorry for the dumb question thanks in advance',
    'What is the capital of France?',
    '```py\nprint("hi")\n```',
    'a',
    'thanks',
    'please please please',
    'I am having an exam in AI help me to study',
    'set --flag and $VAR in C:\\tmp\\a.txt then run build_all() v1.2.3'
];

for (const prompt of invariantCorpus) {
    const once = PromptMeterOptimizer.optimizePrompt(prompt);
    const twice = PromptMeterOptimizer.optimizePrompt(once);

    record(`[stable] ${JSON.stringify(prompt.slice(0, 40))}`, once === twice,
        `pass 1: ${JSON.stringify(once)}\n      pass 2: ${JSON.stringify(twice)}`);

    record(`[non-empty] ${JSON.stringify(prompt.slice(0, 40))}`, once.trim().length > 0,
        `produced empty output`);

    const score = PromptMeterOptimizer.analyzePrompt(prompt).score;
    record(`[score-range] ${JSON.stringify(prompt.slice(0, 40))}`,
        Number.isInteger(score) && score >= 0 && score <= 100, `score was ${score}`);
}

// mask/unmask must be a perfect round trip for any input
for (const prompt of invariantCorpus) {
    const { masked, spans } = PromptMeterProtect.mask(prompt);
    record(`[mask-roundtrip] ${JSON.stringify(prompt.slice(0, 40))}`,
        PromptMeterProtect.unmask(masked, spans) === prompt, 'round trip changed the text');
}

// Code inside a fence must never be scored as the user's own padding
record('[score] pleasantries inside code are not penalised',
    PromptMeterOptimizer.analyzePrompt('```\nconst please = "thank you";\n```').score === 100,
    `scored ${PromptMeterOptimizer.analyzePrompt('```\nconst please = "thank you";\n```').score}`);

// ---------------------------------------------------------------------------
// 5. Long-prompt condensing
// ---------------------------------------------------------------------------

const words = (text) => text.split(/\s+/).filter(Boolean).length;

/** The optimized prompt must be at least `pct` percent shorter. */
const shrinks = (name, prompt, pct) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    const saved = (1 - words(out) / words(prompt)) * 100;
    record(`[shrinks] ${name}`, saved >= pct,
        `only ${saved.toFixed(1)}% shorter, wanted ${pct}%\n      got: ${JSON.stringify(out)}`);
};

const RAMBLE = 'So I have been working on this project for a while now and it is a web ' +
    'application that helps people track their expenses. The thing is, I have been ' +
    'struggling with the database design part of it. I am not really sure how to ' +
    'structure the tables properly. I have a users table and a transactions table but I ' +
    'am not sure if that is enough. I was thinking maybe I need a categories table as ' +
    'well. Could you help me design a proper database schema for an expense tracking ' +
    'application? I would really appreciate it if you could explain your reasoning as well.';

const REPEATS = 'I need you to write an essay. The essay should be about the impact of ' +
    'social media on society. It should be about 1000 words. The essay needs to have an ' +
    'introduction. The essay needs to have a body. The essay needs to have a conclusion. ' +
    'Make sure the essay is well written. Make sure the essay has good grammar.';

shrinks('rambling backstory is cut down', RAMBLE, 30);
shrinks('repetitive essay brief is cut down', REPEATS, 15);

preserved('the actual request survives condensing', RAMBLE,
    ['database schema', 'expense tracking']);
preserved('constraints survive condensing', REPEATS,
    ['1000 words', 'social media', 'introduction', 'conclusion']);

// Repeated sentence templates must collapse into one listed sentence
record('[condense] repeated templates merge',
    PromptMeterOptimizer.optimizePrompt(REPEATS).match(/needs to have/gi).length === 1,
    `got: ${JSON.stringify(PromptMeterOptimizer.optimizePrompt(REPEATS))}`);

// Short prompts must not be touched by sentence pruning
const SHORT = 'Explain how binary search works. Use a simple example.';
record('[condense] short prompts are left alone',
    PromptMeterCondense.condense(SHORT) === SHORT,
    `got: ${JSON.stringify(PromptMeterCondense.condense(SHORT))}`);

// A sentence holding protected content is never dropped, however uninformative
const WITHCODE = 'I have been messing about with this for hours and hours today. ' +
    '`const x = 1;` I have been messing about with this for hours and hours today. ' +
    'What does it do? I have been messing about with this for hours and hours today.';
verbatim('condensing never drops protected content', WITHCODE, ['`const x = 1;`']);

// Condensing must be stable
for (const prompt of [RAMBLE, REPEATS, SHORT]) {
    const once = PromptMeterOptimizer.optimizePrompt(prompt);
    record(`[condense-stable] ${JSON.stringify(prompt.slice(0, 30))}`,
        PromptMeterOptimizer.optimizePrompt(once) === once,
        `pass 2 differed:\n      1: ${JSON.stringify(once)}\n      2: ${JSON.stringify(PromptMeterOptimizer.optimizePrompt(once))}`);
}

// Grammar must not be broken by mid-clause stripping
stripped('leading request wrapper removed',
    'I am trying to build a website and I need help with the navbar', ['i am trying to']);
preserved('mid-clause grammar is not broken',
    'explain what I am trying to do here', ['what i am trying to do']);
preserved('question grammar survives',
    'What marketing strategies would you recommend for a candle business?',
    ['strategies would you recommend']);

// ---------------------------------------------------------------------------
// 6. Situational preambles -- the user's circumstances are not the request
// ---------------------------------------------------------------------------

/** The optimizer must produce exactly this string. */
const exact = (name, prompt, expected) => {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    record(`[exact] ${name}`, out === expected,
        `expected ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(out)}`);
};

exact('exam preamble with no punctuation at all',
    'hey I have an exam tomorrow teach me ML', 'Teach me ML');

exact('exam preamble, continuous tense',
    'hey i am having exam tomorrow teach me ML', 'Teach me ML');

exact('preamble plus request wrapper',
    'hi there, I have an exam tomorrow so can you teach me machine learning',
    'Teach me machine learning');

exact('stacked preambles collapse to the instruction',
    'hello, I am stressed, my viva is tomorrow, and I did not study, ' +
    'explain the OSI model please, thanks!',
    'Explain the OSI model');

// Each category of circumstance, checked by what must disappear and what must remain.
stripped('upcoming event', 'my finals are next week, summarize thermodynamics',
    ['finals', 'next week']);
preserved('...but its subject stays', 'my finals are next week, summarize thermodynamics',
    ['summarize', 'thermodynamics']);

stripped('deadline countdown', 'I only have 2 days left, explain graph traversal',
    ['2 days', 'left']);

stripped('emotional state', 'I am panicking, explain dynamic programming',
    ['panicking']);

stripped('who assigned the work',
    'my professor gave us an assignment and I dont understand it, explain recursion',
    ['professor', 'assignment']);

stripped('where the user saw it', 'I saw a video about docker, explain containers',
    ['saw a video']);

stripped('academic year and institution',
    'im in 3rd year college and my semester exams are coming up, teach me operating systems',
    ['3rd year', 'semester exams']);

stripped('non-preparation excuse',
    'I have not studied anything, give me a revision plan for calculus',
    ['not studied']);

stripped('missed class excuse', 'I missed the lecture yesterday, explain pointers in C',
    ['missed the lecture']);

stripped('search narrative', 'I googled it but did not understand, what is a closure?',
    ['googled', 'did not understand']);

stripped('waking narrative',
    'good morning! I woke up late today and I have an interview tomorrow, ' +
    'help me prepare for system design',
    ['woke up', 'interview tomorrow']);

stripped('learning-duration autobiography',
    'I have been learning python for 2 months, teach me decorators',
    ['2 months', 'been learning']);

preserved('the subject of the request always survives',
    'I am stressed because my viva is tomorrow, explain the OSI model',
    ['osi model']);

preserved('an answer-shaping clause is not circumstance',
    'I am a beginner, explain recursion', ['beginner', 'recursion']);

// --- The two guards -------------------------------------------------------

untouched('circumstance with no request is the whole message',
    'I have an exam tomorrow');

record('[situational] a request with no subject of its own is not stripped',
    PromptMeterOptimizer.optimizePrompt('I am having an exam in AI help me to study')
        .toLowerCase().includes('ai'),
    `got: ${JSON.stringify(PromptMeterOptimizer.optimizePrompt('I am having an exam in AI help me to study'))}`);

untouched('the same words inside a question are not a preamble',
    'Explain what happens when I have an exam and the server crashes');

preserved('a subordinate clause is not stripped for its connective',
    'explain why the deadline is tonight in this scheduler',
    ['deadline', 'scheduler']);

verbatim('a preamble holding protected content is never dropped',
    'I have an exam tomorrow on `Array.prototype.reduce`, explain it',
    ['`Array.prototype.reduce`']);

// --- Stated intent becomes a command, not a stranded verb ------------------

exact('"I want to know about X" is not left as "Know about X"',
    'I want to know about the difference between supervised and unsupervised learning',
    'Explain the difference between supervised and unsupervised learning');

exact('the wh-word after a stated intent survives',
    'I would like to know how neural networks work',
    'Explain how neural networks work');

stripped('wordy relative clause', 'write a program that can be used to sort a list',
    ['can be used']);
preserved('...without losing the purpose', 'write a program that can be used to sort a list',
    ['to sort a list']);

// --- Trailing purpose ------------------------------------------------------

stripped('trailing occasion is dropped',
    'what are the things that I should know about operating systems for my exam',
    ['for my exam']);
preserved('...but the subject is kept',
    'what are the things that I should know about operating systems for my exam',
    ['operating systems']);

exact('a trailing occasion that is the only subject stays',
    'write a study plan for my exam', 'Write a study plan for my exam');

// Stripping must be idempotent and must never empty the prompt
const situationalCorpus = [
    'hey I have an exam tomorrow teach me ML',
    'my exam is tomorrow, explain neural networks',
    'I am stressed, my viva is tomorrow, teach me the OSI model',
    'I have an exam tomorrow',
    'I am a beginner, explain recursion',
    'I missed class, my professor gave us homework, and I have 2 days left, help me',
    'I am having an exam in AI help me to study'
];

for (const prompt of situationalCorpus) {
    const once = PromptMeterOptimizer.optimizePrompt(prompt);
    record(`[situational-stable] ${JSON.stringify(prompt.slice(0, 40))}`,
        PromptMeterOptimizer.optimizePrompt(once) === once,
        `pass 1: ${JSON.stringify(once)}\n      pass 2: ${JSON.stringify(PromptMeterOptimizer.optimizePrompt(once))}`);

    record(`[situational-non-empty] ${JSON.stringify(prompt.slice(0, 40))}`,
        once.trim().length > 0, 'produced empty output');
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
    failures.forEach((f, i) => console.log(`  ${i + 1}. FAIL ${f}\n`));
    process.exit(1);
}
console.log('All optimizer checks passed.');
