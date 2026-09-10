/**
 * PromptMeter ML Classifier
 *
 * Runtime half of the machine-learning component. Trained offline by ml/train.py with
 * scikit-learn; this file reimplements the fitted pipeline -- TF-IDF then multinomial
 * logistic regression -- so it can run inside a Chrome content script with no server,
 * no WASM and no network call.
 *
 * The transform below MUST stay in step with build_model() in ml/train.py:
 *
 *     token pattern   \b\w[\w']*\b, lowercased
 *     term frequency  raw counts          (sublinear_tf=False)
 *     idf             taken from the model, already computed by sklearn
 *     norm            L2                  (norm='l2')
 *     decision        softmax(W . x + b)
 *
 * A sentence made entirely of words the model never saw carries no evidence at all. In
 * that case classify() ABSTAINS and returns null rather than reporting whichever class
 * happens to have the largest intercept. Callers treat null as "no opinion" and fall
 * back to the rules, which is the whole safety story of this component: the model can
 * only ever refine a rule decision, never manufacture one on its own.
 */
const PM_MODEL = (typeof PromptMeterModel !== 'undefined')
    ? PromptMeterModel
    : (typeof require !== 'undefined' ? require('./ml-model.js').PromptMeterModel : null);

const PromptMeterML = {
    // Below this many recognised words the vector is too sparse to trust.
    MIN_KNOWN_TOKENS: 2,

    /** True when a trained model was loaded. Everything degrades gracefully without one. */
    isAvailable: function () {
        return Boolean(PM_MODEL && PM_MODEL.vocabulary && PM_MODEL.coefficients);
    },

    /** Model provenance, for the dashboard and for debugging. */
    info: function () {
        if (!this.isAvailable()) return null;
        return {
            labels: PM_MODEL.labels,
            trainedAt: PM_MODEL.trainedAt,
            samples: PM_MODEL.samples,
            accuracy: PM_MODEL.accuracy,
            vocabularySize: Object.keys(PM_MODEL.vocabulary).length
        };
    },

    /**
     * Splits text the way sklearn's default token_pattern does.
     * @param {string} text
     * @returns {Array} Lowercased tokens.
     */
    tokenize: function (text) {
        if (!text) return [];
        return text.toLowerCase().match(/\b\w[\w']*\b/g) || [];
    },

    /**
     * Builds the L2-normalised TF-IDF vector for one piece of text.
     * @param {string} text
     * @returns {Object|null} { indices, values, known } or null when nothing is known.
     */
    vectorize: function (text) {
        if (!this.isAvailable()) return null;

        const counts = new Map();
        let known = 0;

        for (const token of this.tokenize(text)) {
            const index = PM_MODEL.vocabulary[token];
            if (index === undefined) continue;
            counts.set(index, (counts.get(index) || 0) + 1);
            known += 1;
        }

        if (known < this.MIN_KNOWN_TOKENS) return null;

        const indices = [];
        const values = [];
        let sumOfSquares = 0;

        counts.forEach((count, index) => {
            const value = count * PM_MODEL.idf[index];
            indices.push(index);
            values.push(value);
            sumOfSquares += value * value;
        });

        // L2 normalisation. A zero norm cannot happen once known >= 1, but guarding it
        // is cheaper than reasoning about it.
        const norm = Math.sqrt(sumOfSquares);
        if (norm === 0) return null;
        for (let i = 0; i < values.length; i++) values[i] /= norm;

        return { indices: indices, values: values, known: known };
    },

    /**
     * Classifies one sentence or clause.
     * @param {string} text
     * @returns {Object|null} { label, confidence, scores } or null when abstaining.
     */
    classify: function (text) {
        const vector = this.vectorize(text);
        if (!vector) return null;

        const labels = PM_MODEL.labels;
        const logits = new Array(labels.length);

        for (let c = 0; c < labels.length; c++) {
            const weights = PM_MODEL.coefficients[c];
            let total = PM_MODEL.intercepts[c];

            for (let i = 0; i < vector.indices.length; i++) {
                const weight = weights[vector.indices[i]];
                if (weight !== undefined) total += weight * vector.values[i];
            }
            logits[c] = total;
        }

        // Softmax, shifted by the maximum so a large logit cannot overflow exp().
        const max = Math.max.apply(null, logits);
        let sum = 0;
        const probabilities = logits.map(value => {
            const p = Math.exp(value - max);
            sum += p;
            return p;
        });

        const scores = {};
        let best = 0;
        for (let c = 0; c < labels.length; c++) {
            probabilities[c] /= sum;
            scores[labels[c]] = probabilities[c];
            if (probabilities[c] > probabilities[best]) best = c;
        }

        return {
            label: labels[best],
            confidence: probabilities[best],
            scores: scores
        };
    },

    /**
     * The single question the optimizer asks: may this sentence go?
     *
     * IMPORTANT means keep. The other three labels all mean the sentence carries no
     * instruction, so they are pooled -- and the pooled probability is what gets
     * compared against a threshold, rather than the winning label's own confidence.
     * A sentence split 0.3 FILLER / 0.3 REDUNDANT / 0.3 REPETITIVE / 0.1 IMPORTANT is
     * a confident 0.9 "removable" even though no single label looks confident.
     *
     * @param {string} text
     * @returns {Object|null} { label, keep, removable, confidence } or null.
     */
    advise: function (text) {
        const result = this.classify(text);
        if (!result) return null;

        const keep = result.scores.IMPORTANT || 0;
        return {
            label: result.label,
            keep: keep,
            removable: 1 - keep,
            confidence: result.confidence
        };
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterML = PromptMeterML;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterML };
}
