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
const { PromptMeterML } = require('../utils/ml-classifier.js');

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

// --- Negation parity: meaning must never invert ----------------------------
//
// The strongest statement of "optimization does not change meaning": a prompt and its
// negated twin must never optimize to the same text. If they ever collide, some rule
// has swallowed the word that distinguished them.

const negationPairs = [
    ['i had a good day', 'i had a not good day'],
    ['please explain why this works', 'please explain why this does not work'],
    ['hey can you write a summary that is long', 'hey can you write a summary that is not long'],
    ['tell me what is working in this code', 'tell me what is not working in this code'],
    ['should I use var in javascript?', 'should I not use var in javascript?'],
    ['explain why this is a good idea', 'explain why this is not a good idea'],
    ['make sure it is case sensitive', 'make sure it is not case sensitive'],
    ['use recursion for this solution please', 'do not use recursion for this solution please'],
    ['I had a good day, teach me ML', 'I had a bad day, teach me ML']
];

for (const [positive, negative] of negationPairs) {
    const a = PromptMeterOptimizer.optimizePrompt(positive).toLowerCase();
    const b = PromptMeterOptimizer.optimizePrompt(negative).toLowerCase();
    record(`[negation] ${JSON.stringify(negative.slice(0, 42))}`, a !== b,
        `both collapsed to ${JSON.stringify(a)}`);
}

