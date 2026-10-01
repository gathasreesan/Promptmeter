/**
 * Bugs found in real use, each pinned to the prompt that produced it.
 *
 *     node tests/regressions.test.js
 *
 * Separate from optimizer.test.js on purpose. That file tests what the rules are meant
 * to do; this one tests what they once did by accident. A case only lands here after
 * somebody typed it into ChatGPT and got something wrong back, so every line is a
 * promise that one specific failure will not return quietly.
 *
 * The last column of each case is the whole point: it is not enough that the prompt gets
 * shorter, the words have to survive.
 */

const path = require('path');

['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
let passed = 0;
let failed = 0;

/** The optimized text must contain `expected` (and must not contain `forbidden`). */
function keeps(prompt, expected) {
    const out = O.optimizeWithReport(prompt).text;
    if (out.toLowerCase().includes(expected.toLowerCase())) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + JSON.stringify(prompt));
        console.log('      expected to keep ' + JSON.stringify(expected));
        console.log('      got              ' + JSON.stringify(out));
    }
}

function drops(prompt, forbidden) {
    const out = O.optimizeWithReport(prompt).text;
    if (!out.toLowerCase().includes(forbidden.toLowerCase())) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + JSON.stringify(prompt));
        console.log('      expected to drop ' + JSON.stringify(forbidden));
        console.log('      got             ' + JSON.stringify(out));
    }
}

/** Case-SENSITIVE absence, for assertions about capitalisation. */
function dropsExact(prompt, forbidden) {
    const out = O.optimizeWithReport(prompt).text;
    if (!out.includes(forbidden)) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + JSON.stringify(prompt));
        console.log('      expected to drop ' + JSON.stringify(forbidden));
        console.log('      got             ' + JSON.stringify(out));
    }
}

function equals(prompt, expected) {
    const out = O.optimizeWithReport(prompt).text;
    if (out === expected) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  ' + JSON.stringify(prompt));
        console.log('      expected ' + JSON.stringify(expected));
        console.log('      got      ' + JSON.stringify(out));
    }
}

// ---------------------------------------------------------------------------
// "teach me different types of ml" came back as "Teach me different pes of ML".
//
// The gratitude stripper was /\b(?:...|ty|kindly)(?:[,!.\s]*)/gi. \b anchors the start
// only, and [,!.\s]* is content with matching nothing, so "ty" matched the first two
// letters of "types". Every short alternative had the same exposure.
// ---------------------------------------------------------------------------
keeps('teach me different types of ml', 'types');
keeps('what typescript types should i use', 'typescript');
keeps('explain the typical use of tyres', 'typical');
keeps('explain tuples and types in python', 'types');
keeps('what is a type alias', 'type');

// The stripper still has to do its job.
drops('thanks a lot, explain recursion', 'thanks');
drops('kindly explain joins', 'kindly');
drops('thx explain closures', 'thx');

// ---------------------------------------------------------------------------
// "tysm explain joins" came back as "You explain joins".
//
// A junk rule matched `thanks?`, consumed the "thank" of "thank you" and left the
// pronoun standing as the subject of the sentence.
// ---------------------------------------------------------------------------
equals('tysm explain joins', 'Explain joins');
equals('thank you so much for your time, explain joins', 'Explain joins');
drops('thank you explain recursion', 'You explain');

// A bare "thank" is a verb, not a pleasantry, and its object is not filler.
keeps('thank the user in the reply', 'thank the user');

// ---------------------------------------------------------------------------
// "i wan to learn ml, and also i wan to learn dl" only rewrote the FIRST clause:
// "Explain ML, and also I want to learn dl".
//
// The clause-start anchors were (?<=^|[.!?;,]|\n)\s*, which required the pattern to
// begin immediately after the punctuation. Any clause introduced by a connective --
// which is most second clauses in English -- was never reached.
// ---------------------------------------------------------------------------
// mergeRepeatedVerbs now collapses the repeated verb too, which is the point of
// rewriting both clauses: two commands become one.
equals('i want to know about recursion, and i want to know about memoization',
    'Explain recursion and memoization');
