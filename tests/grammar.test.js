/**
 * PromptMeter grammar engine regression suite.
 *
 * Dependency-free. Run with:  node tests/grammar.test.js
 *
 * Two properties, and the second matters more than the first:
 *
 *   1. CORRECTS    a real error is found and repaired, and reported as an issue.
 *   2. DECLINES    correct English is returned byte for byte, with no issue raised.
 *
 * (2) is the harder property and the one that makes the engine safe to run on every
 * keystroke. Almost every rule here has a legitimate reading that looks identical to the
 * error it targets -- "a bug that affects users" against "the affect was bad", "all it
 * does is print" against "doesn't works", "send it to many people" against "to much
 * work". A rule that fires on those does not merely miss a correction, it corrupts text
 * the user wrote on purpose. Each DECLINES case below is one of those readings, and a
 * failure there is a correctness bug, not a coverage gap.
 */
const { PromptMeterGrammar } = require('../utils/grammar.js');

let passed = 0;
const failures = [];

const record = (name, ok, detail) => {
    if (ok) { passed++; return; }
    failures.push(`${name}\n      ${detail}`);
};

/** The text must be rewritten exactly as expected, and must report an issue. */
const corrects = (name, input, expected) => {
    const result = PromptMeterGrammar.correct(input, { punctuation: false });
    record(`[corrects] ${name}`,
        result.text === expected && result.issues.length > 0,
        `got      ${JSON.stringify(result.text)}\n      expected ${JSON.stringify(expected)}` +
        `\n      issues: ${JSON.stringify(result.issues.map(i => i.type))}`);
};

/** The text is already correct: it must come back untouched, with nothing reported. */
const declines = (name, input) => {
    const result = PromptMeterGrammar.correct(input, { punctuation: false });
    record(`[declines] ${name}`,
        result.text === input && result.issues.length === 0,
        `changed to ${JSON.stringify(result.text)}` +
        `\n      issues: ${JSON.stringify(result.issues.map(i => `${i.type}: ${i.label}`))}`);
};

/** The issue list must contain at least one issue of this type. */
const reports = (name, input, type) => {
    const issues = PromptMeterGrammar.check(input);
    record(`[reports] ${name}`,
        issues.some(issue => issue.type === type),
        `no "${type}" issue; got ${JSON.stringify(issues.map(i => i.type))}`);
};

// ---------------------------------------------------------------------------
// 1. Subject-verb agreement
// ---------------------------------------------------------------------------

corrects('plural subject with singular verb', 'I has a question', 'I have a question');
corrects('they + has', 'They has the answer', 'They have the answer');
corrects('we + is', 'We is ready', 'We are ready');
corrects('I + are becomes am', 'I are confused', 'I am confused');
corrects('singular subject with plural verb', 'He have the file', 'He has the file');
corrects('it + are', 'It are broken', 'It is broken');
corrects('bare verb after he', 'He go to the office', 'He goes to the office');
corrects('bare verb after she', 'She work on the parser', 'She works on the parser');
corrects('inflected verb after they', 'They writes the tests', 'They write the tests');

declines('correct plural agreement', 'They have the answer');
declines('correct singular agreement', 'He has the file');
declines('past tense is not an agreement error', 'I was wondering about the schema');
declines('we were is correct', 'We were testing the parser');
declines('noun after determiner is not a verb', 'The works of Shakespeare are long');
declines('read is ambiguous between tenses', 'She read the book yesterday');

// ---------------------------------------------------------------------------
// 2. Auxiliary and modal verb forms
// ---------------------------------------------------------------------------

corrects('modal takes a bare verb', 'It should has 500 words', 'It should have 500 words');
corrects('infinitive takes a bare verb', 'I need you to writes an essay',
    'I need you to write an essay');
corrects('do-support takes a bare verb', "It doesn't works", "It doesn't work");
// The sentence-capitalization pass runs on every correction, so the expected text
// carries it too.
corrects('do-support across a subject', 'how does machine learning works',
    'How does machine learning work');

declines('pseudo-cleft keeps its be-verb', 'All it does is print the value');
declines('correct modal usage', 'It should have 500 words');
declines('to as a preposition is untouched', 'Send the report to the store manager');

// ---------------------------------------------------------------------------
// 3. Confusable words
// ---------------------------------------------------------------------------

