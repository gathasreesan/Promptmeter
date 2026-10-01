/**
 * Logic errors found in a full debug pass, each pinned to the input that exposed it.
 *
 *     node tests/debug-fixes.test.js
 */

const path = require('path');
const u = (name) => require(path.join(__dirname, '..', 'utils', name + '.js'));
const C = u('compress').PromptMeterCompress;
const A = u('analysis').PromptMeterAnalysis;
const G = u('gamification').PromptMeterGamification;

let passed = 0;
let failed = 0;
function check(name, ok, got) {
    if (ok) { passed++; return; }
    failed++;
    console.log('FAIL  ' + name + (got !== undefined ? '\n      got ' + JSON.stringify(got) : ''));
}

// Keep on the card: compress() never passed the declined words to analyze().
const kept = C.compress('Can you please explain recusrion in python and also build a full website?',
    { preserve: new Set(['recusrion']) }).text;
check('declined correction stays declined', kept.includes('recusrion'), kept);

// Payload: the article to summarise lost a sentence and still validated.
const article = C.compress('Summarize the following article in 3 bullet points: '
    + 'The quick brown fox jumps over the lazy dog. It was a sunny day.').text;
check('payload survives', article.includes('It was a sunny day.'), article);

// Style instruction: "Be concise." was dropped with no violation.
const concise = C.compress('I want you to act as a senior developer. Review this code: '
    + '`const x = foo(bar)` and tell me whats wrong with it. Be concise.').text;
check('style constraint survives', /be concise/i.test(concise), concise);


// a/an: each direction only knew the other direction's exceptions.
[['write a essay on a honest man', 'an honest'], ['an university', 'a university'],
 ['an user asked', 'a user'], ['an unicorn', 'a unicorn'], ['an uninstall step', 'an uninstall'],
 ['a apple', 'an apple'], ['an banana', 'a banana'], ['a hour ago', 'an hour']]
    .forEach(([p, want]) => {
        const out = A.analyze(p, new Set()).corrected;
        check('article: ' + p, out.toLowerCase().includes(want), out);
    });

