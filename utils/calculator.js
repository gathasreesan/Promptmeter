/**
 * PromptMeter Environmental Calculator
 *
 * Estimates the environmental footprint (electricity, carbon, and water)
 * associated with LLM inference based on token usage.
 *
 * Constants are based on published research (Luccioni et al., 2023; Li et al., 2023).
 */
const PromptMeterCalculator = {
    config: {
        // Electricity per token in Watt-hours (1 Wh per 1000 tokens)
        electricityPerToken: 0.001,

        // Grid carbon intensity in g CO2 per Wh (US average, 360 g CO2 / kWh)
        carbonIntensity: 0.36,

        // Water per Wh in mL, covering data centre cooling and thermal generation (1.5 L / kWh)
        waterPerWh: 1.5
    },

    /**
     * Computes the environmental footprint for a given token count.
     * @param {number} totalTokens - Cumulative token count (prompt + response).
     * @returns {Object} Footprint metrics { electricity, carbon, water }.
     */
    calculate: function (totalTokens) {
        if (!totalTokens || totalTokens < 0) {
            return { electricity: 0, carbon: 0, water: 0 };
        }

        const electricity = totalTokens * this.config.electricityPerToken;
        const round = (value) => parseFloat(value.toFixed(4));

        return {
            electricity: round(electricity),
            carbon: round(electricity * this.config.carbonIntensity),
            water: round(electricity * this.config.waterPerWh)
        };
    },

    /**
     * Footprint avoided by removing tokens from a prompt. Unlike calculate(), the values
     * are left unrounded: savings are typically a fraction of a milligram and are summed
     * across many turns before ever being displayed.
     * @param {number} tokensSaved - Tokens removed by the optimizer.
     * @returns {Object} Avoided footprint { electricity, carbon, water }.
     */
    savings: function (tokensSaved) {
        const electricity = Math.max(0, tokensSaved) * this.config.electricityPerToken;
        return {
            electricity: electricity,
            carbon: electricity * this.config.carbonIntensity,
            water: electricity * this.config.waterPerWh
        };
    }
};

// Export for global (content script) and bundler environments
if (typeof window !== 'undefined') {
    window.PromptMeterCalculator = PromptMeterCalculator;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterCalculator };
}
