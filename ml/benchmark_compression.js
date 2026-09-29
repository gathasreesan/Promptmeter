/**
 * Compression benchmark over the reference corpus.
 *
 *     node ml/benchmark_compression.js [sample.jsonl] [--limit N] [--repeats N]
 *
 * Writes ml/compression_benchmark.json and prints a summary. Reproducible: the corpus
 * sample is a fixed seeded draw (see ingest.py --export-jsonl), the tiers are
 * deterministic, and nothing here calls a model.
 *
 * WHAT IS AND IS NOT MEASURED.
 *
 * Measured directly, because they are facts about the output:
 *   compression ratio     tokens saved, by the same tokenizer the extension uses
 *   constraint preservation  the validator's own rules, per rule, over real prompts
 *   latency               wall-clock per prompt, warm
 *   optimization cost     the same number, read as what compression costs to run
 *   net saving            tokens saved times how often the prompt is sent
 *
 * NOT measured here, and the distinction matters: DOWNSTREAM ANSWER QUALITY. Whether a
 * compressed prompt gets as good an answer needs a model to answer both versions and
 * something to judge the pair. There is no model in this repository and no API key, so
 * this file does not pretend to that number -- it reports semantic-preservation proxies
 * (the validator) and says plainly that they are proxies. A compression ratio is not
 * evidence of quality, and treating it as such is the mistake this benchmark exists to
 * avoid making.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
['protect', 'ml-model', 'ml-classifier', 'condense', 'spelling', 'grammar',
 'tokenizer', 'calculator', 'headroom', 'optimizer', 'analysis', 'compress'].forEach((name) => {
    Object.assign(global, require(path.join(ROOT, 'utils', name + '.js')));
});

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = args.indexOf('--' + name);
    return at === -1 ? fallback : Number(args[at + 1]);
};
const SAMPLE = args.find((a) => !a.startsWith('--') && a.endsWith('.jsonl'))
    || path.join(__dirname, 'corpus', 'sample.jsonl');
// EVERY ROW BY DEFAULT. This was 3000, and a 3,000-row slice of this corpus is not
// precise enough to compare two runs with: the same code measured 9.84% on one draw and
// 11.00% on another, against 10.25% for the whole corpus. Changes of a tenth of a point
// were being reported as results when they were the sampling error. The full pass takes
// about eighty seconds, which is the right price for a number anyone is going to quote.
// Pass --limit for a quick look; the report then says what it is.
const LIMIT = flag('limit', 0);
const REPEATS = flag('repeats', 100);
const OUT = path.join(__dirname, 'compression_benchmark.json');

if (!fs.existsSync(SAMPLE)) {
    console.error('No corpus sample at ' + SAMPLE);
    console.error('Run: python ml/ingest.py --export-jsonl ml/corpus/sample.jsonl');
    process.exit(1);
}

// Exact counts if the bundle has been built; the heuristic otherwise. Reported either
// way, because a compression figure means something different under each.
try {
    const tiktoken = require(path.join(ROOT, 'utils', 'tiktoken.bundle.js'));
    PromptMeterTokenizer.setEncoder(tiktoken.encode, tiktoken.name);
} catch (error) {
    // The bundle is optional and built separately. countTokens() falls back on its own.
}

let rows = fs.readFileSync(SAMPLE, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const TOTAL_ROWS = rows.length;
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

console.log('Benchmarking ' + rows.length + ' prompts'
    + ' | tokenizer: ' + PromptMeterTokenizer.encoding()
    + (PromptMeterTokenizer.isExact() ? ' (exact)' : ' (estimate)'));

/** Short / medium / long, by token count rather than characters. */
function bucket(tokens) {
    if (tokens < 30) return 'short';
    if (tokens < 120) return 'medium';
    return 'long';
}

const blank = () => ({
    n: 0, originalTokens: 0, optimizedTokens: 0, compressed: 0,
    latencyMs: 0, modes: {}, ratios: []
});

const overall = blank();
const byCategory = {};
const byLength = {};
const violationCounts = {};
const modeAttempts = {};
const examples = [];

// One warm pass: the first call parses the model and builds the spelling indexes, and
// charging that to the first prompt would put a 200ms outlier in the latency figure.
PromptMeterCompress.compress('warm the caches before timing anything at all');