// their going to -> they're going to (only "there going to" was handled).
const their = A.analyze('their going to the park', new Set()).corrected;
check("their going -> they're going", /they're going/i.test(their), their);

// Streak: one weak first prompt today zeroed a streak today could still extend.
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
const streak = [3, 2, 1].map((n) => ({ timestamp: day(n), efficiencyScore: 95 }))
    .concat({ timestamp: day(0), efficiencyScore: 50 });
check('streak survives a weak prompt today', G.calculateStreak(streak) === 3, G.calculateStreak(streak));

// Badges: `score || 100` counted a genuine 0 as 100.
const zeros = Array.from({ length: 5 }, () => ({ timestamp: day(0), efficiencyScore: 0 }));
check('zero scores earn no Green User badge', !G.checkBadges(zeros)[0].unlocked);

// ---- Found by the stress pass over custom prompts --------------------------------
const text = (p) => C.compress(p, { budgetMs: 1e5 }).text;
const has = (name, out, want) => check(name, out.toLowerCase().includes(want.toLowerCase()), out);

// Corrections that save no tokens were never applied; case-only changes still aren't.
has('typo fixed without a token saving', text('In python whats the diffrence between a list and a tuple'), 'difference');
check('case-only change left alone', C.compress('explain C++ and C# using == and !=').mode === 'none');

// Content the validator used to let go.
const cap = text('Explain the CAP theorem. Also explain ACID. Also BASE. Also compare them in a table. '
    + 'Also give real examples for each. Also tell me which one Cassandra uses. And MongoDB. And Postgres.');
['BASE', 'MongoDB', 'Postgres'].forEach((n) => has('name kept: ' + n, cap, n));
has('list item kept', text('Requirements:\n1. Must use React\n2. No external CSS libraries\n3. Mobile first\nBuild a todo app.'), 'Mobile first');
has('role kept', text('I want you to act as a Linux terminal. I will type commands and you will reply with what the terminal should show.'), 'Linux terminal');
check('"hello?" not reduced to "?"', /[a-z]/i.test(text('hello?')), text('hello?'));
has('"Thanks to" is not thanks', text('Thanks to the new API, our latency dropped. Explain why caching helps.'), 'API');
has('"Say hi" keeps hi', text('Say hi to my mom in a birthday message'), 'say hi');
check('"Can you believe" not stripped', !/^Believe/.test(text('Can you believe the speed of light is constant? Explain why it is constant for all observers.')));
check('no ",." left behind', !/,\./.test(text('At this point in time, I need you to basically just summarize the article, basically.')));
has('sentence boundary kept', A.analyze('I have never done this before and I am kind of panicking lol. Can you give me a step by step plan?', new Set()).optimized, 'before.');

// Spelling: real words are not typos.
['caching', 'colour', 'organise', 'licence', 'confuse'].forEach((w) =>
    check('real word kept: ' + w, A.analyze('Explain ' + w + ' in the essay please', new Set()).corrected.toLowerCase().includes(w)));
check('no English spelling on German', !A.analyze('Kannst du mir bitte helfen, eine E-Mail zu schreiben?', new Set())
    .findings.some((f) => f.category === 'spelling'));
has('get confuse -> get confused', A.analyze('i always get confuse between these two', new Set()).corrected, 'get confused');

// Findings that were wrong or badly worded.
const flags = (p) => A.analyze(p, new Set()).findings.map((f) => f.explanation).join(' | ');
check('clear request not flagged', !/clearly state/.test(flags('Set up Nginx as a reverse proxy for Gunicorn on Ubuntu')), flags('Set up Nginx as a reverse proxy for Gunicorn on Ubuntu'));
check('"an API", not "a api"', /an API/.test(flags('Create an API')), flags('Create an API'));
check('"Fix this:" points forward', !/first thing the prompt mentions/.test(flags('Fix this: `x = 1` it gives the wrong result')));
check('"1NF" is not a name "NF"', !C.namesIn('Explain 1NF and 2NF').includes('NF'), C.namesIn('Explain 1NF and 2NF'));

// ---- Found in live browser testing -----------------------------------------------
['pls explain dns in simple words thx', 'plz write a haiku about rain', 'kindly summarise this article'].forEach((p) =>
    check('"' + p.split(' ')[0] + ' <verb>" is a clear request', !/clearly state/.test(flags(p)), flags(p)));

// Real words the dictionary lacked were "corrected" into other words.
[['How many toes do dogs have?', 'toes'], ['the force the trampoline exerts on me', 'exerts'],
 ['the main task of the bot is to reply', ' bot '], ['a risky plan', 'risky'], ['Explain sentience', 'sentience'],
 ['Como declarar una variable en python?', 'Como'], ['is he sane', 'sane']]
    .forEach(([p, w]) => has('real word kept: ' + w.trim(), A.analyze(p, new Set()).corrected, w));
has('misspellings still fixed', A.analyze('teh cat recieve thier food definately', new Set()).corrected,
    'the cat receive their food definitely');

// Clean-up rules that ran on text nothing had been removed from.
const opt = (p) => A.analyze(p, new Set()).optimized;
has('"because of" kept', opt("Draft a reply declining the meeting because of a doctor's appointment."), 'because of');
has('"Which of" kept', opt('Question: Which of the following is a way to help?'), 'Which of');
has('"when will" kept', opt('when will the next solar eclipse happen'), 'When will');
has('"Do you know" kept', opt('Do you know flutter, a framework?'), 'Do you know');
has('ChatGPT as a topic kept', opt('Explain how to ask the right question to ChatGPT to get results.'), 'ChatGPT');
has('GPT-4o kept', opt('How does Claude compare to GPT-4o on coding?'), 'GPT-4o');
has('addressing ChatGPT stripped', opt('Hey ChatGPT, explain recursion'), 'Explain recursion');
has('help with a noun keeps the ask', opt('I need help with my assignment'), 'help with my assignment');

// Sentences the condenser dropped although they carried the request or its context.
const cond = (p) => C.compress(p, { budgetMs: 1e5 }).text;
has('"Also ..." continuation kept', cond("Explain the difference between affect and effect. Also between then and than. Also between your and you're."), "your and you're");
has('"In detail" kept', cond('What is the legal regulation in the field of employment in Russia? In detail'), 'In detail');
has('antecedent kept for "they"', cond('Beavers are interesting animals that live near rivers. What do they build?'), 'Beavers');
has('antecedent kept for "It"', cond("There's a girl in my class who is shy, everyone laughs at her. It's normal, right?"), 'girl');
has('"Use O(n) time" kept', cond('Given a list of integers, return indices of two numbers that add up to a target. Use O(n) time. Language: Go.'), 'O(n)');
has('role kept', cond('Please assume the role of an expert storyteller. Write the first chapter of a story about flowers.'), 'storyteller');

// Grammar rules that were wrong.
has('"an M2" kept', A.analyze('I am on macOS 14 with an M2', new Set()).corrected, 'an M2');
has('"a GPU" fixed', A.analyze('it runs on an GPU', new Set()).corrected, 'a GPU');
has('"and that have" agrees with the plural', A.analyze('problems that can be solved and that have no fix', new Set()).corrected, 'that have');
has('"its true" -> "it\'s true"', A.analyze('I believe its true', new Set()).corrected, "it's true");

// Single-quoted material is the user's text to work on, not to be corrected.
has("single-quoted German left alone", cond("act as my german tutor. correct my sentence: 'Ich habe gestern nach Berlin gefahren.'"), 'Ich habe');
has('apostrophes are not quotes', A.analyze("it's the students' books and teh teachers' pens", new Set()).corrected, 'the teachers');

// ---- Languages: foreign text untouched, code-mixed keeps its native words ---------
[['Spanish', '¿Puedes explicarme cómo funciona la fotosíntesis? Gracias de antemano.'],
 ['French', "Bonjour, pouvez-vous m'expliquer la récursivité en Python avec un exemple ?"],
 ['German', 'Kannst du mir bitte helfen, eine E-Mail an meinen Chef zu schreiben?'],
 ['Italian', 'Ciao, potresti spiegarmi la differenza tra TCP e UDP? Grazie mille.'],
 ['Indonesian', 'Halo, tolong jelaskan perbedaan antara TCP dan UDP. Terima kasih.'],
 ['Portuguese', 'Olá! Você pode me explicar como funciona uma API REST? Obrigado.'],
 ['Hindi', 'नमस्ते, क्या आप मुझे पायथन में रिकर्शन समझा सकते हैं? धन्यवाद।'],
 ['Malayalam', 'ഹലോ, പൈത്തണിൽ റിക്കർഷൻ എന്താണെന്ന് വിശദീകരിക്കാമോ? നന്ദി.'],
 ['Chinese', '你好，请用简单的语言解释一下机器学习。谢谢！'],
 ['Japanese', 'こんにちは。Pythonで再帰を説明してください。ありがとうございます。'],
 ['Russian', 'Привет! Объясни, пожалуйста, рекурсию в Python на примере. Спасибо.'],
 ['Arabic', 'مرحبا، هل يمكنك شرح الفرق بين TCP و UDP؟ شكرا جزيلا.']]
    .forEach(([lang, p]) => check(lang + ' left untouched', text(p) === p, text(p)));
const hinglish = text('bhai mujhe python mein recursion samjhao please, kal exam hai');
['mujhe', 'samjhao', 'kal', 'hai'].forEach((w) => has('Hinglish keeps "' + w + '"', hinglish, w));
has('Manglish keeps cheyyamo', text('chetta enikku python recursion onnu explain cheyyamo pls'), 'cheyyamo');
check('samjhao is a clear request', !/clearly state/.test(flags('bhai mujhe python mein recursion samjhao please')));

// Messy English that used to read as not-English, and pasted repeats.
const messy = 'can u pls explain how stupd gatha is wawa ass greatt bootiful';
has('messy English gets a suggestion', text(messy), 'Explain how stupid');
check('a prompt pasted 3 times collapses to one', text(messy + ' ' + messy + ' ' + messy).split('stupid').length === 2,
    text(messy + ' ' + messy + ' ' + messy));
has('"2nite" expands without losing a number', text('yo wat r u doin 2nite lol, can u explain recursion tho'), 'tonight');
has('real numbers in words still protected', text('Schedule it at 3pm and compare GPT-4o please'), '3pm');

// ---- Features: strictness, dictionary, fix reports, CSV --------------------------
const messyExam = "hey can u pls explain recusrion in python, i have an exam tomorrow and i am so stressed, thanks!!";
const fixesOnly = C.compress(messyExam, { budgetMs: 1e5, maxMode: 'conservative' });
check('fixes-only never removes', fixesOnly.mode === 'conservative' && /stressed/.test(fixesOnly.text), fixesOnly.text);
has('fixes-only still corrects', fixesOnly.text, 'recursion');
check('trim may remove filler', C.compress(messyExam, { budgetMs: 1e5, maxMode: 'balanced' }).text.length < messyExam.length);

// chrome.storage.local, in memory, for the storage helpers.
const store = {};
global.chrome = { storage: { local: {
    get: (defaults, cb) => cb(Object.assign({}, defaults, JSON.parse(JSON.stringify(store)))),
    set: (values, cb) => { Object.assign(store, values); if (cb) cb(); }
} } };
const St = u('storage').PromptMeterStorage;
St.addToDictionary('  Kubernetes ', () => {});
St.addToDictionary('kubernetes', () => {});
St.addToDictionary('Priya', () => {});
check('dictionary lowercases and dedupes', JSON.stringify(store.dictionary) === '["kubernetes","priya"]', store.dictionary);
St.removeFromDictionary('PRIYA', () => {});
check('dictionary removes case-insensitively', JSON.stringify(store.dictionary) === '["kubernetes"]', store.dictionary);
for (let i = 0; i < 205; i++) St.addFixReport({ finding: 'f' + i }, () => {});
check('reports capped at 200, newest kept', store.fixReports.length === 200 && store.fixReports[199].finding === 'f204');

// A dictionary word must reach the corrector through `preserve`.
const keptByDict = C.compress('explain recusrion in pyhton', { preserve: new Set(store.dictionary.concat(['recusrion'])) }).text;
has('preserved word survives compress', keptByDict, 'recusrion');

const csv = St.toCSV([{ a: 'say "hi", ok', b: '=SUM(A1)', c: -5 }, { a: 'line\nbreak' }],
    [['a', 'A'], ['b', 'B'], ['c', 'C']]);
check('csv quotes and escapes', csv.split('\r\n')[1] === '"say ""hi"", ok","\'=SUM(A1)","-5"', csv);
check('csv keeps newlines inside a quoted cell', csv.includes('"line\nbreak"'));
check('csv blank for missing', csv.endsWith('"line\nbreak","",""'), csv);
// Event log: batched, capped, formatted, never throwing.
St.log('card', 'suggestion shown', { saved: 5, long: 'x'.repeat(1000) });
St.error('analyze-failed', new Error('boom'));
check('log only queues until flushed', !store.eventLog && St.logQueue.length === 2);
St.flushLog();
check('flush writes the batch', store.eventLog.length === 2 && St.logQueue.length === 0, store.eventLog);
check('long strings are clipped', store.eventLog[0].d.long.length <= 301, store.eventLog[0].d.long.length);
check('errors carry level and message', store.eventLog[1].lvl === 'error' && store.eventLog[1].m === 'boom');
for (let i = 0; i < 1100; i++) St.log('spam', 'n' + i);
St.flushLog();
check('log capped at LOG_MAX, newest kept', store.eventLog.length === St.LOG_MAX
    && store.eventLog[store.eventLog.length - 1].m === 'n1099', store.eventLog.length);
check('formatLog makes one line per entry', St.formatLog(store.eventLog.slice(-2)).split('\n').length === 2
    && /INFO\s+spam\s+n1099$/.test(St.formatLog(store.eventLog.slice(-1))), St.formatLog(store.eventLog.slice(-1)));
global.chrome.runtime = {};   // what an orphaned content script sees after a reload
check('invalidated context reads as unavailable', St.isAvailable() === false);
St.log('x', 'y'); St.flushLog();
check('logging with no context does not throw', true);
St.logQueue.length = 0;
delete global.chrome;

// Casual typing: live screenshots of mangled or missed words.
const Opt = u('optimizer').PromptMeterOptimizer;
const Sp = u('spelling').PromptMeterSpelling;
const fix = (t) => Opt.optimizeWithReport(t, []).text;
[
    ['and i well levee him tomorow', /I will leave him tomorrow/],
    ['i dont no how to wrte this email', /don't know how to write/],
    ['what shud i by for dinner', /should I buy for dinner/],
    ['plz tel me a joke its my birtday', /Tell me a joke.*it's my birthday/],
    ['he dont know what hes doing', /he's doing/],
    ['wich is beter for a studnet', /better.*student/],
    ['can u explane recursion', /Explain recursion/],
    ['write a leter to my frend in canda', /letter to my friend in Canada/],
    ['thank you by the way', /^(?!.*buy).*by the way/i],
    ['as I well know, it rains', /I well know/],
    ['Explain it like I am 5.', /it like I am 5/],
].forEach(([input, want]) => { const got = fix(input); check('casual: ' + input, want.test(got), got); });
// Repetition inside a prompt: phrases, long words, commas, line breaks.
[
    ['Give plant uml code for generating this diagram this diagram Give plant uml code for generating this diagram this diagram',
        'Give PlantUML code for generating this diagram'],
    ['Give plant uml code for this diagram, this diagram', 'Give PlantUML code for this diagram'],
    ['write a function function that sorts a list in python', 'Write a function that sorts a list in Python'],
    ['Explain recursion in python\n\nExplain recursion in python', 'Explain recursion in Python'],
    ['Steps:\n- install node\n- run npm install\n- run npm install\n- start the server',
        '- install node\n- run npm install\n- start the server'],
].forEach(([input, want]) => {
    const got = C.compress(input, { budgetMs: 1e5 }).text;
    check('repeat: ' + input.slice(0, 40), got === want, got);
});
// Not repetition: idioms, a missing full stop, numbers, unfenced code.
[
    'she had had enough of it',
    'create a react component that shows a list of users users can be filtered by name',
    'mix 2 2 cups of flour',
    'for i in range(3):\n    print(i)\n    print(i)',
].forEach((input) => {
    const got = C.compress(input, { budgetMs: 1e5 }).text;
    check('kept: ' + input.slice(0, 40), got.toLowerCase().replace(/\.$/, '') === input.toLowerCase(), got);
});

// Edit levels: three distinct results, each a superset of the one below.
const chatty = 'hey chatgpt so basically i wnat you to plz explain recursion in pyhton, like what it is and how it works, and also i want you to explain it simply because i am a begginer thanks a lot';
const lv = {};
['conservative', 'balanced', 'aggressive'].forEach((m) => { lv[m] = C.compress(chatty, { budgetMs: 1e5, maxMode: m }).text; });
check('Fix keeps the filler but fixes typos', /basically/i.test(lv.conservative) && /Python/.test(lv.conservative)
    && /beginner/.test(lv.conservative), lv.conservative);
check('Trim drops the filler', !/basically|thanks/i.test(lv.balanced) && lv.balanced.length < lv.conservative.length, lv.balanced);
check('Condense is shorter than Trim', lv.aggressive.length < lv.balanced.length, lv.aggressive);
check('Condense says "for a beginner"', /for a beginner/i.test(lv.aggressive), lv.aggressive);
// Real prompts the old sentence-dropping Condense damaged. None may lose a sentence.
[
    'Do you have an accent? I have an Australian accent...',
    'What will political systems look like in the not so near future? Since jobs are being replaced by computers and robots, and now AI there will surely come a time where there will be practically no jobs left. What could such a future look like?',
    'Tools similar to knockoutjs. Give only tool names separated by comma, no description needed.',
    'How would you create a basic http web server using the flask library in python. Make sure this uses python 3 and is set up to be a template.',
].forEach((input) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'aggressive' }).text;
    const first = input.split(/(?<=[.?!])\s+/)[0].replace(/[.?!]$/, '').slice(0, 25).toLowerCase();
    const last = input.split(/(?<=[.?!])\s+/).pop().slice(0, 20).toLowerCase();
    check('Condense keeps every sentence: ' + input.slice(0, 30),
        got.toLowerCase().includes(first) && got.toLowerCase().includes(last.split(' ')[0]) && /make sure|tools|accent|future look/i.test(got), got);
});
const DBMS_PROMPT = 'Please please explain normalization in DBMS for my exam. I have an exam tomorrow on DBMS and I really need to understand normalization in DBMS. Can you please explain 1NF, 2NF, 3NF and BCNF in DBMS with examples? Please explain each normal form with an example table so I can prepare for my DBMS exam. Basically I just want you to explain normalization clearly for the exam.';
const dbmsOut = C.compress(DBMS_PROMPT, { budgetMs: 1e5, maxMode: 'aggressive' }).text;
check('Condense drops a request asked again', (dbmsOut.match(/normalization/gi) || []).length === 1
    && /1NF, 2NF, 3NF and BCNF/.test(dbmsOut) && /table/.test(dbmsOut), dbmsOut);
const St2 = u('storage').PromptMeterStorage;
check('three edit levels map to the three tiers', St2.STRICTNESS.fixes === 'conservative'
    && St2.STRICTNESS.trim === 'balanced' && St2.STRICTNESS.condense === 'aggressive');

// Live ChatGPT testing: worst-case prompts at Trim, exact expected output.
[
    ['wat is teh diffrence btwn ram n rom plz explian in simpel words', 'What is the difference between RAM and ROM explain simply'],
    ['cn u rite a email to my profesor askin for extention on asignment due tmrw', 'Write an email to my professor asking for extension on assignment due tomorrow'],
    ['how 2 make biryani at home step by step 4 beginers', 'How to make biryani at home step by step 4 beginners'],
    ['its raining alot and i could of gone out but i didnt', "It's raining a lot and I could have gone out but I didn't"],
    ['should i by a iphone or a android phone for photography', 'Should I buy an iPhone or an Android phone for photography'],
    ['ok so like basically um i need like a recipe for like pasta you know', 'I need a recipe for pasta'],
    ['PLEASE HELP ME WRITE A COVER LETTER FOR A MARKETING JOB!!!!!', 'Help me write a cover letter for a marketing job!'],
    ['there going to there house over their', "They're going to their house over there"],
    ['me and him went to the store and buyed some milk', 'He and I went to the store and bought some milk'],
    ['the data shows that the results is wrong', 'The data shows that the results are wrong'],
    ['i would of done it if i had knew', 'I would have done it if I had known'],
    ['less people came to the event then expected', 'Fewer people came to the event than expected'],
    ['can you advice me on witch laptop to by', 'Advise me on which laptop to buy'],
    ['i am loosing my mind, please tell me weather to quit', 'I am losing my mind, tell me whether to quit'],
    ['can u tell me wat 2 do if my phone fell in water', 'Tell me what to do if my phone fell in water'],
    ['Hello ChatGPT! I hope you are doing well today. I was wondering if you could possibly help me with something. Could you please kindly write a short poem about friendship? Thank you so much in advance, I really appreciate it!', 'Write a short poem about friendship.'],
    ['Dear AI, I would be extremely grateful if you could take a moment to explain to me what photosynthesis is. Many thanks!', 'Explain photosynthesis.'],
    ["I know you're busy but if it's not too much trouble could you maybe list some good books on stoicism", 'List some good books on stoicism'],
    ['Sorry to bother you again, but can you explain the previous answer once more in simpler words?', 'Explain the previous answer once more in simpler words.'],
    ['As an AI language model, can you tell me the weather tomorrow', 'Tell me the weather tomorrow'],
    ['write a story\nwrite a story about a dragon\nwrite a story about a dragon who is afraid of fire', 'Write a story about a dragon who is afraid of fire'],
].forEach(([input, want]) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'balanced' }).text;
    check('live: ' + input.slice(0, 40), got === want, got);
});
// Things live testing showed must NOT change.
[
    'Translate to Hindi:\nGood morning, how are you?',
    'Proofread my email:\nHi Sir, I want to inform you that i will not come tommorow because i am sick. Kindly grant leave.',
    'Fix the grammar in this text:\nme and my freind goes to school everyday and we has fun',
    'Tell me about Paris. Tell me about Paris history. Tell me about Paris food.',
    'How many minutes is this? 9:15-9:30, 9:30-9:45',
    'i only have 2 days left, explain graph traversal',
    'Can you not be so verbose? Answer in one line: what is HTTP?',
].forEach((input) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'aggressive' }).text;
    const payload = input.includes(':\n') ? input.split(':\n')[1] : null;
    const ok = payload ? got.endsWith(payload)
        : /Paris/.test(input) ? !/\.\s+history\b/i.test(got)
            : /minutes/.test(input) ? /minutes is this/.test(got)
                : /2 days/.test(input) ? /2 days/.test(got) : /can you not be so verbose/i.test(got);
    check('live, unchanged where it matters: ' + input.slice(0, 40), ok, got);
});