// A negation word may never be dropped outright, whatever else is stripped around it
const NEGATORS = /\b(not|never|without|except|unless|don't|no)\b/gi;
const negationCorpus = [
    'give me a detailed but not too long explanation of recursion',
    'summarize this without using any jargon',
    'explain everything except the math part',
    'do not include code examples, just explain the concept',
    'unless it is impossible, use only standard library functions',
    'never use recursion here please, thanks!',
    'explain why my code does not compile',
    'this is not working, please help me fix it',
    'hey chatgpt, please do not use jargon, thanks so much!'
];

for (const prompt of negationCorpus) {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    const before = (prompt.match(NEGATORS) || []).length;
    const after = (out.match(NEGATORS) || []).length;
    record(`[negation-kept] ${JSON.stringify(prompt.slice(0, 42))}`, after >= before,
        `${before} negation words in, ${after} out\n      got: ${JSON.stringify(out)}`);
}

// --- End-to-end showcase: every category at once ---------------------------

exact('a padded one-liner reduces to its instruction',
    'hey chatgpt!! i have an exam tomorrow and im really stressed, ' +
    'could you please kindly teach me machine learning? thanks so much!!',
    'Teach me machine learning.');

const KITCHEN_SINK =
    'Hello ChatGPT, good morning! I hope you are doing well today. So basically, I am in ' +
    '3rd year college and my semester exams are coming up next week, and I have not studied ' +
    'anything at all. I am really really stressed and I only have 2 days left. My professor ' +
    'gave us a huge syllabus and I honestly do not understand any of it. I was wondering if ' +
    'you could please kindly give me a detailed and comprehensive and thorough explanation ' +
    'of operating systems for my exam? Sorry if this is a dumb question. Thanks a lot in ' +
    'advance, I would really appreciate it!!! 😅😅😅';

exact('a wall of preamble reduces to its instruction',
    KITCHEN_SINK, 'Give me a detailed explanation of operating systems.');

// Removing a clause must not leave a word behind as its own sentence
stripped('no stranded fragments survive the removals', KITCHEN_SINK,
    ['in advance', 'any of it', 'basically', 'sorry', 'dumb question', '😅']);

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
// 7. Machine-learning assist
// ---------------------------------------------------------------------------
//
// The contract this section pins down: the classifier may only REFINE a rule
// decision. With the model switched off the optimizer must behave exactly as the
// rule-based tests above expect -- which is why those tests carry no ML setup.

record('[ml] a trained model is loaded', PromptMeterML.isAvailable(),
    'ml-classifier could not find ml-model.js -- run: cd ml && python train.py');

if (PromptMeterML.isAvailable()) {
    // Sanity: the four classes behave as labeled on clear-cut examples
    const expectations = [
        ['Explain how binary search works with an example', 'IMPORTANT'],
        ['Write a python function that reverses a linked list', 'IMPORTANT'],
        ['Hello ChatGPT I hope you are doing well today', 'FILLER'],
        ['I have an exam tomorrow and I am really stressed', 'FILLER'],
        ['I would like you to please go ahead and', 'REDUNDANT'],
        ['The report must include the data and the report must include the charts', 'REPETITIVE']
    ];

    for (const [text, expected] of expectations) {
        const advice = PromptMeterML.advise(text);
        record(`[ml] classifies ${JSON.stringify(text.slice(0, 38))}`,
            advice !== null && advice.label === expected,
            `expected ${expected}, got ${advice ? advice.label : 'ABSTAIN'}`);
    }

    // Abstention: no recognised vocabulary means no opinion, never a guess
    record('[ml] abstains on unknown vocabulary',
        PromptMeterML.advise('zzz qqq xkcd') === null,
        'model returned a label for text it has no evidence about');

    record('[ml] abstains on empty input',
        PromptMeterML.advise('') === null, 'model did not abstain on empty text');

    // keep and removable must partition the probability mass
    const partition = PromptMeterML.advise('Explain how binary search works');
    record('[ml] keep and removable sum to 1',
        partition !== null && Math.abs((partition.keep + partition.removable) - 1) < 1e-9,
        `got ${partition ? partition.keep + partition.removable : 'null'}`);

    // --- The assist changes real outcomes ---------------------------------
    //
    // Both middle sentences are backstory, but each introduces several words the
    // rest of the prompt never uses. The vocabulary rule alone therefore keeps
    // them; the classifier is what identifies them as filler.
    const MIXED =
        'Write a python script that parses server logs and extracts error codes. ' +
        'I have been revising all night for tomorrow morning viva examination honestly. ' +
        'The output should be a csv file sorted by timestamp. ' +
        'My hostel roommate kept playing loud music throughout the entire evening yesterday. ' +
        'Handle malformed lines without crashing the whole program.';

    const withMl = PromptMeterOptimizer.optimizePrompt(MIXED);

    // Disable the assist by making both thresholds unreachable, then restore.
    const savedVeto = PromptMeterCondense.ML_KEEP_VETO;
    const savedPropose = PromptMeterCondense.ML_DROP_PROPOSE;
    PromptMeterCondense.ML_KEEP_VETO = 2;
    PromptMeterCondense.ML_DROP_PROPOSE = 2;
    const rulesOnly = PromptMeterOptimizer.optimizePrompt(MIXED);
    PromptMeterCondense.ML_KEEP_VETO = savedVeto;
    PromptMeterCondense.ML_DROP_PROPOSE = savedPropose;

    record('[ml] the assist changes the outcome at all', withMl !== rulesOnly,
        'ML made no difference -- it is not wired in');

    // Which of the two backstory sentences clears ML_DROP_PROPOSE depends on the fitted
    // model: both are removable, but their confidences sit either side of the threshold
    // and move whenever the model is retrained. The behaviour under test is that the
    // classifier removes backstory the vocabulary rule would keep -- so the assertion is
    // on that behaviour, not on which sentence happens to win. Asserting both would make
    // the suite a hostage to the threshold, and the temptation on a red test would be to
    // lower it, which is exactly the wrong move: PROPOSE deletes the user's own words.
    const backstory = ['roommate', 'revising'];
    const droppedByMl = backstory.filter(word => !withMl.toLowerCase().includes(word));
    const keptByRules = backstory.filter(word => rulesOnly.toLowerCase().includes(word));

    record('[ml] backstory the vocabulary rule kept is dropped',
        droppedByMl.length > 0,
        `the assist dropped neither backstory sentence; got: ${JSON.stringify(withMl)}`);

    record('[ml] rules alone would have kept that backstory',
        keptByRules.length === backstory.length,
        `the rules already dropped ${JSON.stringify(backstory.filter(w => !keptByRules.includes(w)))}, ` +
        'so that case proves nothing about the ML');

    // The instruction and every constraint must survive the assist
    for (const fragment of ['python script', 'error codes', 'csv file', 'malformed lines']) {
        record(`[ml] instruction survives the assist: ${JSON.stringify(fragment)}`,
            withMl.toLowerCase().includes(fragment),
            `got: ${JSON.stringify(withMl)}`);
    }

    // Switching the assist off must leave the rule-based behaviour untouched.
    // This is the regression that matters: ship a bad model, lose nothing.
    PromptMeterCondense.ML_KEEP_VETO = 2;
    PromptMeterCondense.ML_DROP_PROPOSE = 2;
    for (const prompt of ['hey I have an exam tomorrow teach me ML',
                          'Hello ChatGPT! Could you please explain closures? Thanks in advance!',
                          'I have an exam tomorrow']) {
        const off = PromptMeterOptimizer.optimizePrompt(prompt);
        PromptMeterCondense.ML_KEEP_VETO = savedVeto;
        PromptMeterCondense.ML_DROP_PROPOSE = savedPropose;
        const on = PromptMeterOptimizer.optimizePrompt(prompt);
        PromptMeterCondense.ML_KEEP_VETO = 2;
        PromptMeterCondense.ML_DROP_PROPOSE = 2;

        record(`[ml] short prompts are unaffected either way: ${JSON.stringify(prompt.slice(0, 34))}`,
            off === on, `off: ${JSON.stringify(off)}\n      on:  ${JSON.stringify(on)}`);
    }
    PromptMeterCondense.ML_KEEP_VETO = savedVeto;
    PromptMeterCondense.ML_DROP_PROPOSE = savedPropose;
}

// ---------------------------------------------------------------------------
// 7. Regressions found on an over-scoped enterprise prompt
// ---------------------------------------------------------------------------

// An ordinary English sentence starting with a SQL verb is not SQL. The code detector
// matched /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+[A-Z*\s]/i case-insensitively,
// so "Create an education platform" was classified as code -- and optimizePrompt returns
// the input untouched for code, meaning these prompts were silently never optimized.
for (const prose of [
    'Create an education platform that manages students',
    'Create a React component for the login page',
    'Update the README to mention the new flag',
    'Delete the old migration files please',
    'Insert a caching layer in front of the API',
    'Drop a note in the changelog',
    'Alter the schedule so it runs nightly',
    'Select a database for this workload',
]) {
    record(`[code] prose is not SQL: ${JSON.stringify(prose.slice(0, 34))}`,
        !PromptMeterOptimizer.isCodeSnippet(prose), 'classified as code');
}

// Real SQL must still be protected.
for (const sql of [
    'SELECT * FROM users WHERE id = 1',
    'select name, email from customers order by name',
    'INSERT INTO orders (id, total) VALUES (1, 20)',
    'UPDATE users SET active = 0 WHERE id = 3',
    'DELETE FROM sessions WHERE expired = 1',
    'CREATE TABLE users (id INT PRIMARY KEY)',
    'DROP TABLE archive',
    'ALTER TABLE users ADD COLUMN age INT',
]) {
    record(`[code] SQL is still code: ${JSON.stringify(sql.slice(0, 34))}`,
        PromptMeterOptimizer.isCodeSnippet(sql), 'not classified as code');
}

// Juxtaposed synonyms, which the conjoined adjectiveStacks rules step over. The adjective
// nearest the noun is the informative one and survives.
exact('juxtaposed synonym stack keeps the specific adjective',
    'provide complete production-ready code', 'Provide production-ready code');

// Scope analysis. A prompt with no filler at all can still be wasteful, and reporting
// 100/100 for a request covering forty subsystems would be telling the user something
// false.
const OVERSCOPED =
    'Create an AI-powered education platform that manages students, teachers, courses, ' +
    'attendance, examinations, assignments, payments, notifications, dashboards, ' +
    'recommendations, chatbots, analytics, certificates, authentication, authorization, ' +
    'reports, AI tutoring, plagiarism detection, facial recognition, speech recognition, ' +
    'translation, sentiment analysis, predictive analytics, personalized learning, cloud ' +
    'deployment, mobile applications, web applications, APIs, databases, cybersecurity, ' +
    'backups, monitoring, logging, scalability, accessibility, multilingual support, ' +
    'offline functionality, real-time synchronization, and administrative controls. ' +
    'Explain every feature, database table, API endpoint, algorithm, UI screen, workflow, ' +
    'security mechanism, deployment step, testing strategy, scalability consideration, ' +
    'and possible failure case in detail and provide complete production-ready code for ' +
    'the frontend, backend, database, AI models, APIs, authentication, deployment ' +
    'configuration, and testing.';

const scoped = PromptMeterOptimizer.analyzePrompt(OVERSCOPED);
record('[scope] an over-scoped prompt no longer scores 100',
    scoped.score < 100, `scored ${scoped.score}`);
record('[scope] the flag names the problem',
    scoped.flags.some(flag => /over-scoped/i.test(flag)),
    `got ${JSON.stringify(scoped.flags)}`);
record('[scope] optimizeWithReport carries scope advice',
    PromptMeterOptimizer.optimizeWithReport(OVERSCOPED).scope.length > 0,
    'no scope findings reported');

// The enumeration is the request. Nothing in it may be dropped -- the three items that
// appear in both lists ("database", "APIs", "authentication") name a FEATURE in one and a
// CODE LAYER in the other, so deduplicating them would delete the database layer from the
// code request.
preserved('[scope] the enumeration survives intact', OVERSCOPED,
    ['students', 'teachers', 'administrative controls', 'every feature',
     'frontend', 'backend', 'database', 'APIs', 'authentication', 'testing']);

// A normal prompt must not be flagged as over-scoped.
for (const normal of [
    'Explain how binary search works with an example',
    'Write a Python script that reads a CSV and returns a dictionary',
    'Compare supervised and unsupervised learning, with three examples of each',
]) {
    record(`[scope] normal prompt is not flagged: ${JSON.stringify(normal.slice(0, 34))}`,
        PromptMeterOptimizer.scopeIssues(normal).length === 0,
        `got ${JSON.stringify(PromptMeterOptimizer.scopeIssues(normal))}`);
}


// ---------------------------------------------------------------------------
// 8b. SMS and chat abbreviations
// ---------------------------------------------------------------------------

// Expanding these is what lets every later stage work. The situational rules in
// condense.js are written against real English, so "tmrw is mi exm" matches none of
// them until the abbreviations become words.
exact('an abbreviated preamble reduces to its instruction',
    'hey tmrw is mi exm teach me ML', 'Teach me ML');

exact('the same prompt spelled out behaves identically',
    'hey tomorrow is my exam teach me ML', 'Teach me ML');

for (const [abbreviated, word] of [
    ['tmrw', 'tomorrow'], ['tmr', 'tomorrow'], ['exm', 'exam'], ['xam', 'exam'],
    ['coz', 'because'], ['bcz', 'because'], ['wat', 'what'], ['wen', 'when'],
    ['abt', 'about'], ['ppl', 'people'], ['prof', 'professor'], ['thnx', 'thanks'],
    ]) {
    // "explain abt X" legitimately collapses to "explain X" via the frame fix, so the
    // carrier sentence keeps the expanded word out of object position. "thnx" is
    // stripped as gratitude rather than expanded, which is the desired outcome, so it
    // is checked for removal instead.
    const out = PromptMeterOptimizer.optimizePrompt(`write a note ${abbreviated} and stop`).toLowerCase();
    record(`[abbrev] ${JSON.stringify(abbreviated)} expands to ${JSON.stringify(word)}`,
        word === 'thanks' ? !out.includes('thnx') : out.includes(word),
        `got: ${JSON.stringify(out)}`);
}

// "mi" is both "me" and "my". A possessive cannot precede a determiner, and a verb
// that takes an indirect object forces the object reading.
preserved('mi before a noun is the possessive', 'mi exam is tomorrow teach me ML', ['ml']);
exact('mi after a ditransitive verb is the object', 'plz send mi the code', 'Send me the code');
exact('mi before a determiner is the object', 'show mi an example', 'Show me an example');

// The short forms must never touch technical text. Each of these is a prompt where the
// letter is a variable, a unit or a language name, and a blanket expansion would
// silently corrupt the question.
for (const technical of [
    'Solve for u where u = v + a*t',
    'Plot y = mx + b and explain the slope',
    'Given r = 5, find the area of the circle',
    'Explain how R handles vectors',
    'What does the U matrix mean in SVD',
    'Set mi = 0 in the loop',
    'Explain the y axis label',
    'Rename u to velocity in this function',
    'The route is 20 mi long',
]) {
    const out = PromptMeterOptimizer.optimizePrompt(technical);
    const introduced = ['you', 'your', 'yours', 'are', 'why', 'my', 'me'].filter(expansion => {
        const rx = new RegExp(`\b${expansion}\b`, 'i');
        return rx.test(out) && !rx.test(technical);
    });
    record(`[abbrev] technical text is untouched: ${JSON.stringify(technical.slice(0, 32))}`,
        introduced.length === 0,
        `introduced ${JSON.stringify(introduced)}
      got: ${JSON.stringify(out)}`);
}

// Both word orders of the same announcement must go.
for (const order of [
    'tomorrow is my exam teach me ML',
    'my exam is tomorrow teach me ML',
    'i have an exam tomorrow teach me ML',
]) {
    record(`[situational] ${JSON.stringify(order)}`,
        PromptMeterOptimizer.optimizePrompt(order).toLowerCase().replace(/[^a-z ]/g, '').trim() === 'teach me ml',
        `got: ${JSON.stringify(PromptMeterOptimizer.optimizePrompt(order))}`);
}

// ---------------------------------------------------------------------------
// 9. Regressions
// ---------------------------------------------------------------------------

// A problem statement asks for nothing and constrains nothing, so the rules read it as
// non-core and offered it to the classifier -- which, reading the "I have a doubt ... I
// don't know why" frame around it, called it removable at 0.95. The result deleted the
// user's actual question and kept "help me". A sentence reporting a malfunction is core
// and must never reach the model.
preserved('a problem statement is never dropped as backstory',
    "hii chatgpt!! i has a doubt, the codes doesnt works properly and i dont knows why. " +
    "plz help me asap!! thanks a lot in advance",
    ["doesn't work", "know why"]);

for (const symptom of [
    'Summarize this. The build fails with an out of memory error after ten minutes.',
    'Explain this. The query returns duplicate rows when I add the join.',
    'Fix this. The component crashes on an empty response.',
    'Help. The request times out but only in production.',
]) {
    const out = PromptMeterOptimizer.optimizePrompt(symptom).toLowerCase();
    record(`[preserved] symptom survives: ${JSON.stringify(symptom.slice(0, 30))}`,
        /fail|duplicate|crash|times? out/.test(out),
        `got: ${JSON.stringify(out)}`);
}

// Hedged request wrappers: the whole hedge goes, and none of it is left stranded in
// front of the instruction.
stripped('tentative wrappers and their hedges are removed together',
    'so basically i was thinking maybe you could possibly help me understand how the ' +
    'internet actually works at a technical level',
    ['basically', 'i was thinking', 'maybe', 'possibly']);

preserved('the instruction under a hedged wrapper survives',
    'so basically i was thinking maybe you could possibly help me understand how the ' +
    'internet actually works at a technical level',
    ['understand how the internet', 'technical level']);

stripped('a hedge left at a clause start is cleared',
    'I was wondering if you could maybe explain recursion',
    ['maybe', 'wondering']);

// "so" and "just" carry meaning of their own and must survive; only the
// discourse-marker reading of "so", in front of another marker, is removable.
preserved('meaningful so and just are kept',
    'Compile it so that it links, and just include the headers.',
    ['so that it links', 'just include the headers']);

// Grammar is reported, not merely applied.
const report = PromptMeterOptimizer.optimizeWithReport('i has a question and it should has 500 words');
record('[report] optimizeWithReport returns grammar findings',
    report.grammar.length > 0 && typeof report.text === 'string',
    `got ${JSON.stringify(report)}`);
record('[report] grammar findings carry a type and a label',
    report.grammar.every(issue => typeof issue.type === 'string' && typeof issue.label === 'string'),
    `got ${JSON.stringify(report.grammar)}`);

const dirty = PromptMeterOptimizer.analyzePrompt('i has a question and he go home');
record('[report] analyzePrompt flags grammatical errors',
    dirty.flags.some(flag => /grammatical/i.test(flag)),
    `got ${JSON.stringify(dirty.flags)}`);
record('[report] a correct prompt raises no grammar flag',
    !PromptMeterOptimizer.analyzePrompt('Explain how binary search works.').flags
        .some(flag => /grammatical/i.test(flag)),
    'a correct prompt was flagged for grammar');

// ---------------------------------------------------------------------------
// 10. Never lengthen, never expand a universally-understood acronym
// ---------------------------------------------------------------------------

// The acronym table case-normalises and must never expand. It previously turned "dsa"
// into "Data Structures & Algorithms" (+5 tokens), "js" into "JavaScript" (+2) and "db"
// into "database" (+1) -- a tool whose purpose is cutting tokens inflating them instead.
const lengthening = Object.entries(PromptMeterOptimizer.techAcronymMap)
    .filter(([key, value]) => value.length > key.length);
record('[acronym] no entry is longer than its key', lengthening.length === 0,
    `these lengthen: ${JSON.stringify(lengthening)}`);

for (const [prompt, expected] of [
    ['explain dsa to me', 'DSA'],
    ['what is the db schema', 'DB'],
    ['explain ml and ai', 'ML'],
    ['teach me js basics', 'JS'],
]) {
    const out = PromptMeterOptimizer.optimizePrompt(prompt);
    record(`[acronym] ${JSON.stringify(prompt)} stays short`,
        out.includes(expected) && out.length <= prompt.length + 2,
        `got ${JSON.stringify(out)}`);
}

// ---------------------------------------------------------------------------
// 11. Rephrasing: many words to one, meaning unchanged
// ---------------------------------------------------------------------------

// A sweep of common wordy constructions previously matched exactly one of these.
for (const wordy of [
    'give me a brief overview of', 'make a comparison between', 'carry out an analysis of',
    'on a daily basis', 'in the near future', 'at the present time',
    'in spite of the fact that', 'it is possible that', 'has the ability to',
    'in a timely manner', 'with the exception of', 'in close proximity to',
    'during the course of', 'for the reason that', 'come to a conclusion',
    'give consideration to', 'put emphasis on', 'at all times', 'make use of',
    'in relation to', 'the majority of', 'subsequent to', 'in the absence of',
]) {
    const out = PromptMeterOptimizer.optimizePrompt(`please ${wordy} the results`).toLowerCase();
    record(`[concise] ${JSON.stringify(wordy)} is shortened`,
        !out.includes(wordy), `got ${JSON.stringify(out)}`);
}

// ---------------------------------------------------------------------------
// 12. Unfenced code: masked, not bailed on, and never re-indented
// ---------------------------------------------------------------------------

// A two-space-indented snippet with no fence defeated the whole pipeline: the
// indented-code pattern needs four spaces, so nothing was masked, isCodeSnippet() then
// read the WHOLE prompt as code, and optimizePrompt returned it untouched -- leaving
// "review this code" and "thanks a lot" in place.
const UNFENCED = 'review this code plz\nfunction f() {\n  if (a) {\n    return 1;\n  }\n}\nthanks a lot';
const unfencedOut = PromptMeterOptimizer.optimizePrompt(UNFENCED);

record('[code] filler around an unfenced snippet is stripped',
    !/plz|thanks a lot/i.test(unfencedOut), `got ${JSON.stringify(unfencedOut)}`);
verbatim('unfenced code keeps its exact indentation', UNFENCED,
    ['function f() {\n  if (a) {\n    return 1;\n  }\n}']);
record('[code] a block is not welded onto the prose line',
    /\n\s*function f\(\) \{/.test(unfencedOut), `got ${JSON.stringify(unfencedOut)}`);

// Every indentation style must survive byte for byte.
for (const [name, prompt, block] of [
    ['4-space python', 'fix this plz\n\n    def foo():\n        return 42\n\nthanks',
        '    def foo():\n        return 42'],
    ['tab-indented', 'fix this plz\n\n\tdef foo():\n\t\treturn 42\n\nthanks',
        '\tdef foo():\n\t\treturn 42'],
    ['2-space python', 'check this thanks\ndef foo(x):\n  if x:\n    return 1\n  return 0\nthx',
        'def foo(x):\n  if x:\n    return 1\n  return 0'],
    ['yaml nesting', 'validate this\n```yaml\nservices:\n  web:\n    ports:\n      - 8080\n```',
        'services:\n  web:\n    ports:\n      - 8080'],
]) {
    verbatim(`indentation preserved: ${name}`, prompt, [block]);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
    failures.forEach((f, i) => console.log(`  ${i + 1}. FAIL ${f}\n`));
    process.exit(1);
}
console.log('All optimizer checks passed.');
