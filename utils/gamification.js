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
        if (days[todayStr]) {
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
        const highEffCount = history.filter(item => (item.efficiencyScore || 100) >= 85).length;
        const avgEfficiency = history.length > 0
            ? history.reduce((sum, item) => sum + (item.efficiencyScore || 100), 0) / history.length
            : 100;

        return [
            {
                id: "green_user",
                name: "Green User",
                description: "Maintain an average prompt efficiency of >= 90% over 5+ prompts.",
                icon: "check",
                unlocked: history.length >= 5 && avgEfficiency >= 90
            },
            {
                id: "carbon_crusader",
                name: "Carbon Crusader",
                description: "Save a total of 1.0g or more of CO₂ through prompt optimizations.",
                icon: "trophy",
                unlocked: totalCarbonSaved >= 1.0
            },
            {
                id: "streak_starter",
                name: "Streak Starter",
                description: "Achieve a 3-day sustainability streak.",
                icon: "flame",
                unlocked: currentStreak >= 3
            },
            {
                id: "eco_champion",
                name: "Eco Champion",
                description: "Log 20+ queries with prompt efficiency >= 85%.",
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

        // Sum carbon saved inside the 7-day window
        const carbonSavedThisWeek = history
            .filter(item => new Date(item.timestamp) >= sevenDaysAgo)
            .reduce((sum, item) => sum + (item.carbonSaved || 0), 0);

        const targetCarbonSavings = 2.0; // 2 grams of CO2
        const progress = Math.min(100, Math.round((carbonSavedThisWeek / targetCarbonSavings) * 100));

        return {
            title: "Weekly Carbon Cut Challenge",
            goal: `Save ${targetCarbonSavings.toFixed(1)}g of CO₂ this week`,
            currentValue: `${carbonSavedThisWeek.toFixed(2)}g`,
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
