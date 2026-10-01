/**
 * PromptMeter Gamification Engine
 * 
 * Computes user streaks, checks unlock criteria for achievements/badges, 
 * and tracks weekly carbon/token saving challenges.
 */
const PromptMeterGamification = {
    /**
     * Calculates the consecutive day streak of prompt efficiency >= 90%.
     * @param {Array} history - The historical logs.
     * @returns {number} Current streak in days.
     */
    calculateStreak: function (history = []) {
        if (!history || history.length === 0) return 0;

        // Group efficiency scores by date string
        const days = {};
        history.forEach(item => {
            const dateStr = new Date(item.timestamp).toDateString();
            if (!days[dateStr]) {
                days[dateStr] = [];
            }
            // typeof, not !== undefined: an unscored turn now carries null, which
            // passes an undefined check and then averages as zero.
            days[dateStr].push(
                typeof item.efficiencyScore === 'number' && isFinite(item.efficiencyScore)
                    ? item.efficiencyScore
                    : 100
            );
        });

        const today = new Date();
        const todayStr = today.toDateString();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toDateString();

        let activeCheckDate = null;
        // Today only starts the count once it has earned credit: one weak first prompt
        // used to zero a streak that today could still extend.
        if (days[todayStr] && days[todayStr].some(score => score >= 90)) {
            activeCheckDate = today;
        } else if (days[yesterdayStr]) {
            activeCheckDate = yesterday;
        } else {
            // Streak broken (no activity today or yesterday)
            return 0;
        }

        let streak = 0;
        while (true) {
            const checkStr = activeCheckDate.toDateString();
            if (days[checkStr]) {
                // User has streak credit if at least one prompt had efficiency >= 90%
                const hasEfficientPrompt = days[checkStr].some(score => score >= 90);
                if (hasEfficientPrompt) {
                    streak++;
                    // Step back to the previous calendar day
                    activeCheckDate.setDate(activeCheckDate.getDate() - 1);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        return streak;
    },

    /**
     * Audits the history log to evaluate achievements.
     * @param {Array} history - The historical logs.
     * @returns {Array} List of badge objects with unlocked states.
     */
    checkBadges: function (history = []) {
        const totalCarbonSaved = history.reduce((sum, item) => sum + (item.carbonSaved || 0), 0);
        const currentStreak = this.calculateStreak(history);
        // typeof, not `|| 100`: a genuine score of 0 is falsy and was counted as 100.
        const score = item => typeof item.efficiencyScore === 'number' && isFinite(item.efficiencyScore)
            ? item.efficiencyScore : 100;
        const highEffCount = history.filter(item => score(item) >= 85).length;
        const avgEfficiency = history.length > 0
            ? history.reduce((sum, item) => sum + score(item), 0) / history.length
            : 100;

        return [
            {
                id: "green_user",
                name: "Efficient",
                description: "Average 90% efficiency or more over at least 5 prompts.",
                icon: "check",
                unlocked: history.length >= 5 && avgEfficiency >= 90
            },
            {
                id: "carbon_crusader",
                name: "1 g CO₂ saved",
                description: "Save 1 g of CO₂ in total through shorter prompts.",
                icon: "trophy",
                unlocked: totalCarbonSaved >= 1.0
            },
            {
                id: "streak_starter",
                name: "3-day streak",
                description: "Use PromptMeter efficiently three days in a row.",
                icon: "flame",
                unlocked: currentStreak >= 3
            },
            {
                id: "eco_champion",
                name: "20 good prompts",
                description: "Send 20 prompts scoring 85% or higher.",
                icon: "trophy",
                unlocked: highEffCount >= 20
            }
        ];
    },

    /**
     * Aggregates carbon saved in the last 7 days against a target.
     * @param {Array} history - The historical logs.
     * @returns {Object} Challenge details.
     */
    getWeeklyChallenge: function (history = []) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const week = history.filter(item => new Date(item.timestamp) >= sevenDaysAgo);
        const tokensSavedThisWeek = week.reduce((sum, item) => sum + (item.tokensSaved || 0), 0);
        const carbonSavedThisWeek = week.reduce((sum, item) => sum + (item.carbonSaved || 0), 0);

        // Counted in tokens. The old target was 2 g of CO2, which at 0.36 mg a token
        // is about 5,500 tokens a week -- some 550 improved prompts -- so the bar sat
        // near zero for everyone. 500 tokens is roughly fifty improved prompts.
        const targetTokens = 500;
        const progress = Math.min(100, Math.round((tokensSavedThisWeek / targetTokens) * 100));

        return {
            title: "Weekly goal",
            goal: `Save ${targetTokens} tokens this week`,
            currentValue: `${tokensSavedThisWeek.toLocaleString()} tokens`,
            targetLabel: `${targetTokens} tokens`,
            carbonSaved: carbonSavedThisWeek,
            progress: progress,
            completed: progress >= 100
        };
    }
};

// Export UMD style for global window and esbuild bundlers
if (typeof window !== 'undefined') {
    window.PromptMeterGamification = PromptMeterGamification;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptMeterGamification };
}
