/**
 * Builds utils/attested-words.js: words real users typed that the spelling dictionary
 * does not list, which the corrector must therefore never "fix".
 *
 *     node ml/build_attested.js [--min-docs 4] [--dry]
 *
 * WHY. The dictionary has ~10k words, so every other English word looked like a typo:
 * live testing on real prompts turned "toes" into "ties", "exerts" into "experts",
 * "bot" into "both" and "risky" into "ricky". A word that shows up in several separate
 * prompts is a word, whatever the dictionary says.
 *
 * TWO GUARDS keep real typos out of the list:
 *   1. It must appear in at least --min-docs (default 3) distinct prompts.
 *   2. If the corrector would change it, the correction must NOT be vastly commoner.
 *      "recieve" is attested too, but "receive" appears 40x as often; "toes" and "ties"
 *      are in the same league. A ratio under MAX_TYPO_RATIO marks a common misspelling.
 *
 * Attested words are exempt from correction but are never correction TARGETS: they are
 * not added to the skeleton or delete indexes, so the list can only ever stop a change.
 */
const fs = require('fs');
const path = require('path');
const { PromptMeterSpelling: S } = require('../utils/spelling.js');
const { PromptMeterOptimizer: O } = require('../utils/optimizer.js');

const args = process.argv.slice(2);
const MIN_DOCS = args.includes('--min-docs') ? Number(args[args.indexOf('--min-docs') + 1]) : 3;
// Calibrated on known misspellings: teh 0.0002, thier 0.0009, wich 0.0023 against
// real words steep 0.010, habe 0.006, sich 0.069, toes 1.0.
const MAX_TYPO_RATIO = 0.005;
const CORPUS = path.join(__dirname, 'corpus', 'sample.jsonl');
const OUT = path.join(__dirname, '..', 'utils', 'attested-words.js');

