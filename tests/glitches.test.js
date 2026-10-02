/**
 * Glitches found by running real prompts through compress() and diffing what was lost.
 *
 *     node tests/glitches.test.js
 *
 * Each case is a prompt that once came back missing half its meaning -- the second
 * request after a connector, the premises of a puzzle, the subject of an exam -- or
 * that was left untouched when an obvious saving was there.
 */

const path = require('path');

['attested-words', 'protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer', 'analysis', 'compress'].forEach((name) => {
    Object.assign(global, require(path.join(__dirname, '..', 'utils', name + '.js')));
});

const C = PromptMeterCompress;
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
    if (ok) passed++;
    else { failed++; console.log('FAIL  ' + name + (detail ? '\n      got ' + JSON.stringify(detail) : '')); }
};
const run = (prompt) => C.compress(prompt, { budgetMs: 1e5 });
const keeps = (name, prompt, ...parts) => {
    const out = run(prompt).text;
    check(name, parts.every((p) => (p instanceof RegExp ? p.test(out) : out.includes(p))), out);
};
const lacks = (name, prompt, rx) => {
    const out = run(prompt).text;
    check(name, !rx.test(out), out);
};
const saves = (name, prompt, atLeast) => {
    const r = run(prompt);
    check(name, r.tokens.saved >= atLeast, r.tokens.original + ' -> ' + r.tokens.optimized + ': ' + r.text);
};

// ---------------------------------------------------------------------------
// The second half of a connector
// ---------------------------------------------------------------------------
keeps('"and also explain" keeps its verb',
    'Can you translate this into Spanish and also explain the grammar used?', 'Translate', 'explain the grammar');
keeps('"and also explain it" keeps its verb',
    'can u write a code for calculator in c++ and also explain it line by line', 'explain it line by line');
keeps('a goal behind "but ... so can you" keeps the goal and the request',
    "I want to learn React but I don't know where to start, so can you give me a roadmap?", 'learn React', /roadmap/i);
lacks('...and is not rewritten into "Explain React but"',
    "I want to learn React but I don't know where to start, so can you give me a roadmap?", /Explain React/);
keeps('"and so can you suggest" is a request of its own',
    'My laptop is slow and so can you suggest ways to speed it up?', 'laptop is slow', /[.;] suggest ways/i);
check('the validator catches a dropped second request',
    !C.validate('Translate this and also explain the grammar.', 'Translate this and the grammar.').valid);

// ---------------------------------------------------------------------------
// Circumstance goes, its subject stays
// ---------------------------------------------------------------------------
keeps('exam subject survives', 'I have an exam tomorrow on operating systems so please explain deadlocks and also paging and segmentation.',
    /operating systems/i, 'deadlocks', 'paging', 'segmentation');
keeps('viva subject survives despite a trailing "next week"',
    'I have a viva on computer networks next week, give me important questions', /computer networks/i);
keeps('a deadline the advice must fit survives',
    'Can you give advice on how to read the required readings for school? I need to finish it all in a month.', 'in a month');
lacks('a clause is not cut mid-phrase', 'I am looking for a new job. Everybody is hiring and I am tired of the retail management position I have been in for the last 5 years. I want to do a professional resume from scratch.',
    /hiring the last/);
keeps('a subordinate clause keeps its main clause',
    'When approaching a technical problem which I am not familiar with, I feel scared for a bit. How would a good method for me to approach these problems?',
    /familiar with, I feel/);
keeps('a worry that IS the question survives',
    "Is Doyle the better author if his books weigh more? I'm worried that a pan balance may not be accurate enough and I should use a digital scale. What do you think?",
    'pan balance');
keeps('the thing "it" refers to survives',
    'I forgot the password to my phone, is there a way to get it unlocked?', 'phone');

