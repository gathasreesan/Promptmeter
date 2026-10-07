/**
 * Release gate: every defect found by fuzzing the card's real code path over the
 * corpus before the live demo, each pinned by the case that exposed it.
 *
 *     node tests/release.test.js
 *
 * Loads the content scripts the way Chrome does -- manifest order, one shared scope --
 * and calls PromptMeterCompress.compress with the card's own 40ms budget, so what is
 * tested is what the card shows.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, performance,
    chrome: { storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
              runtime: { getURL: (p) => p } },
});
context.window = context;
manifest.content_scripts[0].js.filter((f) => f !== 'content.js').forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
});
const C = vm.runInContext('PromptMeterCompress', context);
const card = (text, budget) => C.compress(text, { budgetMs: budget || 40, preserve: new Set() }).text;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
    if (condition) { passed++; return; }
    failed++;
    console.log('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
}

const NL = String.fromCharCode(10);
const PARAGRAPH = 'The industrial revolution changed everything about how people worked and '
    + 'lived. Factories replaced small workshops across the country. Cities grew quickly as '
    + 'families moved from farms to find jobs. Working conditions were often dangerous and '
    + 'wages were low. Children also worked long hours in mills and mines. Over time new '
    + 'laws improved safety and limited the working day.';

// Both budgets: the card's 40ms, and 1ms -- a slow machine where every budget is blown
// and the compressor takes its fallback path. A demo PC is not this one.
[40, 1].forEach((budget) => {
    const tag = ' [' + budget + 'ms]';

    // -----------------------------------------------------------------------
    // 1. A "2" that is a COUNT is not txt-speak for "to".
    //    "At the second stop, 2 get off" came back as "to get off": a number deleted
    //    from a maths word problem, and the validator agreed because it expands digits
    //    with the same rule.
    // -----------------------------------------------------------------------
    [
        'You are driving a bus. At the first stop, 5 people get on. At the second stop, 2 get off, and 3 get on.',
        '2 get off at the next stop',
        '5 got on and 2 get off',
        'if 2 go and 3 stay, how many are left',
    ].forEach((input) => {
        const got = card(input, budget);
        check('the count 2 survives' + tag + ': ' + JSON.stringify(input.slice(0, 40)),
            /\b2\b/.test(got) && !/\bto (?:get|go)\b/.test(got.replace(/how many/, '')), got);
    });
    // ...and txt-speak still expands, including after txt-speak.
    [
        ['I want 2 go home', /want to go/],
        ['how 2 make pasta', /to make pasta/i],
        ['can u tell me wat 2 do if my phone fell in water', /what to do/],
        ['what 2 do now', /to do now/],
    ].forEach(([input, want]) => {
        const got = card(input, budget);
        check('txt-speak 2 still becomes "to"' + tag + ': ' + input, want.test(got), got);
    });

    // -----------------------------------------------------------------------
    // 2. An instruction above a pasted paragraph is never dropped.
    //    "paraphrase" alone on a line read as a two-word fragment and was pruned, so the
    //    paragraph went to the model with the instruction deleted. The editing verbs
    //    were missing from the imperative list entirely.
    // -----------------------------------------------------------------------
    ['paraphrase', 'revise', 'shorten', 'rephrase', 'polish', 'proofread', 'reword',
     'simplify', 'edit', 'correct', 'expand', 'summarise this:', 'translate to hindi:',
     'make this better', 'fix the grammar'].forEach((verb) => {
        ['"' + NL + NL, ':' + NL, NL + NL].forEach((joint) => {
            const input = verb + ' ' + joint + PARAGRAPH + (joint.charAt(0) === '"' ? '"' : '');
            const got = card(input, budget);
            const head = verb.split(' ')[0].replace(':', '');
            check('the instruction survives' + tag + ': ' + JSON.stringify(verb + joint.trim()),
                got.toLowerCase().indexOf(head.toLowerCase()) !== -1
                // Translate's own word may legitimately be capitalised.
                || new RegExp(head, 'i').test(got),
                got.slice(0, 80));
            check('the paragraph survives' + tag + ': ' + JSON.stringify(verb),
                /industrial revolution/i.test(got) && /working day/i.test(got), got.slice(0, 80));
        });
    });

    // -----------------------------------------------------------------------
    // 3. A format template keeps every line, including a placeholder marker.
    //    "n) Riddle." was a fragment outside the A-H list-marker range and was dropped,
    //    taking with it the format the prompt was specifying.
    // -----------------------------------------------------------------------
    const RIDDLES = 'Generate 10 riddles with their answers. The format should be:' + NL
        + 'n) Riddle.' + NL + 'Ans: Answer of the riddle.';
    check('the placeholder format line survives' + tag, card(RIDDLES, budget).indexOf('n) Riddle.') !== -1,
        card(RIDDLES, budget));
    ['x) Item.', 'k) Step.', '12) Question.'].forEach((marker) => {
        const input = 'Write ten quiz questions about photosynthesis for a class of students. '
            + 'Use this exact format for every one of them:' + NL + marker + NL + 'Answer: the answer.';
        check('marker ' + marker + ' survives' + tag, card(input, budget).indexOf(marker) !== -1,
            card(input, budget));
    });
});

// ---------------------------------------------------------------------------
// 5. Greetings and emoticons leave no debris.
//    The opening of the prompt is the first thing anyone reads on the card, and four
//    stages each tore an emoticon differently: "hi :) explain recursion" -> ") explain
//    recursion", "hey :D teach me" -> "D teach me", "explain ml :)" -> "Explain ML: )",
//    "hello? anybody there?" -> "? Anybody there?".
// ---------------------------------------------------------------------------
[40, 1].forEach((budget) => {
    const tag = ' [' + budget + 'ms]';
    [
        ['hi :) explain recursion', 'Explain recursion'],
        ['hey :D teach me ml', 'Teach me ML'],
        ['hi :P explain ml', 'Explain ML'],
        ['hi ;) explain ml', 'Explain ML'],
        ['hey, :) can u explain ml', 'Explain ML'],
        [':) explain ml', 'Explain ML'],
        ['explain ml :)', 'Explain ML'],
        ['hii?? explain ml', 'Explain ML'],
        ['hello? anybody there?', 'Anybody there?'],
        ['hi 😊 explain recursion', 'Explain recursion'],
        ['hey 👋👋 teach me python', 'Teach me Python'],
    ].forEach(([input, want]) => {
        const got = card(input, budget);
        check('greeting and emoticon go cleanly' + tag + ': ' + JSON.stringify(input),
            got.replace(/[.]$/, '') === want, got);
    });

    // Whatever happens to the rest, no output may start with a torn emoticon or a
    // greeting's stray punctuation.
    ['hi :) explain', 'hey :D teach', 'hi :( help', 'hello :-) explain', 'hey :O explain',
     'hi :] explain', 'yo ;P explain', 'hi?? explain', 'hello! explain', 'hey... explain',
     'hola :) explica el aprendizaje', 'hi :3 teach me ml', 'hello <3 explain ml']
        .forEach((input) => {
            const got = card(input + ' recursion in python', budget);
            check('no debris at the start' + tag + ': ' + JSON.stringify(input),
                !/^\s*(?:[)(\]\[DPpO3|*]|[?!.,;:](?![)(DP]))/.test(got), got);
        });

    // ...and nowhere else either: an emoticon is whole or gone, never split.
    ['explain ml :)', 'explain ml :(', 'explain ml :D', 'i am sad :( help me study',
     'thanks for the help :) now explain ml', 'great :D what is recursion']
        .forEach((input) => {
            const got = card(input, budget);
            check('no split emoticon' + tag + ': ' + JSON.stringify(input),
                !/[:;] [)(DP]/.test(got) && !/(?:^|\s)[)(](?:\s|$)/.test(got), got);
        });

    // What must NOT go: an emoticon the prompt is about, and anything in code.
    check('a prompt about an emoticon keeps it' + tag,
        card('what does :P mean', budget).indexOf(':P') !== -1, card('what does :P mean', budget));
    ['print(a[1:])', 'x = f(a, 8)', 'if (a :) b', 'map[":)"] = 1'].forEach((code) => {
        const got = card('fix this code `' + code + '` please', budget);
        check('code containing emoticon-like text is untouched' + tag + ': ' + code,
            got.indexOf('`' + code + '`') !== -1, got);
    });
    check('a "hello world" program keeps its hello' + tag,
        /hello world/i.test(card('write a hello world program in C', budget)));
    check('"say hi" keeps its hi' + tag, /say hi/i.test(card('say hi to my mom in french', budget)));
});

// ---------------------------------------------------------------------------
// 6. Short student English reads as English.
//    "hi teach me ml" went down the FOREIGN path -- "hi" and "ml" are in neither the
//    dictionary nor the typo tables, so it scored 2/4 -- while "hey teach me ml" passed
//    because "hey" is a dictionary word. On the foreign path the English rules never
//    run, so the card offered nothing for the most typical demo prompt there is.
// ---------------------------------------------------------------------------
const OPT = vm.runInContext('PromptMeterOptimizer', context);
['hi', 'hii', 'hey', 'hello', 'yo', 'hai', 'hlo', 'helo', 'sup', 'hiya'].forEach((g) => {
    ['teach me ml', 'define osi model', 'explain recursion', 'give me notes on dbms'].forEach((ask) => {
        check('reads as English: ' + g + ' ' + ask, OPT.looksEnglish(g + ' ' + ask) === true);
    });
});
['teach me ml bro', 'pls explain ml', 'plz teach me dbms', 'bro explain recursion',
 'hey :D teach me ml', 'hi :P explain ml', 'what is dbms', 'explain dsa'].forEach((t) => {
    check('reads as English: ' + t, OPT.looksEnglish(t) === true);
});
// ...and the chat words that now count do not let another language through: the
// two-real-English-words requirement still has to be met.
['yo quiero aprender ml', 'hola bro explica ml', 'ciao bro spiegami il machine learning',
 'hi tolong jelaskan ml', 'bhai mujhe ml sikhao', 'hola, explica ml', 'olá tudo bem?',
 'Explique a recursividade', 'Erkläre mir bitte Rekursion'].forEach((t) => {
    check('stays foreign: ' + t, OPT.looksEnglish(t) === false);
});
check('the typical demo prompt is optimized as English',
    /^Teach me ML/.test(card('hi teach me ml')), card('hi teach me ml'));

// ---------------------------------------------------------------------------
// 7. Answer options are data: never corrected, never dropped.
//    "Which word is spelled correctly? A) recieve B) receive C) receeve" came back with
//    all three options spelled "receive" -- the quiz destroyed, every answer now right.
//    A capitalisation question had option A's "i" capitalised, and a quoted option A
//    was pruned outright.
// ---------------------------------------------------------------------------
[40, 1].forEach((budget) => {
    const tag = ' [' + budget + 'ms]';
    [
        ['Which word is spelled correctly?' + NL + 'A) recieve' + NL + 'B) receive' + NL + 'C) receeve',
            ['A) recieve', 'B) receive', 'C) receeve']],
        ['Which word is spelled correctly? A) recieve B) receive C) receeve',
            ['A) recieve', 'C) receeve']],
        ['Select the sentence that has the correct capitalization. "A) i love reading books' + NL
            + 'B) I Love Reading Books' + NL + 'C) I love Reading Books"',
            ['"A) i love reading books', 'B) I Love Reading Books', 'C) I love Reading Books']],
        ['pls tel me which is correct' + NL + 'A) their going home' + NL + 'B) they are going home',
            ['A) their going home', 'B) they are going home']],
        ['Which planet is largest?' + NL + '(a) Mars' + NL + '(b) Jupiter' + NL + '(c) Venus',
            ['(a) Mars', '(b) Jupiter', '(c) Venus']],
        ['Find the grammar mistake:' + NL + 'A. he go to school' + NL + 'B. she goes to school',
            ['A. he go to school', 'B. she goes to school']],
    ].forEach(([input, options]) => {
        const got = card(input, budget);
        options.forEach((option) => {
            check('answer option kept verbatim' + tag + ': ' + JSON.stringify(option),
                got.indexOf(option) !== -1, got);
        });
    });
    // The instruction above the options is still the user's prose and still fixed.
    check('the question above the options is still corrected' + tag,
        /^Tell me which is correct/.test(card('pls tel me which is correct' + NL
            + 'A) their going home' + NL + 'B) they are going home', budget)));

    // A typo inside a NUMBERED list item is the user's own and is fixed -- the validator
    // used to reject that as the item losing a word, and the prompt came back untouched.
    const steps = card('pls explan these steps:' + NL + '1. instal node' + NL + '2. run npm instal', budget);
    check('a numbered list gets its typos fixed' + tag, /1\. Install node/.test(steps) && /npm install/.test(steps), steps);
    check('the instruction above it is fixed too' + tag, /^Explain these steps:/.test(steps), steps);
});

// ---------------------------------------------------------------------------
// 8. A name with a digit in it is not a typo.
//    "unity3d" became "unityed", "the movie M3gan" became "Megan", "autocad2d" became
//    "autocad". A digit with one trailing letter is a suffix; a capital mid-sentence
//    is a name.
// ---------------------------------------------------------------------------
['unity3d', 'M3gan', 'autocad2d', 'blender3d', 'w3schools', 'html5', 'css3', 'web3js',
 'covid19', 'iphone15', 'k8s', 'mp3', 'e2e', 's3', 'ps5', 'x86', 'gpt4'].forEach((name) => {
    const got = card('tell me about ' + name + ' please');
    check('digit-bearing name survives: ' + name, got.toLowerCase().indexOf(name.toLowerCase()) !== -1, got);
});
[['explain h3llo world', /hello world/], ['explain the foll0wing', /following/],
 ['fix my pr5oblems', /problems/], ['write c0de', /code/], ['say w0rld', /world/],
 ['Foll0wing the guide, explain it', /^Following/]].forEach(([input, want]) => {
    const got = card(input);
    check('a digit typed inside a word is still fixed: ' + input, want.test(got), got);
});

// ---------------------------------------------------------------------------
// 4. The load-time warm-up must warm the PROSE path.
//    It was one prompt containing inline code, and a protected span takes a different
//    path through the compressor, so the user's first ordinary prompt still paid
//    ~255ms -- the one keystroke a demo audience is guaranteed to watch. Checked in a
//    fresh process, because vm contexts share one V8 isolate and an earlier compile
//    in this file would make the cold call look warm.
// ---------------------------------------------------------------------------
const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const warmStart = CONTENT.indexOf('(function warmUp()');
check('content.js has a warm-up', warmStart !== -1);
const warmBlock = CONTENT.slice(warmStart, CONTENT.indexOf('})();', warmStart));
const warmPrompts = [...warmBlock.matchAll(/'([^'\n]{12,})'/g)].map((m) => m[1]);
check('the warm-up includes a prompt with no inline code',
    warmPrompts.some((p) => p.indexOf('`') === -1), JSON.stringify(warmPrompts));
check('the warm-up includes a misspelling, so the spelling indexes are built',
    warmPrompts.some((p) => /\b(?:explan|recusion|teh|plz|pls)\b/.test(p)), JSON.stringify(warmPrompts));

const probe = [
    "const fs=require('fs'),path=require('path'),vm=require('vm');",
    "const ROOT=" + JSON.stringify(ROOT) + ";",
    "const m=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'),'utf8'));",
    "const ctx=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,performance,",
    "  chrome:{storage:{local:{get(){},set(){}},onChanged:{addListener(){}}},runtime:{getURL:p=>p}}});",
    "ctx.window=ctx;",
    "m.content_scripts[0].js.filter(f=>f!=='content.js').forEach(f=>vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),ctx,{filename:f}));",
    "const C=vm.runInContext('PromptMeterCompress',ctx);",
    "JSON.parse(process.argv[1]).forEach(p=>C.compress(p,{budgetMs:100}));",
    "const t0=performance.now(); C.compress('teach me ml pls',{budgetMs:40});",
    "process.stdout.write(String(performance.now()-t0));",
].join('\n');
const first = Number(require('child_process').execFileSync(process.execPath,
    ['-e', probe, JSON.stringify(warmPrompts)], { encoding: 'utf8' }));
// Generous on purpose: cold is ~255ms here, warm is ~5ms, and a test that flakes on a
// busy machine the night before a demo is worse than no test.
check('the first prompt after the warm-up is fast (' + first.toFixed(1) + 'ms)', first < 100,
    first.toFixed(1) + 'ms');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