equals('i am curious about ml, then i want to see examples',
    'Explain ML, then show examples');
keeps('help me understand joins, and also help me understand indexes',
    'and also explain indexes');

// The connective itself must survive: dropping it leaves two unlinked commands.
keeps('i want to learn ml, and i want to learn dl', 'and');

// A rewrite landing mid-sentence must not arrive capitalised.
dropsExact('i want to learn ml, and i want to learn dl', 'and Explain');

// A rewrite at a sentence boundary must not eat the space after the full stop.
keeps('i want to learn ml. i want to learn dl', '. Explain');
// ...without breaking decimals.
keeps('explain pi which is 3.14 exactly', '3.14');

// ---------------------------------------------------------------------------
// Acronyms that are also ordinary English words.
//
// "rest", "ram" and "crud" sat in the plain case-normalisation table, so
// "write the rest of the story" became "write the REST of the story".
// ---------------------------------------------------------------------------
keeps('write the rest of the story', 'the rest of');
keeps('ram the changes through quickly', 'ram the changes');
keeps('clean the crud off the disk', 'the crud off');
keeps('my arm hurts after the gym', 'arm hurts');
keeps('book a spa day for two', 'spa day');

// ...but the technical reading still wins when a companion term vouches for it.
keeps('build a rest api for users', 'REST API');
keeps('add crud operations for posts', 'CRUD operations');
keeps('the ram usage is high', 'RAM usage');
keeps('explain arm architecture', 'ARM architecture');
keeps('build a spa app with routing', 'SPA app');

// "rag" was reaching the spelling corrector first and coming out as "rage".
keeps('build a rag pipeline for docs', 'RAG pipeline');

// ---------------------------------------------------------------------------
// The expanded acronym table must never make a prompt longer. An "expansion" like
// dsa -> "Data Structures & Algorithms" costs tokens, which is the opposite of the job.
// ---------------------------------------------------------------------------
Object.keys(O.techAcronymMap).forEach((key) => {
    const value = O.techAcronymMap[key];
    if (value.length <= key.length) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  acronym "' + key + '" expands to the longer "' + value + '"');
    }
});

// Words that are BOTH a common English word and a technical acronym must not sit in the
// plain case-normalisation table -- there they fire unconditionally and rewrite ordinary
// prose. They belong in ambiguousAcronyms, where a companion term has to vouch for them.
//
// This is an explicit list rather than a dictionary lookup: PM_WORDS is the spelling
// corrector's "leave this alone" vocabulary and deliberately contains acronyms like
// "jwt" and "cpu", so it cannot answer the question "is this ordinary English?".
const COLLIDES_WITH_ENGLISH = ['rest', 'ram', 'crud', 'arm', 'spa', 'rag', 'can',
    'cat', 'dot', 'ice', 'net', 'pin', 'tar', 'top', 'war', 'map', 'set', 'get'];

COLLIDES_WITH_ENGLISH.forEach((word) => {
    if (!Object.prototype.hasOwnProperty.call(O.techAcronymMap, word)) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  "' + word + '" is an English word and must not be in ' +
            'techAcronymMap; move it to ambiguousAcronyms with a companion term');
    }
});

// ---------------------------------------------------------------------------
// No rule may match a proper substring of a dictionary word. That is the signature of
// a missing boundary guard, and it is what produced "types" -> "pes".
// ---------------------------------------------------------------------------
// The spelling dictionary stands in for "a real word": if a rule chews a piece out of
// one of these, it will chew a piece out of somebody's prompt.
const DICTIONARY = new Set(
    require(path.join(__dirname, '..', 'utils', 'spelling.js')).PM_WORDS);

const TABLES = {
    junkStrippers: O.junkStrippers,
    wrapperStrippers: O.wrapperStrippers,
    conversationalStrippers: O.conversationalStrippers,
    concisePhrases: O.concisePhrases,
    adjectiveStacks: O.adjectiveStacks,
    connectiveRepairs: O.connectiveRepairs,
    fluffReplacements: O.fluffReplacements,
    structuralRewrites: O.structuralRewrites,
    intentRewrites: O.intentRewrites,
    ambiguousAcronyms: O.ambiguousAcronyms,
};