// Intense audit: invariants found broken on real prompts.
[
    ['Can you help me with my resume?', 'Help me with my resume.'],
    ['If I were rich, what would I buy?', 'If I were rich, what would I buy?'],
    ['e.g. use numpy for this', 'e.g. use NumPy for this'],
    ['Hi Vicuna! How are you?', 'Hi Vicuna! How are you?'],
    ['Equipment: [None, None, None, None]\nWhat should I craft?', 'Equipment: [None, None, None, None]\nWhat should I craft?'],
    ['Send a text message to a designated contact.\nReceiver: John\nMessage: Hello, how are you?', 'Send a text message to a designated contact.\nReceiver: John\nMessage: Hello, how are you?'],
    ['Arrange the following letters in the correct order to spell out a five letter word.\ng,o,t,o,p', 'Arrange the following letters in the correct order to spell out a five letter word.\ng,o,t,o,p'],
    ["For some reasons I can't open my company's website. I'm sure my internet is working fine as google is open normally. What could be the reason?",
        "For some reasons I can't open my company's website. I'm sure my internet is working fine as Google is open normally. What could be the reason?"],
    ['pls what is phhotosynthesis', 'What is photosynthesis'],
    ['nveer mind, explin photosynthesis instead', 'Never mind, explain photosynthesis instead'],
].forEach(([input, want]) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'balanced' }).text;
    check('audit: ' + input.slice(0, 40), got === want, got);
});
check('audit: "was like," keeps its like', /upbringing was like, who/.test(C.compress('Start with your life (i.e. where you were born, what your upbringing was like, who your parents were, etc).', { budgetMs: 1e5 }).text));
check('audit: compress settles (running it on its own output changes nothing)',
    ['I want to become better at mentoring. Could you describe at least 5 traits of a great mentor? Go in detail about each trait. Provide some examples as well.',
        'hello hello hello is anyone there'].every((p) => {
        const once = C.compress(p, { budgetMs: 1e5, maxMode: 'aggressive' }).text;
        return C.compress(once, { budgetMs: 1e5, maxMode: 'aggressive' }).text === once;
    }));
