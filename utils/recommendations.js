/**
 * PromptMeter Recommendation & Coaching Engine
 * 
 * Audits the user's historical Generative AI logs to diagnose behavioral pitfalls
 * and output personalized action steps to reduce carbon footprints and energy draw.
 */
const PromptMeterRecommendations = {
    /**
     * Inspects history logs and returns an array of active recommendation objects.
     * @param {Array} history - Array of captured turns.
     * @returns {Array} List of recommendations.
     */
    generate: function (history = []) {
        const list = [];
        if (!history || history.length === 0) {
            // General baseline recommendation
            list.push({
                id: "general_tips",
                title: "🌱 Sustainable Prompting Guidelines",
                description: "Write direct, single-instruction prompts. Avoid polite greetings (like 'please' or 'thank you') to keep prompt sizes small and save GPU computation cycles.",
                severity: "success",
                savings: "Up to 25% tokens"
            });
            return list;
        }

        // 1. Audit: Low Average Prompt Efficiency (Filler words & Politeness)
        const inefficientPrompts = history.filter(turn =>
            typeof turn.efficiencyScore === 'number' && turn.efficiencyScore < 85);
        if (inefficientPrompts.length > 0) {
            const avgScore = Math.round(
                history.reduce((sum, item) => sum + (item.efficiencyScore || 100), 0) / history.length
            );
            
            if (avgScore < 85) {
                // Estimate potential token savings (average original prompt has ~12 filler tokens)
                const estimatedSavings = inefficientPrompts.length * 15;
                list.push({
                    id: "filler_reduction",
                    title: "🧹 Strip Politeness & Conversational Fillers",
                    description: `Your average prompt efficiency is ${avgScore}%. Stripping phrases like 'could you please help me' or 'thank you' from your queries will reduce redundant tokens.`,
                    severity: "warning",
                    savings: `Save ~${estimatedSavings} tokens`
                });
            }
        }

        // 2. Audit: Duplicate Prompts (Unnecessary repetition)
        const promptCounts = {};
        let duplicateCount = 0;
        let sampleDuplicate = "";

        history.forEach(turn => {
            if (turn.prompt) {
                const text = turn.prompt.trim();
                promptCounts[text] = (promptCounts[text] || 0) + 1;
                if (promptCounts[text] > 1) {
                    duplicateCount++;
                    sampleDuplicate = text;
                }
            }
        });

        if (duplicateCount > 0) {
            const displayPrompt = sampleDuplicate.length > 30 
                ? `"${sampleDuplicate.substring(0, 30)}..."` 
                : `"${sampleDuplicate}"`;

            list.push({
                id: "duplicate_prompts",
                title: "📂 Reuse Previous Conversational Outputs",
                description: `You asked identical queries (e.g. ${displayPrompt}) multiple times. Consider bookmarking answers or scrolling up instead of regenerating the same output.`,
                severity: "info",
                savings: `Save ~20-50% energy`
            });
        }

        // 3. Audit: Rapid Regenerations (Vague prompting)
        let regenCount = 0;
        for (let i = 1; i < history.length; i++) {
            const current = history[i];
            const previous = history[i - 1];
            
            if (current.prompt && previous.prompt && current.prompt.trim() === previous.prompt.trim()) {
                const timeDiff = new Date(current.timestamp) - new Date(previous.timestamp);
                if (timeDiff < 3 * 60 * 1000) { // 3 minutes
                    regenCount++;
                }
            }
        }

        if (regenCount > 0) {
            list.push({
                id: "rapid_regens",
                title: "🎯 Avoid Rapid Response Regenerations",
                description: `We detected ${regenCount} quick response regenerations. Try refining your prompts in your first turn by adding explicit constraints (e.g. output formatting, word limits) to get correct answers instantly.`,
                severity: "warning",
                savings: `Save ~1.5Wh electricity`
            });
        }

        // 4. Audit: Daily Carbon Ceiling
        const todayString = new Date().toDateString();
        const carbonToday = history
            .filter(turn => new Date(turn.timestamp).toDateString() === todayString)
            .reduce((sum, turn) => sum + (turn.carbon || 0), 0);

        if (carbonToday > 5.0) {
            list.push({
                id: "carbon_ceiling",
                title: "⚠️ High Daily Carbon Usage Warning",
                description: `Your generative AI queries have generated ${carbonToday.toFixed(1)}g of CO₂ today. Consider batching smaller queries into unified, multi-step prompts.`,
                severity: "warning",
                savings: `Reduces load spikes`
            });
        }

        // 5. Success State: Excellent Prompting Habits!
        if (list.length === 0) {
            list.push({
                id: "success_habits",
                title: "🏆 Stellar Prompting Habits!",
                description: "Amazing work! Your prompts show exceptional efficiency. You are minimizing server overhead and actively supporting responsible digital consumption (SDG 12).",
                severity: "success",
                savings: "Optimal footprint"
            });
        }

        return list;
    }
};

// Export UMD style for global window and esbuild bundlers
if (typeof window !== 'undefined') {
    window.PromptMeterRecommendations = PromptMeterRecommendations;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterRecommendations };
}