Object.keys(TABLES).forEach((name) => {
    TABLES[name].forEach((rule, index) => {
        const rx = rule instanceof RegExp ? rule : rule[0];
        if (!(rx instanceof RegExp)) return;

        const victims = [];
        DICTIONARY.forEach((word) => {
            if (word.length < 4) return;
            rx.lastIndex = 0;
            const match = rx.exec(word);
            if (match && match[0].trim().length && match[0].trim().length < word.length) {
                victims.push(word + ' -> ' + JSON.stringify(match[0]));
            }
        });

        if (victims.length === 0) {
            passed++;
        } else {
            failed++;
            console.log('FAIL  ' + name + '[' + index + '] matches inside words');
            console.log('      ' + victims.slice(0, 5).join('  '));
        }
    });
});

// ---------------------------------------------------------------------------
// Connectors must not stop the card appearing. The optimizer has to keep finding the
// same savings once a comma and a second clause are typed.
// ---------------------------------------------------------------------------
[
    'plz teach me ml',
    'plz teach me ml,and give exampels',
    'thanks in advance explain joins, and show me a exampel',
    'hey can u help me understand recursion, and also explain memoization',
].forEach((prompt) => {
    const report = O.optimizeWithReport(prompt);
    if (report.text && report.text.trim() !== prompt.trim()) {
        passed++;
    } else {
        failed++;
        console.log('FAIL  no optimization offered for ' + JSON.stringify(prompt));
    }
});

// ---------------------------------------------------------------------------
// Found by the 31,499-row LMSYS + BPO corpus. All three corrupted real user text.
// ---------------------------------------------------------------------------

// A comma between digits is a thousands separator and a colon between digits is a
// clock time. The "add a space after punctuation" rule did not know that, so every
// prompt containing a number or a time was being rewritten.
equals('the budget is 1,000,000 dollars exactly', 'The budget is 1,000,000 dollars exactly');
equals('meeting at 14:30 sharp today', 'Meeting at 14:30 sharp today');
keeps('the video starts at [00:00:01] exactly', '[00:00:01]');
keeps('a total of 25,000 users signed up', '25,000');
// ...but a missing space after punctuation is still repaired.
keeps('explain this,then show me the code', ', then');

// A capital "A" mid-sentence is a label, not an article.
keeps('Class A ordinary shares were issued', 'Class A ordinary');
keeps('Type A employees only', 'Type A employees');
keeps('Plan A involves waiting', 'Plan A involves');
// ...and a real article is still corrected.
keeps('a apple fell from the tree', 'An apple');
keeps('The tree fell. A apple rolled away.', 'An apple');

// "tech" was two edits from "teach" and absent from the dictionary, so it was
// "corrected" inside a passage the user had quoted verbatim.
keeps('she got a job at a tech company', 'tech company');
keeps('I work in tech', 'in tech');
keeps('the backend team owns the pipeline', 'backend');
keeps('our devops workflow needs a webhook', 'devops');

// A protected span must count as WORD, not as a word boundary. PM_PROTECT swaps code,
// names and quoted text for U+E000..U+E001, which are not \w, so a plain (?!\w) guard
// read a masked span as whitespace and let a dictionary key match straight into it:
// "w/NAME_1" masked to "w/<span>" and came back as "withNAME_1". Same class as the
// "ty" inside "types" bug, arriving through masking instead.
keeps('write a story w/NAME_1 and NAME_2 together', 'w/NAME_1');
// ...while the expansion still works where it should.
keeps('meet me w/ the team tomorrow', 'with the team');
keeps('a room w/o windows is dark', 'without windows');
keeps('plz help me w/ this', 'with this');

// A verb the prompt repeats across a comma is redundant. condense.js could not reach
// this: it only runs at 15+ words and does not split sentences on commas, so a short
// two-clause prompt kept both verbs.
equals('Explain recursion, explain memoization', 'Explain recursion and memoization');
equals('Write a poem, write a haiku', 'Write a poem and a haiku');
keeps('Explain different types of finite automata, explain ML', 'automata and ML');
// A long second clause is two real instructions, not a repetition: merging would
// attach the first clause's object to the second clause's qualifiers.
keeps('Explain A, explain B in detail with examples and a full table of results',
    'explain B in detail');
