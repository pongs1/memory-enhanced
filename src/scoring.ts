/**
 * Post-retrieval scoring formula.
 *
 * OpenClaw's memory_search handles: semantic similarity + BM25 + temporal decay + MMR.
 * This module adds: importance weighting + association boosting
 * for use within memory_explore results.
 *
 * Formula:
 *   final_score = α × search_score + γ × importance + δ × association_boost
 *
 * Where:
 *   α = 0.60 (base search score weight)
 *   γ = 0.25 (importance weight)
 *   δ = 0.15 (association boost weight)
 *
 * association_boost = min(1.0, linked_count / max_links)
 */

const ALPHA = 0.60; // search score weight
const GAMMA = 0.25; // importance weight
const DELTA = 0.15; // association boost weight
const MAX_LINKS = 5; // normalization cap for association count

export interface ScoringInput {
    searchScore?: number; // 0-1, from memory_search (optional)
    importance: number; // 0-1, from event/knowledge metadata
    associationCount: number; // number of linked items
}

/**
 * Calculate the final relevance score for a memory entry.
 */
export function computeScore(input: ScoringInput): number {
    const ss = input.searchScore ?? 0.5;
    const imp = Math.max(0, Math.min(1, input.importance));
    const assocBoost = Math.min(1.0, input.associationCount / MAX_LINKS);

    return Math.round((ALPHA * ss + GAMMA * imp + DELTA * assocBoost) * 10000) / 10000;
}

/**
 * Sort entries by computed score (descending).
 */
export function rankByScore<T extends ScoringInput>(entries: T[]): T[] {
    return [...entries].sort(
        (a, b) => computeScore(b) - computeScore(a)
    );
}