rows.forEach((row) => {
    const prompt = row.prompt;
    const started = process.hrtime.bigint();
    let result;
    try {
        result = PromptMeterCompress.compress(prompt, { repeats: REPEATS });
    } catch (error) {
        return;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    const category = row.task_category || 'other';
    const size = bucket(result.tokens.original);
    byCategory[category] = byCategory[category] || blank();
    byLength[size] = byLength[size] || blank();

    [overall, byCategory[category], byLength[size]].forEach((acc) => {
        acc.n++;
        acc.originalTokens += result.tokens.original;
        acc.optimizedTokens += result.tokens.optimized;
        acc.latencyMs += ms;
        acc.modes[result.mode] = (acc.modes[result.mode] || 0) + 1;
        if (result.tokens.saved > 0) {
            acc.compressed++;
            acc.ratios.push(result.tokens.saved / result.tokens.original);
        }
    });

    // Which validator rules actually fire on real prompts, and how often a tier is
    // rejected. A rule that never fires is not protecting anything; one that fires on
    // everything is blocking compression rather than guarding it.
    result.candidates.forEach((candidate) => {
        modeAttempts[candidate.mode] = modeAttempts[candidate.mode]
            || { tried: 0, rejected: 0 };
        modeAttempts[candidate.mode].tried++;
        if (!candidate.valid) {
            modeAttempts[candidate.mode].rejected++;
            candidate.violations.forEach((violation) => {
                violationCounts[violation.rule] = (violationCounts[violation.rule] || 0) + 1;
            });
        }
    });

    if (examples.length < 12 && result.tokens.percent >= 40) {
        examples.push({
            category: category,
            mode: result.mode,
            from: result.tokens.original,
            to: result.tokens.optimized,
            original: prompt.slice(0, 150),
            compressed: result.text.slice(0, 150)
        });
    }
});

function summarise(acc) {
    const sorted = acc.ratios.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    return {
        prompts: acc.n,
        originalTokens: acc.originalTokens,
        optimizedTokens: acc.optimizedTokens,
        // Corpus-wide ratio: total saved over total sent, which is what a bill reflects.
        overallReduction: acc.originalTokens
            ? Number((100 * (acc.originalTokens - acc.optimizedTokens) / acc.originalTokens).toFixed(2))
            : 0,
        // Per-prompt median among prompts that compressed at all, which is what a user
        // sees. The two differ a lot and quoting only one of them flatters the result.
        medianReductionWhenCompressed: Number((100 * median).toFixed(2)),
        compressedShare: acc.n ? Number((100 * acc.compressed / acc.n).toFixed(1)) : 0,
        meanLatencyMs: acc.n ? Number((acc.latencyMs / acc.n).toFixed(3)) : 0,
        modes: acc.modes
    };
}

const report = {
    generatedAt: new Date().toISOString(),
    sample: path.basename(SAMPLE),
    prompts: rows.length,
    tokenizer: {
        encoding: PromptMeterTokenizer.encoding(),
        exact: PromptMeterTokenizer.isExact()
    },
    repeatsAssumedForNetSaving: REPEATS,
    overall: summarise(overall),
    netTokensSavedAtRepeats: (overall.originalTokens - overall.optimizedTokens) * REPEATS,
    byLength: Object.keys(byLength).sort().reduce((acc, key) => {
        acc[key] = summarise(byLength[key]);
        return acc;
    }, {}),
    byCategory: Object.keys(byCategory).sort().reduce((acc, key) => {
        acc[key] = summarise(byCategory[key]);
        return acc;
    }, {}),
    validator: {
        note: 'Candidates rejected by the validator, and which rule rejected them. '
            + 'These are preservation proxies, not a measure of answer quality.',
        byMode: modeAttempts,
        violationsByRule: violationCounts
    },
    downstreamQuality: {
        note: 'NOT MEASURED. Comparing answers to the original and compressed prompts '
            + 'needs a model to answer both and a judge to score the pair. There is no '
            + 'model in this repository. A compression ratio is not evidence of quality.',
        measured: false
    },
    examples: examples
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

const pad = (text, width) => String(text).padEnd(width);
console.log('');
console.log('OVERALL');
console.log('  prompts                 ' + report.overall.prompts);
console.log('  tokens  ' + report.overall.originalTokens + ' -> ' + report.overall.optimizedTokens);
console.log('  corpus-wide reduction   ' + report.overall.overallReduction + '%'
    + (LIMIT > 0 && LIMIT < TOTAL_ROWS
        // Named rather than implied: a reader comparing two runs needs to know the
        // figure carries about a point of sampling error before treating a small
        // difference as a change.
        ? '   (SAMPLE of ' + rows.length + '/' + TOTAL_ROWS
          + ' rows -- about +/-1 point; run without --limit to compare runs)'
        : ''));
console.log('  median when compressed  ' + report.overall.medianReductionWhenCompressed + '%');
console.log('  prompts compressed      ' + report.overall.compressedShare + '%');
console.log('  mean latency            ' + report.overall.meanLatencyMs + 'ms');
console.log('  net tokens @ ' + REPEATS + ' sends   ' + report.netTokensSavedAtRepeats);

console.log('');
console.log('BY LENGTH        n      reduction   median   compressed   latency');
['short', 'medium', 'long'].forEach((key) => {
    const row = report.byLength[key];
    if (!row) return;
    console.log('  ' + pad(key, 14) + pad(row.prompts, 7) + pad(row.overallReduction + '%', 12)
        + pad(row.medianReductionWhenCompressed + '%', 9)
        + pad(row.compressedShare + '%', 13) + row.meanLatencyMs + 'ms');
});

console.log('');
console.log('BY CATEGORY      n      reduction   median   compressed');
Object.keys(report.byCategory).forEach((key) => {
    const row = report.byCategory[key];
    console.log('  ' + pad(key, 14) + pad(row.prompts, 7) + pad(row.overallReduction + '%', 12)
        + pad(row.medianReductionWhenCompressed + '%', 9) + row.compressedShare + '%');
});

console.log('');
console.log('VALIDATOR');
Object.keys(modeAttempts).forEach((mode) => {
    const row = modeAttempts[mode];
    console.log('  ' + pad(mode, 14) + row.tried + ' tried, ' + row.rejected + ' rejected ('
        + (100 * row.rejected / (row.tried || 1)).toFixed(1) + '%)');
});
Object.keys(violationCounts).sort((a, b) => violationCounts[b] - violationCounts[a])
    .forEach((rule) => console.log('    ' + pad(rule, 14) + violationCounts[rule]));

console.log('');
console.log('Downstream answer quality: NOT MEASURED (no model available).');
console.log('Wrote ' + path.relative(ROOT, OUT));