check('audit: real words the lists lack are left alone', ['caching', 'memoization'].every((w) => Sp.correctWord(w) === null));

// Round 2 personas: slight errors each persona makes, at Fix level.
[
    ["he don't know python very well, explain classes to him", "doesn't know"],
    ['i need some advices on how to prepare for interview', 'some advice on'],
    ['we discussed about the project yesterday, write minutes', 'discussed the project'],
    ['he is married with a doctor, write a wedding wish', 'married to'],
    ['i am knowing the basics of java, what next', 'I know the basics'],
    ['one of my friend want to learn guitar', 'one of my friends wants'],
    ['i have went to paris last year, write a travel blog intro', 'I went to Paris last year'],
    ['write a email to my boss saying i will be late to day', 'late today'],
    ['what is the different between affect and effect', 'the difference between'],
    ['can you right a poem about the ocean', 'write a poem'],
    ['lets meet at 5 pm, draft a calendar invite', "Let's meet"],
    ['can you explain the defiantly important parts of the contract', 'definitely important'],
    ['draft a non disclosure agreement between two companys', 'two companies'],
    ['make a 4 week workout plan to loose 5 kg', 'lose 5 kg'],
    ['create a lesson plan for teaching fractions to class 4 students, 40 minutes', 'class 4 students'],
    ['give me a study timetable for neet preparation', 'NEET'],
    ['is it ok to eat eggs everyday', 'is it ok to eat'],
    ['which fertilizer is best for coconut trees in kerala', 'Kerala'],
    ['HOW DO I MAKE THE LETTERS BIGGER ON MY PHONE', 'How do I make the letters bigger on my phone'],
].forEach(([input, want]) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'conservative' }).text;
    check('round 2: ' + input.slice(0, 40), got.toLowerCase().includes(want.toLowerCase())
        && (want === want.toLowerCase() || got.includes(want)), got);
});
check('round 2: role labels keep their case',
    /\nuser: /.test(C.compress('complete the answer. repeating is not allowed.\nuser: descriptive answer for python\nassistant:', { budgetMs: 1e5, maxMode: 'conservative' }).text));