corrects('there before a possessed noun', 'Get there books', 'Get their books');
corrects('their before a copula', 'Their is a problem', 'There is a problem');
corrects('its before an article', 'Its a problem', "It's a problem");
corrects('your before going', 'Your going to fail', "You're going to fail");
corrects('then after a comparative', 'This is faster then that', 'This is faster than that');
corrects('to before much', 'This is to much work', 'This is too much work');
corrects('affect as a noun', 'The affect was bad', 'The effect was bad');
corrects('should of', 'I should of known', 'I should have known');

declines('affects as a verb in a relative clause', 'A bug that affects users');
declines('than in a comparison with a clause', 'This is better than I can manage');
declines('to before a plural noun phrase', 'Send the file to many people');
declines('to before an adjective and noun', 'Apply it to complex systems');
declines('its as a genuine possessive', 'The function and its return value');
declines('your as a genuine possessive', 'Your answer was helpful');
declines('your right hand stays possessive', 'Raise your right hand');

// ---------------------------------------------------------------------------
// 4. Noun forms and articles
// ---------------------------------------------------------------------------

corrects('uncountable pluralised', 'The datas is wrong', 'The data is wrong');
corrects('informations', 'Check the informations', 'Check the information');
corrects('irregular plural regularised', 'The childs are here', 'The children are here');
corrects('a before a vowel', 'Write a essay', 'Write an essay');
corrects('an before a consonant', 'Write an report', 'Write a report');

declines('a before a consonant', 'Write a report');
declines('an before a vowel', 'Write an essay');
declines('a user keeps its article', 'Add a user to the group');
declines('an hour keeps its article', 'It takes an hour to run');
declines('information as a compound modifier', 'An information system with a feedback loop');
declines('data is is standard usage', 'The data is consistent');

// ---------------------------------------------------------------------------
// 5. Pronoun case and compound subjects
// ---------------------------------------------------------------------------

corrects('object pronouns in subject position',
    'Me and him was talking', 'He and I were talking');
corrects('me and her as a subject', 'Me and her are working', 'She and I are working');

declines('object pronouns in object position', 'The manager told him and me the news');
declines('coordinated clauses are not a compound subject',
    'Explain how it works and what is the difference');

// ---------------------------------------------------------------------------
// 6. Phrasing, redundancy and double negatives
// ---------------------------------------------------------------------------

corrects('explain me about', 'Explain me about recursion', 'Explain recursion');
corrects('discuss about', 'Discuss about the results', 'Discuss the results');
corrects('double comparative', 'This is more better', 'This is better');
corrects('double negative', "I don't have no time", "I don't have any time");
corrects('return back', 'Return back the value', 'Return the value');

declines('explain with a direct object', 'Explain recursion with an example');
declines('about after a noun is fine', 'Write an article about recursion');

// ---------------------------------------------------------------------------
// 7. Contractions
// ---------------------------------------------------------------------------

corrects('missing apostrophe', 'I dont know', "I don't know");
corrects('doesnt', 'It doesnt matter', "It doesn't matter");

declines('were is a real word, not we are', 'They were testing the parser');
declines('lets is a real verb', 'The config lets you override the port');
declines('ill is a real word', 'He was ill last week');
declines('correct contraction is untouched', "I don't know");

// ---------------------------------------------------------------------------
// 8. Tense
// ---------------------------------------------------------------------------

corrects('past marker forces past tense',
    'Yesterday he go to the store', 'Yesterday he went to the store');

declines('present tense without a past marker', 'He goes to the store');
declines('past marker with correct tense', 'Yesterday he went to the store');

// ---------------------------------------------------------------------------
// 9. Protected spans are opaque
// ---------------------------------------------------------------------------

const MASK_OPEN = '';
const MASK_CLOSE = '';
const masked = `Fix ${MASK_OPEN}0${MASK_CLOSE} because it dont work`;
const maskedResult = PromptMeterGrammar.correct(masked, { punctuation: false });
record('[verbatim] placeholders survive untouched',
    maskedResult.text.includes(`${MASK_OPEN}0${MASK_CLOSE}`),
    `got ${JSON.stringify(maskedResult.text)}`);
record('[corrects] prose around a placeholder is still fixed',
    maskedResult.text.includes("doesn't work") || maskedResult.text.includes("don't work"),
    `got ${JSON.stringify(maskedResult.text)}`);

// ---------------------------------------------------------------------------
// 10. Reporting
// ---------------------------------------------------------------------------

