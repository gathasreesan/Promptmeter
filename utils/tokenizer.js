/**
 * PromptMeter Tokenizer Wrapper
 * 
 * Exposes a clean API for token counting. It uses the pre-loaded js-tiktoken bundle
 * if available, and falls back to a word-based heuristic estimation otherwise.
 */
const PromptMeterTokenizer = {
    /**
     * Estimates the number of tokens in a given text block.
     * @param {string} text - The input text string.
     * @returns {number} The estimated token count.
     */
    countTokens: function (text) {
        if (!text || text.trim() === "") {
            return 0;
        }

        // Check if the compiled js-tiktoken bundle is available on the window object
        if (window.PromptMeterTokenizer && typeof window.PromptMeterTokenizer.encode === 'function') {
            try {
                // Return exact tiktoken count
                return window.PromptMeterTokenizer.encode(text).length;
            } catch (err) {
                console.warn("PromptMeter [Tokenizer]: Tiktoken encoding failed. Falling back to heuristic.", err);
            }
        }

        // Heuristic fallback: 1 token is roughly 4 characters or 0.75 words.
        // We split on whitespace to find the word count, then multiply by 1.33.
        const cleanText = text.trim();
        const wordCount = cleanText.split(/\s+/).filter(word => word.length > 0).length;
        const charCount = cleanText.length;
        
        // Combine word and char heuristics for a more balanced estimate
        const wordHeuristic = Math.round(wordCount * 1.33);
        const charHeuristic = Math.round(charCount / 4);

        // Take the average of both heuristics to balance short vs. long text blocks
        return Math.max(1, Math.round((wordHeuristic + charHeuristic) / 2));
    }
};
