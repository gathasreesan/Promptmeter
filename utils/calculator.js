/**
 * PromptMeter Environmental Calculator
 * 
 * Estimates the environmental footprint (electricity, carbon, and water) 
 * associated with LLM inference based on token usage.
 * 
 * Constants are based on published research (Luccioni et al., 2023; Li et al., 2023).
 */
const PromptMeterCalculator = {
    // Configurable constants
    config: {
        // Electricity consumed per token in Watt-hours (Wh)
        // Default: 0.001 Wh per token (equivalent to 1 Wh per 1000 tokens)
        electricityPerToken: 0.001,

        // Carbon intensity of the electricity grid in grams of CO2 per Wh (g CO2 / Wh)
        // Default: 0.36 g CO2 / Wh (US grid average, equivalent to 360 g CO2 / kWh)
        carbonIntensity: 0.36,

        // Water consumption in milliliters per Wh of electricity consumed (mL / Wh)
        // Includes data center cooling water + thermal electricity generation water usage
        // Default: 1.5 mL / Wh (equivalent to 1.5 Liters per kWh)
        waterPerWh: 1.5
    },

    /**
     * Update calculation constants dynamically.
     * @param {Object} customConfig - Key-value pairs to override default config.
     */
    updateConfig: function (customConfig) {
        if (customConfig) {
            this.config = { ...this.config, ...customConfig };
            console.log("🌿 PromptMeter [Calculator]: Config updated.", this.config);
        }
    },

    /**
     * Computes the environmental footprint for a given token count.
     * @param {number} totalTokens - Cumulative token count (prompt + response).
     * @returns {Object} Footprint metrics { electricity, carbon, water }.
     */
    calculate: function (totalTokens) {
        if (!totalTokens || totalTokens < 0) {
            return {
                electricity: 0,
                carbon: 0,
                water: 0
            };
        }

        // 1. Electricity consumption (Wh)
        const electricity = totalTokens * this.config.electricityPerToken;

        // 2. Carbon emissions (grams of CO2)
        const carbon = electricity * this.config.carbonIntensity;

        // 3. Water usage (milliliters)
        const water = electricity * this.config.waterPerWh;

        return {
            electricity: parseFloat(electricity.toFixed(4)),
            carbon: parseFloat(carbon.toFixed(4)),
            water: parseFloat(water.toFixed(4))
        };
    }
};