// The backreference alone would also collapse "the cat, the dog" into one phrase.
keeps('Show me the cat, the dog is fine', 'the cat, the dog');

// "fnite" could never reach "finite" because "finite" was not in the dictionary at all.
// Measured over 8,000 real prompts, the 2,191-word list made 2,287 corrections of which
// 1,556 landed on words that were ALREADY correct English: a word the dictionary does
// not know is indistinguishable from a misspelling.
keeps('Explan different types of fnite automata, explain ML', 'finite');
keeps('explain fnite automata', 'finite');
// ...and the words it used to corrupt are now left alone.
keeps('we met yesterday to discuss it', ' met ');
keeps('this is a non issue for us', 'non issue');
keeps('the stat we need is the median', 'stat');
keeps('I sent it to the com port', 'com port');

// ---------------------------------------------------------------------------
// The English vocabulary tables ran on every language. looksEnglish already guarded the
// open-ended corrector -- "an English dictionary on German text corrects bitte to bite"
// -- but spellingTypos and chatSlangMap were applied unconditionally, and they contain
// "mich" -> "much" and "liste" -> "list". Measured over 6,000 real prompts, German came
// back with "die mich neugierig anschauen" rewritten to "die much neugierig anschauen".
// ---------------------------------------------------------------------------
keeps('ob Emily und Mia die mich neugierig anschauen mit mir duschen duerfen', 'mich');
keeps('Die Zeiten koennen morgens oder abends sein, je nachdem wann sie mich brauchen.', 'mich');
keeps('Erstelle eine Zusammenfassung der Meinungen als Liste', 'Liste');
keeps('Welche Regeln muss ich erfuellen um eine Liste mit Geburtstagen anzufertigen?', 'Liste');
drops('Grazie mille per il tuo aiuto', 'mile');
// ...while English, including messy English, is still corrected.
keeps('A room w/o windows is dark', 'without');
keeps('plz explain recursion tmrw', 'tomorrow');
keeps('can u explain b4 the exam', 'before');
keeps('i am havng an issue with my funciton', 'function');
keeps('can u pls explain how stupd gatha is', 'stupid');

// ---------------------------------------------------------------------------
// Every stripper ends in [,!.\s]*, so it eats the punctuation that TRAILS the phrase it
// removes but never the comma that introduced it: "review this code for me, thanks so
// much:" closed up as "review this code for me,:".
// ---------------------------------------------------------------------------
dropsExact('review this code for me, thanks so much: def f(): pass', ',:');
dropsExact('help me, please: y=2', ',:');
dropsExact('summarize this, thanks in advance: z=3', ',:');
dropsExact('fix it for me, thanks!: a=4', ',:');
// ...without eating commas that are doing real work.
keeps('list three things: speed, cost, accuracy', 'speed, cost, accuracy');
keeps('the total was 1,000.50 dollars, explain the tax', '1,000.50');

// ---------------------------------------------------------------------------
// "dma" (Data Mining and Analysis) was rewritten to "dam". At three letters neither edit
// distance nor edit shape can tell a typo from an acronym -- "dma"/"dam" and "teh"/"the"
// are both single transpositions -- and techAcronymMap can only protect the acronyms
// somebody remembered to list, never the user's own course codes or team initialisms.
// Two independent signals settle it: how common the destination is, and whether the
// letters kept their order.
// ---------------------------------------------------------------------------
keeps('explain dma', 'dma');
keeps('teach me dma and dsa', 'dma');
keeps('i have a dma exam tomorrow', 'dma');
keeps('what is dma and dbms', 'dbms');
drops('explain dma', 'dam');
drops('teach me dma', 'dam');
// Transposed three-letter initialisms in general, not just the one that was reported.
drops('explain rma process', 'ram');
drops('explain mpa degree', 'map');
// ...while three-letter typos are still corrected, whether they are common words
// ("teh" -> "the") or merely dropped vowels ("mch" -> "much", not a top-1000 word).
keeps('teh cat sat', 'The');
keeps('do you wan coffee or tea', 'want');
keeps('people depend on it too mch', 'much');
keeps('i adn you', 'and');

