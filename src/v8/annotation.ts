import { deriveBilingualNodeNames } from "./names.js";
import type {
    V8AnnotationBundleDraft,
    V8AnnotationEdgeDraft,
    V8AnnotationNodeDraft,
    V8BundleSourceType,
    V8NodeKind,
    V8SanitizedAnnotationBundleDraft,
    V8SanitizedAnnotationEdgeDraft,
    V8SanitizedAnnotationNodeDraft,
} from "./types.js";
import type { MemoryEncodingContext } from "../utils.js";

function clamp01(value: number, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, value));
}

function clampPositiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.round(value));
}

function sanitizeText(text: string, maxChars = 320): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function takeLeadingClause(text: string, maxChars = 120): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return sanitizeText(matched, maxChars);
}

function dedupeStrings(values: string[], maxItems = 10, maxChars = 96): string[] {
    const seen = new Set<string>();
    const output: string[] = [];

    for (const value of values) {
        const normalized = sanitizeText(value, maxChars);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(normalized);
        if (output.length >= maxItems) {
            break;
        }
    }

    return output;
}

function normalizeSourceType(value: string | undefined): V8BundleSourceType {
    if (value === "event" || value === "knowledge_md" || value === "skill_md") {
        return value;
    }
    return "knowledge_md";
}

function normalizeKind(value: string | undefined, fallback: V8NodeKind = "semantic"): V8NodeKind {
    if (value === "episodic" || value === "semantic" || value === "procedural") {
        return value;
    }
    return fallback;
}

function sanitizeEncodingContext(
    context: MemoryEncodingContext | null | undefined
): MemoryEncodingContext | null {
    if (!context) {
        return null;
    }

    const goal = sanitizeText(context.goal || "", 180);
    const activeTask = sanitizeText(context.activeTask || "", 160);
    const lastUserRequest = sanitizeText(context.lastUserRequest || "", 180);
    const topNextTasks = dedupeStrings(context.topNextTasks || [], 2, 120);
    const scopeHints = dedupeStrings(context.scopeHints || [], 4, 96);

    if (!goal && !activeTask && !lastUserRequest && topNextTasks.length === 0 && scopeHints.length === 0) {
        return null;
    }

    return {
        goal,
        activeTask,
        lastUserRequest,
        topNextTasks,
        scopeHints,
        recordedAt: sanitizeText(context.recordedAt || "", 48) || new Date().toISOString(),
    };
}

function sanitizeNodeDraft(
    node: V8AnnotationNodeDraft,
    bundleTitle: string,
    bundleKind: V8NodeKind,
    sourceRef: string
): V8SanitizedAnnotationNodeDraft | null {
    const text = sanitizeText(node.text || "", 220);
    if (!text) {
        return null;
    }

    const bilingual = deriveBilingualNodeNames(
        text,
        [bundleTitle, sourceRef, ...(node.sourceRefs || [])],
        {
            explicitZh: node.nameZh,
            explicitEn: node.nameEn,
            explicitAliases: node.aliases || [],
        }
    );

    return {
        kind: normalizeKind(node.kind, bundleKind),
        role: node.role,
        text,
        summary: sanitizeText(node.summary || takeLeadingClause(text, 96), 120),
        names: bilingual.names,
        aliases: bilingual.aliases,
        sourceRefs: dedupeStrings(node.sourceRefs || [], 6, 120),
        confidence: clamp01(node.confidence ?? 0.72, 0.72),
        importance: clamp01(node.importance ?? 0.7, 0.7),
    };
}

function sanitizeEdgeDraft(edge: V8AnnotationEdgeDraft): V8SanitizedAnnotationEdgeDraft {
    return {
        type: edge.type,
        srcRole: edge.srcRole,
        dstRole: edge.dstRole,
        assocStrength: clamp01(edge.assocStrength ?? 0.72, 0.72),
        utility: clamp01(edge.utility ?? 0.72, 0.72),
        trust: clamp01(edge.trust ?? 0.74, 0.74),
        freshness: clamp01(edge.freshness ?? 0.84, 0.84),
        contextFit: clamp01(edge.contextFit ?? 0.8, 0.8),
        evidenceCount: clampPositiveInt(edge.evidenceCount ?? 1, 1),
    };
}

function fallbackEdges(
    nodes: V8SanitizedAnnotationNodeDraft[]
): V8SanitizedAnnotationEdgeDraft[] {
    const topicNode = nodes.find((node) => node.role === "topic");
    if (!topicNode) {
        return [];
    }

    return nodes
        .filter((node) => node.role !== "topic")
        .map((node) => ({
            type: "same_topic" as const,
            srcRole: "topic" as const,
            dstRole: node.role,
            assocStrength: 0.72,
            utility: 0.72,
            trust: 0.74,
            freshness: 0.84,
            contextFit: 0.8,
            evidenceCount: 1,
        }));
}

export function sanitizeAnnotationBundleDraft(
    draft: V8AnnotationBundleDraft
): V8SanitizedAnnotationBundleDraft {
    const sourceType = normalizeSourceType(draft.sourceType);
    const sourceRef = sanitizeText(draft.sourceRef || "", 180);
    const fallbackKind = normalizeKind(draft.kind, sourceType === "event" ? "episodic" : "semantic");
    const title = sanitizeText(draft.title || "", 120) || sourceRef || "untitled-memory";
    const canonicalRef = sanitizeText(draft.canonicalRef || sourceRef || title, 220);
    const summaryRef = sanitizeText(draft.summaryRef || sourceRef || canonicalRef, 220);
    const nodes = (draft.nodes || [])
        .map((node) => sanitizeNodeDraft(node, title, fallbackKind, sourceRef))
        .filter((node): node is V8SanitizedAnnotationNodeDraft => Boolean(node));

    const ensuredNodes =
        nodes.length > 0
            ? nodes
            : [{
                kind: fallbackKind,
                role: "topic" as const,
                text: title,
                summary: takeLeadingClause(title, 96),
                names: deriveBilingualNodeNames(title, [sourceRef]).names,
                aliases: dedupeStrings([title, sourceRef], 4, 96),
                sourceRefs: [],
                confidence: 0.58,
                importance: 0.58,
            }];

    const nodeRoles = new Set(ensuredNodes.map((node) => node.role));
    const normalizedNodes =
        nodeRoles.has("topic")
            ? ensuredNodes
            : [
                {
                    kind: fallbackKind,
                    role: "topic" as const,
                    text: title,
                    summary: takeLeadingClause(title, 96),
                    names: deriveBilingualNodeNames(title, [sourceRef]).names,
                    aliases: dedupeStrings([title, sourceRef], 4, 96),
                    sourceRefs: [],
                    confidence: 0.62,
                    importance: 0.62,
                },
                ...ensuredNodes,
            ];

    const edges = (draft.edges || []).map(sanitizeEdgeDraft);

    return {
        sourceType,
        sourceRef,
        kind: fallbackKind,
        title,
        canonicalRef,
        summaryRef,
        dayKey: draft.dayKey ?? null,
        episodeKey: draft.episodeKey ?? null,
        encodingContext: sanitizeEncodingContext(draft.encodingContext),
        nodes: normalizedNodes,
        edges: edges.length > 0 ? edges : fallbackEdges(normalizedNodes),
        notes: dedupeStrings(draft.notes || [], 8, 180),
    };
}