// ---------------------------------------------------------------------------
// Premises are not backstory
// ---------------------------------------------------------------------------
keeps('a word problem keeps its setup',
    'in a coin toss game, you bet with a coin. if you win, you will get a coin. If you lose, the bet coin will be taken from you. What is the expected value?',
    /coin toss game/i, /if you win/i, /if you lose/i);
keeps('a puzzle keeps every step',
    'A carton has six eggs. Two are added. Then one is taken out and eaten. How many eggs are left?', 'Two are added');
keeps('a short story question keeps the story',
    "We're standing on opposite sides of a one-way mirror. I see you, and you see your reflection. We switch sides. What does each of us see?",
    'We switch sides', 'your reflection');
keeps('"How is that" keeps what "that" is',
    'I have had dengue fever and I have been told that the chances of getting a more deadly version is much higher the second time around. How is that and am I affected by this for life?',
    'dengue');
keeps('an instruction opening with a preposition is not a fragment',
    "For the given input text, label the sentiment of the text as positive or negative. The answer should be exactly 'positive' or 'negative'.",
    'label the sentiment');
keeps('a premise opening "In addition" survives',
    'For a healthy lifestyle, exercise and eat well. In addition, intermittent fasting is considered crucial for health, partly because it boosts autophagy. How does autophagy contribute to a healthy lifestyle?',
    'intermittent fasting');
keeps('a claim the user wants checked survives',
    "What is the safest way to clean your ears? I've read that using hydrogen peroxide is the best way, but I'm not sure.", 'hydrogen peroxide');
keeps('facts for personal advice survive',
    "I've been looking to get a raise at my job. My work ethic is very high and I always deliver on tasks. What should I say to my boss to secure a raise?",
    'work ethic');
keeps('a stated goal with its constraints survives',
    'I want to remotely control my RaspberryPi from kilometers away and independent from mobile service, so i had LoRa as a idea. How would i be able to get a shell to my RaspberryPi via LoRa?',
    'kilometers');
keeps('"Provide some examples" is a request', 'Could you describe at least 5 traits of a great mentor? Go in detail about each trait. Provide some examples as well.',
    /Provide (?:some )?examples/);
keeps('"Let\'s play chess." is the request', "Let's play chess. I'll type my move in chess notation, and you'll respond with your move.", "Let's play chess");
keeps('"You will ..." is an instruction', 'I want you to act as a drunk person. You will only answer like a drunk person texting. You will also randomly ignore what I said and say something random. Do not write explanations.',
    'randomly ignore');

keeps('every answer option survives',
    'When an igneous intrusion comes into contact with surrounding rock, the surrounding rock will (A) erode. (B) foliate. (C) precipitate. (D) recrystallize.',
    '(B) foliate', '(C) precipitate', '(D) recrystallize');
keeps('the problem survives "Please help me"',
    "Pretend to be customer support for Apple. I am an old lady, and my phone screen has just gone blank. I'm not able to turn it on. Please help me.",
    'gone blank', 'turn it on');
keeps('a subjectless request keeps its subject',
    'i am doing a project on twitter sentiment analysis from comment. Can you write a conclusion for me', /twitter sentiment analysis/i);
keeps('a question about the user keeps what they said about themselves',
    'I like watching comedy and intellectual movies. What rating between 0 and 5 would I give to the movie The Exorcist?', 'comedy');
keeps('a premise sharing the subject survives the classifier',
    'I love to eat fruit, especially apples. Sometimes I have apple cores sitting out after I eat some. Why do the apple cores change color so quickly?',
    'sitting out');
keeps('"Initiate a story." is the request', 'Initiate a story. Use lots of details and add some dialog.', 'Initiate a story');
keeps('what the user already has survives',
    'It is a web app that tracks expenses. I have a users table and a transactions table but I am not sure if that is enough. Help me design a proper database schema.',
    'users table');

keeps('the confusion names the subject',
    'i dont understand pointers in c can u explain it simply and also tell where its used', /pointers in c/i, /tell where/i);
keeps('"I don\'t understand X, explain it" becomes "Explain X"',
    "I don't understand recursion, can you explain it with an example?", /^Explain recursion/);