check('round 2: clear questions get no "unclear request" advice',
    ['how many hours of sleep does an adult need', 'wifi keeps disconnecting every few minutes on my windows 11 laptop',
        'is it safe to drink water from the tap in goa', 'the api returns 401 even tho the token is valid']
        .every((p) => !A.analyze(p, []).findings.some((f) => /Does not clearly state/.test(f.explanation || ''))));

// The screenshot case and its relatives: two-letter drops, words that are real but
// wrong in context, tool names, two requests typed as one.
[
    ['expalin a diffent type of ml+flat explain ai', 'Explain a different type of ML+flat. Explain AI'],
    ['write a pyhton progam to revrse a strng', 'Write a Python program to reverse a string'],
    ['tell me abut nural netwroks and deep lerning', 'Tell me about neural networks and deep learning'],
    ['how dose a compter work', 'How does a computer work'],
    ['whats the diffcult part of lerning calculas', "What's the difficult part of learning calculus"],
    ['pls explan the informtion in this tabel', 'Explain the information in this table'],
    ['explain recursion give examples', 'Explain recursion. Give examples'],
    ['write a function that sorts a list in python', 'Write a function that sorts a list in Python'],
    ['Please explain this again. I did not understand. Please explain this again simply.', 'Explain this again. Explain this again simply.'],
].forEach(([input, want]) => {
    const got = C.compress(input, { budgetMs: 1e5, maxMode: 'balanced' }).text;
    check('similar: ' + input.slice(0, 40), got === want, got);
});
check('similar: tool names are not typos', ['deno', 'vite', 'pnpm', 'kubectl'].every((w) => Sp.correctWord(w) === null));
check('similar: two-letter drops resolve', [['diffent', 'different'], ['probly', 'probably'], ['diffcult', 'difficult'], ['informtion', 'information']]
    .every(([t, w]) => Sp.correctWord(t) === w));

