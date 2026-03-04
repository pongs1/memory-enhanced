/**
 * Exponential decay engine.
 *
 * Formula (matches OpenClaw's built-in temporalDecay):
 *   decayedScore = score × e^(-(ln2 / halfLifeDays) × ageInDays)
 *
 * With halfLifeDays=30:
 *   Today: 100%, 7 days: ~84%, 30 days: 50%, 90 days: 12.5%
 */

/**
 * Calculate the decay multiplier for a given age.
 */
export function decayMultiplier(ageInDays: number, halfLifeDays = 30): number {
    const lambda = Math.LN2 / halfLifeDays;
    return Math.exp(-lambda * ageInDays);
}

/**
 * Apply decay to a score.
 */
export function applyDecay(
    currentScore: number,
    ageInDays: number,
    halfLifeDays = 30
): number {
    return Math.round(currentScore * decayMultiplier(ageInDays, halfLifeDays) * 10000) / 10000;
}

/**
 * Calculate age in days between two dates.
 */
export function ageInDays(dateStr: string, referenceDate?: Date): number {
    const ref = referenceDate || new Date();
    const target = new Date(dateStr);
    const diffMs = ref.getTime() - target.getTime();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}