reports('agreement is reported', 'I has a question', 'agreement');
reports('verb form is reported', 'It should has 500 words', 'verb-form');
reports('word choice is reported', 'Their is a problem', 'word-choice');
reports('noun form is reported', 'The datas is wrong', 'noun-form');
reports('pronoun case is reported', 'Me and him was talking', 'pronoun-case');
reports('article is reported', 'Write a essay', 'article');
reports('contraction is reported', 'I dont know', 'contraction');
reports('tense is reported', 'Yesterday he go home', 'tense');

record('[reports] clean text reports nothing',
    PromptMeterGrammar.check('Explain how binary search works with an example').length === 0,
    `got ${JSON.stringify(PromptMeterGrammar.check('Explain how binary search works with an example'))}`);

record('[reports] check does not rewrite',
    typeof PromptMeterGrammar.check('I has a question') === 'object',
    'check() should return an array of issues');

// ---------------------------------------------------------------------------
// 11. Punctuation pass
// ---------------------------------------------------------------------------

const punctuated = PromptMeterGrammar.correct('explain recursion ,then give an example');
record('[punctuation] spacing is normalized',
    punctuated.text === 'Explain recursion, then give an example.',
    `got ${JSON.stringify(punctuated.text)}`);

const dotted = PromptMeterGrammar.correct('Explain how Node.js works');
record('[punctuation] a dotted name is not split',
    dotted.text.includes('Node.js'),
    `got ${JSON.stringify(dotted.text)}`);

// ---------------------------------------------------------------------------
// 12. Degenerate input
// ---------------------------------------------------------------------------

record('[edge] empty string', PromptMeterGrammar.correct('').text === '', 'empty input threw or changed');
record('[edge] null', PromptMeterGrammar.correct(null).text === '', 'null input threw');
record('[edge] undefined', PromptMeterGrammar.correct(undefined).text === '', 'undefined input threw');
record('[edge] whitespace only',
    PromptMeterGrammar.correct('   ', { punctuation: false }).text === '   ',
    'whitespace-only input was altered');

// ---------------------------------------------------------------------------
// 13. Agreement where the number lives away from the verb
// ---------------------------------------------------------------------------

// fixAgreement only sees pronoun subjects. These are the cases where the noun beside
// the verb is not the subject at all.
corrects('existential plural', 'there is many errors', 'There are many errors');
corrects('existential singular', 'there are a problem', 'There is a problem');
corrects('quantified subject', 'each of the files are broken', 'Each of the files is broken');
corrects('one of takes singular', 'one of the tests have failed', 'One of the tests has failed');
corrects('neither takes singular', 'neither option are correct', 'Neither option is correct');
corrects('head noun sets the number', 'the list of items were long', 'The list of items was long');

declines('plural head keeps the plural verb', 'The lists of items were long');
declines('correct existential singular', 'There is a bug');
declines('correct existential plural', 'There are many bugs');
// A quantifier head takes its number from what it counts, so these are already right.
declines('a number of takes the plural verb', 'A number of users are affected');
declines('a couple of takes the plural verb', 'A couple of tests were failing');
declines('the majority of takes the plural verb', 'The majority of items are valid');
// The pronoun in "one thing I do" is the subject of its own clause, not the middle of
// a quantified phrase.
declines('a pronoun is not the quantified middle', 'One thing I do is print the value');
declines('every time they do is correct', 'Every time they do this it fails');

// ---------------------------------------------------------------------------
// 14. Countable quantifiers and pronoun case after a preposition
// ---------------------------------------------------------------------------

corrects('less before a countable plural', 'less files were changed', 'Fewer files were changed');
corrects('amount of a countable plural', 'reduce the amount of errors', 'Reduce the number of errors');
corrects('pronoun after a preposition', 'between you and I', 'Between you and me');
corrects('pronoun after to', 'send it to John and I', 'Send it to John and me');
corrects('could care less', 'I could care less', "I couldn't care less");

declines('less before a mass noun', 'Use less memory');
declines('amount of a mass noun', 'The amount of data is large');
declines('you and I as a subject', 'You and I should meet');
declines('less time is a mass', 'Less time is needed');

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log('\nFailures:\n');
    failures.forEach((failure, index) => console.log(`  ${index + 1}. ${failure}\n`));
    process.exit(1);
}
console.log('\nAll grammar checks passed.');
