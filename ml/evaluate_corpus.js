/**
 * Measures PromptMeter's scorer and optimizer against the reference corpus.
 *
 *     node ml/evaluate_corpus.js [path/to/sample.jsonl]
 *
 * Produces ml/corpus_eval.json and prints a summary. It changes nothing: no model is
 * retrained, no threshold is tuned, no file in utils/ is touched.
 *
 * THREE THINGS ARE MEASURED, AND ONLY ONE OF THEM USES BPO AS AN AUTHORITY.
 *
 * 1. BEHAVIOUR. Score distribution and which rules actually fire, over 14k real
 *    prompts rather than the handful in the unit tests. A rule that never fires on
 *    real input is dead weight; one that fires on nearly everything is a tax, not a
 *    signal.
 *
 * 2. AGREEMENT WITH BPO. BPO pairs a prompt with a rewritten version judged to produce
 *    better answers. That is an independent opinion that the original had something
 *    wrong with it -- not a quality score, and not a target to fit. So the only claim
 *    made from it is directional: if PromptMeter's scorer detects real weakness, the
 *    original should not score HIGHER than the rewrite more often than chance.
 *
 *    This is deliberately weak evidence and is reported as such. BPO's rewrites mostly
 *    ADD specificity, and PromptMeter scores brevity, so the two disagree by
 *    construction on length. The number worth watching is not the headline agreement
 *    rate but the subset where BPO's rewrite is no longer than the original.
 *
 * 3. PRESERVATION. The optimizer is run over every prompt and the output checked for
 *    things that must never be lost: numbers, operators, code spans, URLs. This one
 *    needs no ground truth at all -- dropping a constraint is wrong whatever any
 *    dataset says -- so it is the strongest signal in the file.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer'].forEach((name) => {
    Object.assign(global, require(path.join(ROOT, 'utils', name + '.js')));
});

const O = PromptMeterOptimizer;
const SAMPLE = process.argv[2] || path.join(__dirname, 'corpus', 'sample.jsonl');
const OUT = path.join(__dirname, 'corpus_eval.json');

if (!fs.existsSync(SAMPLE)) {
    console.error('No sample at ' + SAMPLE);
    console.error('Run: python ml/ingest.py --export-jsonl ml/corpus/sample.jsonl');
    process.exit(1);
}

const rows = fs.readFileSync(SAMPLE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

console.log('Loaded ' + rows.length + ' prompts from ' + path.basename(SAMPLE));

// --- what must survive an optimization -------------------------------------------
// Each returns the set of things of its kind found in a piece of text. A token present
// in the input and missing from the output is a loss, whatever else improved.
const SURVIVORS = {
    numbers: (t) => (t.match(/\b\d+(?:\.\d+)?\b/g) || []),
    operators: (t) => (t.match(/[<>]=?|!=|==|[+\-*/%^]=?/g) || []),
    code: (t) => (t.match(/`[^`\n]+`|```[\s\S]*?```/g) || []),
    urls: (t) => (t.match(/https?:\/\/\S+/g) || []),
    // Quoted spans are the user's own words and are protected for the same reason.
    quoted: (t) => (t.match(/"[^"\n]{3,}"/g) || []),
};

function lost(before, after, kind) {
    const had = SURVIVORS[kind](before);
    if (had.length === 0) return [];
    const remaining = SURVIVORS[kind](after).slice();
    const missing = [];
    had.forEach((item) => {
        const at = remaining.indexOf(item);
        if (at === -1) missing.push(item);
        else remaining.splice(at, 1);
    });
    return missing;
}

const scores = [];
const flagCounts = {};
const byCategory = {};
const losses = { numbers: 0, operators: 0, code: 0, urls: 0, quoted: 0 };
const lossExamples = [];
let errors = 0;
let emptyOutput = 0;

// BPO direction: does the scorer rate the rewrite at least as highly as the original?
let pairs = 0;
let originalLower = 0;
let equalScore = 0;
let originalHigher = 0;
// The fairer subset: pairs where BPO did not simply make the prompt longer.
let fairPairs = 0;
let fairOriginalLower = 0;
let fairOriginalHigher = 0;

rows.forEach((row) => {
    let analysis;
    let optimized;
    try {
        analysis = O.analyzePrompt(row.prompt);
        optimized = O.optimizeWithReport(row.prompt).text;
    } catch (err) {
        errors++;
        return;
    }

    scores.push(analysis.score);
    (analysis.flags || []).forEach((flag) => {
        const label = flag.replace(/\s*\(-\d+ pts\)$/, '');
        flagCounts[label] = (flagCounts[label] || 0) + 1;
    });

    const category = row.task_category || 'other';
    byCategory[category] = byCategory[category] || { n: 0, total: 0 };
    byCategory[category].n++;
    byCategory[category].total += analysis.score;

    if (!optimized || !optimized.trim()) emptyOutput++;

    Object.keys(SURVIVORS).forEach((kind) => {
        const missing = lost(row.prompt, optimized || '', kind);
        if (missing.length) {
            losses[kind]++;
            if (lossExamples.length < 25) {
                lossExamples.push({
                    kind: kind,
                    lost: missing.slice(0, 4),
                    prompt: row.prompt.slice(0, 160),
                    optimized: (optimized || '').slice(0, 160),
                });
            }
        }
    });

    if (row.optimized_prompt) {
        let rewriteScore;
        try {
            rewriteScore = O.analyzePrompt(row.optimized_prompt).score;
        } catch (err) {
            return;
        }
        pairs++;
        if (analysis.score < rewriteScore) originalLower++;
        else if (analysis.score === rewriteScore) equalScore++;
        else originalHigher++;

        if (row.optimized_prompt.length <= row.prompt.length) {
            fairPairs++;
            if (analysis.score < rewriteScore) fairOriginalLower++;
            else if (analysis.score > rewriteScore) fairOriginalHigher++;
        }
    }
});

scores.sort((a, b) => a - b);
const pick = (q) => scores[Math.floor(scores.length * q)];
const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);

const report = {
    generatedAt: new Date().toISOString(),
    sample: path.basename(SAMPLE),
    rows: rows.length,
    errors: errors,
    scoreDistribution: {
        mean: Number(mean.toFixed(2)),
        min: scores[0],
        p10: pick(0.10),
        median: pick(0.50),
        p90: pick(0.90),
        max: scores[scores.length - 1],
        perfect: scores.filter((s) => s === 100).length,
        perfectPct: Number((100 * scores.filter((s) => s === 100).length / scores.length).toFixed(1)),
    },
    flagFrequency: Object.keys(flagCounts)
        .sort((a, b) => flagCounts[b] - flagCounts[a])
        .reduce((acc, k) => { acc[k] = flagCounts[k]; return acc; }, {}),
    meanScoreByCategory: Object.keys(byCategory).sort().reduce((acc, k) => {
        acc[k] = Number((byCategory[k].total / byCategory[k].n).toFixed(1));
        return acc;
    }, {}),
    preservation: {
        note: 'Counts prompts where something that must survive did not. No ground '
            + 'truth needed: these are losses regardless of what any dataset says.',
        promptsWithLoss: losses,
        emptyOptimizerOutput: emptyOutput,
        examples: lossExamples,
    },
    bpoAgreement: {
        note: 'Directional only. BPO says the rewrite produces better answers, which is '
            + 'evidence the original had a weakness -- not a quality score. BPO mostly '
            + 'ADDS words while PromptMeter scores brevity, so the two disagree on '
            + 'length by construction; read sameLengthOrShorter, not the headline.',
        pairs: pairs,
        originalScoredLower: originalLower,
        sameScore: equalScore,
        originalScoredHigher: originalHigher,
        sameLengthOrShorter: {
            pairs: fairPairs,
            originalScoredLower: fairOriginalLower,
            originalScoredHigher: fairOriginalHigher,
        },
    },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('');
console.log('SCORES   mean ' + report.scoreDistribution.mean
    + '  median ' + report.scoreDistribution.median
    + '  p10 ' + report.scoreDistribution.p10
    + '  p90 ' + report.scoreDistribution.p90
    + '  |  100/100: ' + report.scoreDistribution.perfectPct + '%');
console.log('');
console.log('TOP FLAGS');
Object.keys(report.flagFrequency).slice(0, 12).forEach((k) => {
    const n = report.flagFrequency[k];
    console.log('  ' + String(n).padStart(6) + '  ' + (100 * n / rows.length).toFixed(1).padStart(5) + '%  ' + k);
});
console.log('');
console.log('PRESERVATION (prompts where something was lost)');
Object.keys(losses).forEach((k) => {
    console.log('  ' + k.padEnd(11) + String(losses[k]).padStart(6)
        + '  (' + (100 * losses[k] / rows.length).toFixed(2) + '%)');
});
console.log('  empty output ' + emptyOutput);
console.log('');
console.log('BPO DIRECTION  (' + pairs + ' pairs)');
console.log('  original scored lower than the rewrite : ' + originalLower
    + ' (' + (100 * originalLower / (pairs || 1)).toFixed(1) + '%)');
console.log('  same score                             : ' + equalScore);
console.log('  original scored HIGHER                 : ' + originalHigher
    + ' (' + (100 * originalHigher / (pairs || 1)).toFixed(1) + '%)');
console.log('  -- on the ' + fairPairs + ' pairs where the rewrite is no longer:');
console.log('     original lower ' + fairOriginalLower + ' / higher ' + fairOriginalHigher);
console.log('');
console.log('Wrote ' + path.relative(ROOT, OUT));