keeps('"struggling to" keeps what the user is struggling with',
    'I have an architecture project about a bioenergy plant. I am struggling to come up with a creative name for this project, do you have any ideas?',
    'creative name');
keeps('"difference btw" is "between"', 'can you tell me difference btw ram and rom and also cache memory', 'between RAM and ROM');
lacks('"btw" as filler goes', 'btw can you explain recursion', /by the way/i);
keeps('"bro" goes, the viva subject stays', 'bro i have viva tmrw on dbms so tell me imp questions and also answers for them', /^DBMS:/);
keeps('"Broadcast" is not "bro"', 'Broadcast this message to all users in Python', 'Broadcast');

keeps('a preference behind "recommend I" survives',
    "I love classical piano music, but I feel like I've already heard all the greats. Are there any modern pianists you would recommend I listen to?",
    'classical piano');
keeps('the sentence to categorise survives', 'Categorize this sentence as one of these sentiments; anger, joy, sadness, disgust. I am so proud of the work I did today.',
    'proud of the work');
keeps('the claim behind "Is this true?" survives', "My brother says you shouldn't put butter on a burn. Is this true?", 'butter on a burn');
keeps('what "it" is survives', 'My hair is damaged due to hair dye. What is the best product to restore it?', 'hair dye');
keeps('"Introduce yourself." is the request', "Let's switch roles. I'll be the language model and you be the human. Introduce yourself.", 'Introduce yourself');
keeps('an "Ideally" preference survives', "What's an inexpensive food I can bring to work? Ideally I would want something healthy and not too messy to prepare.",
    'not too messy');
keeps('a fact the plan must fit survives', 'give me 2 challenges for a solo japan trip to work on social anxiety. I don\'t know any japanese.',
    /don't know any Japanese/i);
keeps('"I will say ..." is an instruction', "Write a story. Start writing. I will say to you then when is the end and not you. Write with dialogues.",
    'I will say');

keeps('a first-person puzzle keeps every move',
    'I have two quarters and a ball. I place the ball in a cup, and place the cup in my room. I take the quarters and place them in my kitchen. Now I take the cup and place it next to the quarters. I put the quarters in the cup. Where is the cup, and how many items are in it?',
    'Now I take the cup', 'I put the quarters in the cup');
keeps('persona traits survive', 'You are NAME_1. You are 30 years old. You live in France. You are outgoing. You are talkative. Introduce yourself.',
    'You are outgoing', 'You are talkative');
keeps('a three-word sentence is not a fragment', "help me invent a cocktail for mother's day - my mom enjoys mixing drinks. she prefers gin", /prefers gin/i);
keeps('"Be super succinct." is an instruction', 'Give some insight in how to understand love. Be super succinct.', 'Be super succinct');
keeps('what "that" stands for survives', 'I am thinking about changing my college major to computer science. What kinds of jobs would that lead to?',
    'computer science');
check('Norwegian is declined, not mangled', run('Har man rett på fri med lønn for å amme barnet sitt i norge?').status === C.STATUS.UNSUPPORTED_LANGUAGE);
check('English with "café" is still English', run('Can you recommend a good café near the office and explain why it is good?').status === C.STATUS.SUCCESSFUL);

// Found live on chatgpt.com
keeps('"and also how" stays joined to its request',
    'I have a job interview tomorrow so give me common HR questions and also how to answer them', 'questions and how to answer them');
lacks('...with no stray stop', 'I have a job interview tomorrow so give me common HR questions and also how to answer them', /\. How|also\./);
keeps('"not only ... but also" becomes "and"', 'Not only explain the theory of relativity but also give real world examples',
    'Explain the theory of relativity and give real world examples');
keeps('"as well as" becomes "and"', 'List the causes of World War 2 as well as the major turning points', 'causes of World War 2 and the major');
keeps('"as well as you can" is not a connector', 'Do it as well as you can', 'as well as you can');
keeps('a real inflection is not "corrected"', 'Debug my code: it compiles but the output is wrong', 'it compiles');
keeps('"companys" is still a typo', 'draft an agreement between two companys', 'two companies');
keeps('"What are X and when ...?" stays a question', 'What are the symptoms of diabetes and when should I see a doctor?', /^What are the symptoms/);
check('the card keeps a list on separate lines', /white-space:\s*pre-wrap/.test(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'content.css'), 'utf8')
        .split('.promptmeter-diff-box {')[1].split('}')[0]));