const docs = new Map();
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    const words = new Set((String(row.prompt || '').toLowerCase().match(/\b[a-z][a-z']{2,19}\b/g) || [])
        .map((w) => w.replace(/'s$|'$/, '')).filter((w) => !w.includes("'")));
    words.forEach((w) => docs.set(w, (docs.get(w) || 0) + 1));
}

// Known misspellings the optimizer's own tables correct must stay correctable.
const tables = new Set(Object.keys(Object.assign({}, O.spellingTypos || {}, O.chatSlangMap || {},
    O.politenessTypos || {})).map((k) => k.toLowerCase()));

// A curated list of correctly spelled English (pyspellchecker's, 160k words, typos
// excluded). Corpus frequency alone cannot tell "sane" from "shoud"; this can. Needs
// `pip install pyspellchecker` at build time only -- nothing new ships.
const { execSync } = require('child_process');
const english = JSON.parse(execSync('python -c "import json;from spellchecker import SpellChecker;'
    + 'd=SpellChecker().word_frequency.dictionary;'
    + 'print(json.dumps(sorted(d, key=lambda w: -d[w])))"', { maxBuffer: 64 * 1024 * 1024 }).toString());
const correctlySpelled = new Set(english);
const TOP_ENGLISH = 50000;

// Code-mixed prompts ("bhai mujhe python samjhao pls, kal exam hai") are common, and
// their native words are not English typos: live testing turned "kal" into "karl".
// Romanized Hindi/Urdu, Malayalam, Tamil and Indian-English words that the corpus is
// too English-heavy to attest on its own. Protected from correction; never targets.
const CODE_MIXED = (
    // Hindi / Urdu (romanized)
    'hai hain tha thi the kal aaj abhi mujhe mujhko mera meri mere tera teri tere apna apni aap aapka aapki '
    + 'tum tumhara hum humara kya kyu kyun kyon kaise kaisa kaisi kab kahan kaha kitna kitne kaun kuch '
    + 'nahi nahin mat haan han ji bhai yaar yar acha accha achha theek thik sahi galat bahut bohot bohut '
    + 'thoda zyada jaldi samjhao samjha samjhaiye batao bataiye bata sikhao sikha likho likhiye banao '
    + 'banaiye dikhao karo kariye kar karna chahiye chahta chahti hoga hogi raha rahi rahe wala wali '
    + 'lekin aur ya bhi toh sirf matlab mein mei se ko ka ki ke ne par pe wo woh ye yeh isko usko '
    + 'dost ghar kaam paisa pyaar dil log baat din raat subah shaam padhai pariksha '
    // Malayalam (romanized / Manglish)
    + 'chetta chettan chechi enikku ente njan nee ningal avan aval avar entha enthu enthanu engane '
    + 'evide eppol ippo sheri shari venam venda alle aano aanu illa undo onnu randu paranju parayamo '
    + 'cheyyamo cheyyu tharamo thaa nokku mone mole machane machan adipoli kollam pinne athu ithu '
    // Tamil (romanized)
    + 'enna epdi eppadi enga yenna romba nalla illai irukku sollu solunga panni pannunga theriyuma '
    + 'thambi anna akka macha machi da di '
    // Indian English
    + 'prepone timepass lakh lakhs crore crores rupee rupees kindly revert needful updation'
).split(/\s+/).filter((w) => w.length >= 2);

const attested = new Set(CODE_MIXED.filter((w) => !S.known(w)));
const rejected = [];
// 1. Common English the dictionary lacks: "exerts" is rare in prompts but a word.
english.slice(0, TOP_ENGLISH).forEach((word) => {
    if (/^[a-z]{3,20}$/.test(word) && !S.known(word) && !tables.has(word)) attested.add(word);
});
// 2. What real users typed: product words ("bot"), other languages ("como", "habe").
for (const [word, n] of docs) {
    if (n < MIN_DOCS || S.known(word) || tables.has(word) || attested.has(word)) continue;
    const fix = correctlySpelled.has(word) ? null : S.resolve(word);
    if (fix) {
        const ratio = n / Math.max(1, docs.get(fix) || 0);
        if (ratio < MAX_TYPO_RATIO) { rejected.push(`${word}->${fix} (${n}/${docs.get(fix) || 0})`); continue; }
    }
    attested.add(word);
}
const sorted = [...attested].sort();

// Wikipedia's list of common English misspellings ("For machines", ~4,300 pairs). A
// typo there is looked up rather than guessed: the skeleton ranking turned "adres"
// into "acres" and "compatable" into "comparable". Only pairs that cannot hurt:
// the typo is no word in any list here, the fix is one lowercase word the corrector
// already knows, and ambiguous entries ("abotu->about, abbot") are left to ranking.
const WIKI = 'https://en.wikipedia.org/w/index.php?title=Wikipedia:Lists_of_common_misspellings/For_machines&action=raw';
const misspellings = {};
execSync(`curl -sL "${WIKI}"`, { maxBuffer: 16 * 1024 * 1024 }).toString().split('\n').forEach((line) => {
    const m = line.trim().match(/^([a-z]{4,})->([a-z]+)$/);
    if (!m) return;
    const [, typo, fix] = m;
    if (['lsat', 'planation', 'nowe'].includes(typo)) return; // real in context: exam, typo of explanation, Polish
    if (S.known(typo) || attested.has(typo) || correctlySpelled.has(typo) || S.formOfKnown(typo)) return;
    if (!(S.known(fix) || attested.has(fix) || S.formOfKnown(fix) || correctlySpelled.has(fix))) return;
    misspellings[typo] = fix;
});
console.log(Object.keys(misspellings).length, 'misspellings kept');

console.log(`${docs.size} distinct words, ${sorted.length} attested, ${rejected.length} rejected as typos`);
console.log('sample rejected:', rejected.slice(0, 25).join(', '));
['toes', 'exerts', 'bot', 'risky', 'como', 'habe', 'genera', 'erotic', 'sentience', 'sane', 'lust', 'teh', 'thier', 'recieve', 'definately', 'shoud'].forEach((w) =>
    console.log(`  ${w}: docs=${docs.get(w) || 0} attested=${attested.has(w)}`));

if (!args.includes('--dry')) {
    fs.writeFileSync(OUT, [
        '// GENERATED by ml/build_attested.js from the LMSYS/BPO prompt sample. Do not edit;',
        '// rerun the script. Words real users typed that utils/spelling.js does not list:',
        '// the corrector leaves them alone, and never corrects anything INTO them.',
        'const PM_ATTESTED_WORDS = ' + JSON.stringify(sorted.join(' ')) + ';',
        "// Common misspelling -> fix, from Wikipedia's machine-readable list.",
        'const PM_MISSPELLINGS = ' + JSON.stringify(misspellings) + ';',
        "if (typeof window !== 'undefined') { window.PM_ATTESTED_WORDS = PM_ATTESTED_WORDS; window.PM_MISSPELLINGS = PM_MISSPELLINGS; }",
        "if (typeof module !== 'undefined' && module.exports) module.exports = { PM_ATTESTED_WORDS, PM_MISSPELLINGS };",
        ''
    ].join('\n'));
    console.log('wrote', path.relative(process.cwd(), OUT), (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
}
