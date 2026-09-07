/**
 * PromptMeter Optimizer & Analyzer
 * 
 * Provides rule-based text analysis (lightweight NLP) to grade prompt efficiency,
 * identify redundant phrasing, filler words, politeness, and duplicate/regenerated queries.
 */
const PromptMeterOptimizer = {
    // Regular expression rules for scoring deductions
    rules: {
        // Greetings: "hello", "hi chatgpt", etc.
        greetings: /\b(hello|hi|hey|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening|chatgpt)\b/gi,
        
        // Politeness phrases that add no semantic meaning
        politeness: /\b(please|thank\s+you|thanks|could\s+you|would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|kindly|hope\s+you\s+are\s+well)\b/gi,
        
        // Conversational preambles that add no instruction value
        preambles: /\b(i\s+am\s+bored|i'm\s+bored|so\s+i\s+want\s+to|i\s+want\s+to|i\s+need\s+to|i\s+would\s+like\s+to|i\s+would\s+like\s+you\s+to|i\s+was\s+wondering\s+if)\b/gi,

        // Filler/wordy phrases that can be expressed in fewer words
        fillerPhrases: /\b(in\s+order\s+to|due\s+to\s+the\s+fact\s+that|as\s+a\s+matter\s+of\s+fact|more\s+or\s+less|virtually|for\s+all\s+intents\s+and\s+purposes|can\s+you\s+help\s+me)\b/gi,
        
        // Duplicate adjacent words: e.g. "write write", "the the"
        repeatedWords: /\b(\w+)\s+\1\b/gi
    },

    /**
     * Analyzes the efficiency of a prompt and computes a score from 0 to 100.
     * @param {string} prompt - The raw prompt text.
     * @param {Array} history - The list of historical turns.
     * @returns {Object} Analysis report { score, flags }
     */
    analyzePrompt: function (prompt, history = []) {
        if (!prompt || prompt.trim() === "") {
            return { score: 100, flags: [] };
        }

        let score = 100;
        const flags = [];
        const cleanPrompt = prompt.trim();

        // 1. Check for Greetings
        const greetingMatches = cleanPrompt.match(this.rules.greetings);
        if (greetingMatches && greetingMatches.length > 0) {
            const deduction = Math.min(15, greetingMatches.length * 5);
            score -= deduction;
            flags.push(`Greetings detected (deducted ${deduction} points)`);
        }

        // 2. Check for Politeness
        const politenessMatches = cleanPrompt.match(this.rules.politeness);
        if (politenessMatches && politenessMatches.length > 0) {
            const deduction = Math.min(25, politenessMatches.length * 10);
            score -= deduction;
            flags.push(`Excessive politeness/filler detected (deducted ${deduction} points)`);
        }

        // 3. Check for Conversational Preambles
        const preambleMatches = cleanPrompt.match(this.rules.preambles);
        if (preambleMatches && preambleMatches.length > 0) {
            const deduction = Math.min(20, preambleMatches.length * 10);
            score -= deduction;
            flags.push(`Conversational preambles detected (deducted ${deduction} points)`);
        }

        // 4. Check for Wordy/Filler Phrases
        const fillerMatches = cleanPrompt.match(this.rules.fillerPhrases);
        if (fillerMatches && fillerMatches.length > 0) {
            const deduction = Math.min(20, fillerMatches.length * 10);
            score -= deduction;
            flags.push(`Redundant filler phrases detected (deducted ${deduction} points)`);
        }

        // 5. Check for Adjacent Word Repetition
        const repetitionMatches = cleanPrompt.match(this.rules.repeatedWords);
        if (repetitionMatches && repetitionMatches.length > 0) {
            score -= 10;
            flags.push("Adjacent repeated words detected (deducted 10 points)");
        }

        // 6. History-based analysis: Duplicate Prompts & Regenerations
        if (history && history.length > 0) {
            const lastTurn = history[history.length - 1];
            
            // Check if the exact prompt was sent as the immediate previous query
            if (lastTurn && lastTurn.prompt && lastTurn.prompt.trim() === cleanPrompt) {
                // Determine if it was a quick regeneration (sent within 3 minutes of previous turn)
                const timeDiff = new Date() - new Date(lastTurn.timestamp);
                const isRegen = timeDiff < 3 * 60 * 1000; // 3 minutes

                if (isRegen) {
                    score -= 15;
                    flags.push("Frequent prompt regeneration detected (deducted 15 points)");
                } else {
                    score -= 10;
                    flags.push("Duplicate prompt detected (deducted 10 points)");
                }
            }
        }

        // Ensure score stays bounded between 0 and 100
        score = Math.max(0, Math.min(100, score));

        return {
            score: score,
            flags: flags
        };
    },

    /**
     * Optimizes a prompt by stripping out conversational fillers, greetings,
     * duplicate words, and politeness markers, yielding a cleaner, more efficient query.
     * @param {string} prompt - The original prompt text.
     * @returns {string} The optimized prompt text.
     */
    optimizePrompt: function (prompt) {
        if (!prompt || prompt.trim() === "") {
            return "";
        }

        let optimized = prompt;

        // 1. Pipeline of regexes to iteratively clean conversational start filler
        const startRegexes = [
            /^\s*(?:hello|hi|hey|greetings|dear|good\s+morning|good\s+afternoon|good\s+evening)\b(?:\s+chatgpt)?(?:[,!.\s]*)/gi,
            /^\s*(?:i\s+am\s+bored\s+so\s+i\s+want\s+to|i'm\s+bored\s+so\s+i\s+want\s+to|i\s+am\s+bored\s+so|i'm\s+bored\s+so|so\s+i\s+want\s+to|so\s+i\s+need\s+to)\b\s*/gi,
            /^\s*(?:i\s+was\s+wondering\s+if\s+you\s+could|i\s+just\s+wanted\s+to\s+ask\s+if\s+you\s+can|can\s+you\s+help\s+me\s+with|could\s+you\s+help\s+me\s+with|can\s+you\s+help\s+me\s+to|could\s+you\s+help\s+me\s+to)\b\s*/gi,
            /^\s*(?:i\s+would\s+like\s+you\s+to|i\s+would\s+like\s+to|i\s+want\s+to|i\s+need\s+to)\b\s*/gi,
            /^\s*(?:can\s+you|could\s+you|would\s+you|please)\b\s*/gi
        ];

        let previousLength;
        do {
            previousLength = optimized.length;
            for (const rx of startRegexes) {
                optimized = optimized.replace(rx, '');
            }
        } while (optimized.length < previousLength); // Repeat if something was stripped

        // 2. Remove politeness markers anywhere in the sentence
        optimized = optimized.replace(/\bplease\b\s*/gi, '');
        optimized = optimized.replace(/\b(?:would\s+you\s+mind|would\s+you\s+please|can\s+you\s+please|could\s+you\s+please|can\s+you\s+help\s+me|could\s+you|can\s+you)\b\s*/gi, '');
        
        // Remove trailing or isolated thanks/thank you/kindly
        optimized = optimized.replace(/\b(?:thank\s+you|thanks|kindly)(?:[,!.\s]*)$/gi, '');
        optimized = optimized.replace(/\b(?:thank\s+you|thanks|kindly)\b(?:[,!.\s]*)/gi, '');

        // 3. Replace wordy/filler phrases with direct equivalents
        optimized = optimized.replace(/\bin\s+order\s+to\b/gi, 'to');
        optimized = optimized.replace(/\bdue\s+to\s+the\s+fact\s+that\b/gi, 'because');
        optimized = optimized.replace(/\bas\s+a\s+matter\s+of\s+fact\b/gi, 'actually');
        optimized = optimized.replace(/\bfor\s+all\s+intents\s+and\s+purposes\b/gi, 'basically');

        // 4. Remove duplicate adjacent words
        optimized = optimized.replace(/\b(\w+)\s+\1\b/gi, '$1');

        // Clean up redundant whitespace or trailing punctuation leftover from replacements
        optimized = optimized.trim();

        // Capitalize the first letter if it was lowercased by stripping elements
        if (optimized.length > 0) {
            optimized = optimized.charAt(0).toUpperCase() + optimized.slice(1);
        }

        return optimized;
    }
};