// ---------------------------------------------------------------------------
// "helao i has exam tomo which is exm which is which is dma so teach" came back with
// "which is" still in it twice. The adjacent-duplicate rule could not see it: the two
// surviving copies are not adjacent, because the clause the writer abandoned sits
// between them. What makes it droppable is that the abandoned middle says nothing new.
// ---------------------------------------------------------------------------
equals('helao i has exam tomo which is exm which is which is dma so teach',
       'I have exam tomorrow which is dma so teach');
equals('i have an exam tomorrow which is exam which is dma',
       'I have an exam tomorrow which is dma');
equals('the file which is file which is corrupted', 'The file which is corrupted');
equals('a function that is function that is broken', 'A function that is broken');
// A middle that carries new information is a real clause and stays, both of them.
keeps('the tool which is free which is open source', 'free');
keeps('the tool which is free which is open source', 'open source');
keeps('a library that is fast that is reliable', 'fast');
keeps('the exam which is tomorrow which is dma', 'tomorrow');

// ---------------------------------------------------------------------------
// Prompts built around + & | > and initialisms went uncorrected: single letters and
// acronyms dragged the English ratio under the bar, so both language gates skipped
// the typo tables and the corrector.
// ---------------------------------------------------------------------------
equals('a + b + c teh diffrence', 'A + b + c the difference');
equals('AI + ML + DL + NLP are importnt', 'AI + ML + DL + NLP are important');
equals('a & b | c teh diffrence', 'A & b | c the difference');
equals('stacks&queues wiht exmaples', 'Stacks&queues with examples');
equals('data mining > ML in my opinon', 'Data mining > ML in my opinion');
// Counting fixable typos as English must not let German through: "mich" is one
// letter from "much" and "und" from "and".
keeps('ob Emily und Mia die mich neugierig anschauen', 'mich');
// "um" is a word outside English and only a filler inside it.
keeps('Welche Regeln muss ich erfuellen um eine Liste anzufertigen?', 'erfuellen um eine');
keeps('Explique a recursividade com um exemplo simples', 'com um exemplo');
drops('um uh explain joins pls', 'um');

// ---------------------------------------------------------------------------
// A connector starts a new clause. "+ can u pls tell me" kept its wrapper because
// the clause-start rules only knew . ! ? , ; and a newline.
// ---------------------------------------------------------------------------
equals('explain recursion + can u pls tell me teh diffrence between stacks and queues',
       'Explain recursion + tell me the difference between stacks and queues');
equals('data mining -> can u pls explian apriori algoritm', 'Data mining -> explain apriori algorithm');
equals('notes on os & hey chatgpt can u add exmaples', 'Notes on OS & add examples');
equals('i need notes on dbms + also can you plz explian normalisation wiht exmaples',
       'I need notes on dbms + also explain normalisation with examples');
equals('explain recursion hey chatgpt thanks', 'Explain recursion');
equals('hey chatgpt so basically i want u to explain recursion', 'Explain recursion');
// Not a wrapper, not a vocative: left alone.
keeps('can you believe this + explain it', 'can you believe');
keeps('vector u + vector v, find the angle', 'vector u');
keeps('the hey chatgpt jingle is catchy', 'hey ChatGPT jingle');

// ---------------------------------------------------------------------------
// Typos the corrector let through: a missing doubled consonant read as a regular
// inflection, and misspellings hiding in the attested-word list.
// ---------------------------------------------------------------------------
keeps('the error occured twice', 'occurred');
keeps('from the begining please', 'beginning');
keeps('fix this sentance', 'sentence');
keeps('difference between stacks and queus', 'queues');
// American spellings with a single l are words, not typos.
keeps('the job was canceled', 'canceled');
keeps('labeled data for training', 'labeled');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
