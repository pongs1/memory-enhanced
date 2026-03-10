import type {
    V8DayIndex,
    V8HardCoreIndex,
    V8MemoryBundle,
    V8MemoryNode,
    V8SourceIndex,
    V8TriggerLexicon,
} from "./types.js";

function normalizeTrigger(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 80);
}

export function buildTriggerLexicon(nodes: V8MemoryNode[]): V8TriggerLexicon {
    const lexicon: V8TriggerLexicon = {};

    for (const node of nodes) {
        const candidates = new Set<string>();
        for (const keyword of node.keywords) {
            const normalized = normalizeTrigger(keyword);
            if (normalized.length >= 2) {
                candidates.add(normalized);
            }
        }

        const summary = normalizeTrigger(node.summary);
        if (summary.length >= 2 && summary.length <= 80) {
            candidates.add(summary);
        }

        for (const trigger of candidates) {
            if (!lexicon[trigger]) {
                lexicon[trigger] = [];
            }
            if (!lexicon[trigger].includes(node.id)) {
                lexicon[trigger].push(node.id);
            }
        }
    }

    return lexicon;
}

export function buildDayIndex(nodes: V8MemoryNode[]): V8DayIndex {
    const index: V8DayIndex = {};

    for (const node of nodes) {
        if (!node.dayKey) continue;
        if (!index[node.dayKey]) {
            index[node.dayKey] = { nodeIds: [], episodeKeys: [] };
        }
        if (!index[node.dayKey].nodeIds.includes(node.id)) {
            index[node.dayKey].nodeIds.push(node.id);
        }
        if (node.episodeKey && !index[node.dayKey].episodeKeys.includes(node.episodeKey)) {
            index[node.dayKey].episodeKeys.push(node.episodeKey);
        }
    }

    return index;
}

export function buildSourceIndex(bundles: V8MemoryBundle[]): V8SourceIndex {
    const index: V8SourceIndex = {};

    for (const bundle of bundles) {
        const current = index[bundle.sourceRef];
        if (!current) {
            index[bundle.sourceRef] = {
                sourceRef: bundle.sourceRef,
                bundleIds: [bundle.bundleId],
                canonicalRef: bundle.canonicalRef,
                summaryRef: bundle.summaryRef,
                relatedDailyLogRefs:
                    bundle.summaryRef.startsWith("memory/") && bundle.summaryRef.endsWith(".md")
                        ? [bundle.summaryRef]
                        : [],
            };
            continue;
        }

        if (!current.bundleIds.includes(bundle.bundleId)) {
            current.bundleIds.push(bundle.bundleId);
        }
        if (
            bundle.summaryRef.startsWith("memory/") &&
            bundle.summaryRef.endsWith(".md") &&
            !current.relatedDailyLogRefs.includes(bundle.summaryRef)
        ) {
            current.relatedDailyLogRefs.push(bundle.summaryRef);
        }
    }

    return index;
}

export function buildHardCoreIndex(nodes: V8MemoryNode[]): V8HardCoreIndex {
    const result: V8HardCoreIndex = {
        agent_identity_core: [],
        inter_agent_protocol_core: [],
    };

    for (const node of nodes) {
        const adoptRate = node.hitCount > 0 ? node.adoptCount / node.hitCount : 0;
        const harmRate = node.hitCount > 0 ? node.harmCount / node.hitCount : 0;

        if (
            node.hitCount >= 8 &&
            adoptRate >= 0.75 &&
            harmRate <= 0.1 &&
            (node.role === "constraint" || node.role === "workflow")
        ) {
            result.agent_identity_core.push(node.id);
        }

        if (
            node.hitCount >= 10 &&
            adoptRate >= 0.8 &&
            harmRate <= 0.1 &&
            node.role === "checkpoint"
        ) {
            result.inter_agent_protocol_core.push(node.id);
        }
    }

    return result;
}