// ---------------------------------------------------------------------------
// Wording that changed the meaning
// ---------------------------------------------------------------------------
keeps('"as soon as possible" inside the goal stays',
    'I have a huge student debt, what do you think I should do to pay it as soon as possible?', 'as soon as possible');
keeps('"feel free to" stays a permission', 'Use 63% as the rate. Feel free to alter this value if it is incorrect.', /may alter/i);
keeps('"Expand on that." keeps its object', 'Tell me about Martin Luther. What is important about him? Expand on that.', 'Expand on that');
keeps('"if possible." keeps the full stop', 'Is it a myth? Please explain with scientific evidence if possible.', /evidence\.$/);
lacks('"and I\'ve" is not "and me\'ve"', "My company is moving to California and I've been looking at apartments there.", /me've/);
keeps('"haven\'t we seen" stays "seen"', 'why havent we seen aliens yet?', "haven't we seen");
keeps('"Suppose" keeps a hypothesis hypothetical', 'Suppose the universe is infinitely big. Does that mean you will travel forever?', /^Suppose/);
keeps('"Imagine" keeps a role imagined', 'Imagine you are self-aware. What would you tell the world?', /^Imagine/);
lacks('spacing alone is not shipped as a correction', 'Write an intro for a company at Thane-Belapur Road, P.O. - Vashi', /P\. O\./);

keeps('".wav" is a file type, not a full stop', 'please write a program in C that scans a sound sample from .wav file', 'from .wav file');
keeps('".env" is a file name', 'bash one-liner: export all values from .env file', 'from .env file');
keeps('key files keep their names', 'openssl command to encrypt file.txt with a.pem which is the public key and b.pem which is private key',
    'a.pem', 'b.pem which is');
keeps('"However," opens a sentence', 'I will come home by 4pm. However, I need to study about 1 hour in between. How much time do I have?', '4pm. However, I need');
keeps('"If so," opens a sentence', 'Is it true that royal families in Europe practiced incest? If so, what are some examples from history?', 'If so, what');

// ---------------------------------------------------------------------------
// Spelling that broke names and protocols
// ---------------------------------------------------------------------------
keeps('"wss" is a protocol', 'assume i am blocked to communicate via the wss protocol. is there a way to still reach the server', 'wss');
keeps('"fiverr" is a site', 'give me a list of top rated fiverr logo designers', 'fiverr');
keeps('"thos" is "those"', 'write a text about social media, give a list of advices to avoid thos dangers', 'those dangers');

// ---------------------------------------------------------------------------
// Savings that were left on the table
// ---------------------------------------------------------------------------
check('a snake_case identifier no longer blocks compression',
    run('Hello! Could you please explain how to use the API_KEY variable in my Python script? Thanks!').status === C.STATUS.SUCCESSFUL);
saves('"give me a detailed explanation" compresses',
    'Could you give me a detailed explanation about how neural networks work, including what neurons are and how training works?', 4);
saves('a subject named three times is named once',
    'Can you please tell me what are the main causes of global warming and what are the effects of global warming on the environment and what can we do to reduce global warming?', 8);
saves('"in a very simple way" becomes "simply"',
    'I am a beginner, so can you please explain to me what is an API and how does it work in a very simple way?', 8);
saves('"and then ... and then" loses its "and"s',
    'Please write a Python program that takes a list of numbers as input and then calculates the sum and then prints it.', 3);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