// Title-case typos: capitalised words mid-sentence were skipped as names.
const para = 'Artificial Inelligence + Machine Learing ar important technologies in today’s world. AI can help students + teachers sae tie, but it can also creat problems - especially when peple depend on it too mch. Technology > traditional mehods in sme situations, while traditional learning > technology in othrs.';
const paraOut = C.compress(para, { budgetMs: 1e5, maxMode: 'conservative' }).text;
check('title case: every typo in the screenshot paragraph fixed',
    ['Artificial Intelligence', 'Machine Learning are important', 'save time', 'create problems', 'people depend', 'too much',
        'traditional methods', 'some situations', 'in others'].every((w) => paraOut.includes(w)), paraOut);
check('title case: names are never corrected',
    ['Valentina', 'Angelin', 'Sreesan', 'Adwaith', 'Rajagiri', 'Matthews', 'Harrison', 'Kathryn', 'Thiruvananthapuram']
        .every((n) => C.compress('Please write a short note to ' + n + ' about the meeting.', { budgetMs: 1e5, maxMode: 'conservative' }).text.includes(n)));
check('title case: AR stays AR', C.compress('the AR headset is new', { budgetMs: 1e5 }).text.includes('AR headset'));

check('wikipedia misspelling list is loaded', Sp.correctWord('compatable') === 'compatible'
    && Sp.correctWord('adres') === 'address', [Sp.correctWord('compatable'), Sp.correctWord('adres')]);
check('undoubled stem is not a form of the word', Sp.correctWord('beter') === 'better');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
