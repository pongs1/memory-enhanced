import type {
    V8BundleSourceType,
    V8NodeKind,
} from "./types.js";

const ALLOWED_NODE_KINDS = ["episodic", "semantic", "procedural"] as const;
const ALLOWED_NODE_ROLES = [
    "topic",
    "workflow",
    "constraint",
    "condition",
    "evidence",
    "checkpoint",
] as const;
const ALLOWED_EDGE_TYPES = [
    "associative",
    "causal",
    "constraint",
    "workflow_next",
    "same_topic",
    "supersedes",
    "valid_when",
    "invalid_when",
] as const;

function sanitizeText(text: string, maxChars = 8000): string {
    return (text || "")
        .replace(/\r/g, "")
        .trim()
        .slice(0, maxChars);
}

function formatJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function allowedList(values: readonly string[]): string {
    return values.map((value) => `\`${value}\``).join(", ");
}

export interface V8AnnotationPromptInput {
    sourceType: V8BundleSourceType;
    sourceRef: string;
    sourceText: string;
    sourceSummary?: string;
    kindHint?: V8NodeKind;
    titleHint?: string;
    canonicalRef?: string;
    summaryRef?: string;
    dayKey?: string | null;
    episodeKeyHint?: string | null;
    targetNodeBudget?: number;
}

export interface V8AnnotationPromptMessages {
    system: string;
    user: string;
}

export function buildOfflineAnnotationSystemPrompt(): string {
    return [
        "You are the sleep-phase graph annotator for the memory-enhanced V8 memory system.",
        "Your job is to convert one source memory item into a sparse annotation draft for later sanitization and compilation.",
        "",
        "Primary goal:",
        "- Preserve durable structure that will help future recall.",
        "- Do not restate the entire source verbatim.",
        "- Prefer a small sparse node bundle over a dense graph.",
        "",
        "Output contract:",
        "- Return exactly one JSON object.",
        "- Do not wrap the JSON in markdown fences.",
        "- Do not add commentary before or after the JSON.",
        "",
        "Allowed top-level fields:",
        "- sourceType",
        "- sourceRef",
        "- kind",
        "- title",
        "- canonicalRef",
        "- summaryRef",
        "- dayKey",
        "- episodeKey",
        "- nodes",
        "- edges",
        "- notes",
        "",
        "Node rules:",
        `- Allowed node kinds: ${allowedList(ALLOWED_NODE_KINDS)}`,
        `- Allowed node roles: ${allowedList(ALLOWED_NODE_ROLES)}`,
        "- Prefer 2-6 nodes unless the source is extremely simple.",
        "- Each node should contain one locally reusable idea, not a paragraph dump.",
        "- `text` should be short and concrete.",
        "- `summary` should be shorter than `text`.",
        "",
        "Critical bilingual naming rules:",
        "- Every node represents one concept with equivalent bilingual handles, not two separate nodes.",
        "- Fill both `nameZh` and `nameEn` whenever possible.",
        "- `nameZh` and `nameEn` must refer to the same concept, role, and scope.",
        "- Do NOT split one concept into separate Chinese and English nodes.",
        "- If a proper noun, code symbol, API name, or acronym should stay unchanged, you may reuse the same string in both languages.",
        "- `aliases` may include shorthand, older labels, bilingual variants, or handoff terms.",
        "",
        "Edge rules:",
        `- Allowed edge types: ${allowedList(ALLOWED_EDGE_TYPES)}`,
        "- Only create edges you can justify from the source.",
        "- Sparse edges are better than speculative edges.",
        "- If uncertain, omit the edge instead of hallucinating.",
        "",
        "Grounding rules:",
        "- Use only information present in the source text and explicit metadata hints.",
        "- Do not invent facts, hidden causes, dates, or file paths.",
        "- If something is likely but not explicit, place that uncertainty in `notes` instead of asserting it as a node or edge.",
        "- Do not create cross-source links here unless they are explicitly provided in the source material.",
        "",
        "Quality rules:",
        "- Make the title concise and reusable across sessions.",
        "- Prefer durable structure: workflow, constraint, condition, evidence, checkpoint.",
        "- Avoid duplicates: two nodes should not say the same thing with minor wording changes.",
        "- If the source is mainly a workflow, ensure the bundle exposes the workflow clearly.",
        "- If the source includes a restart point or handoff state, preserve it.",
        "",
        "Your JSON will be sanitized later, but you should still try to produce clean data now.",
    ].join("\n");
}

export function buildOfflineAnnotationUserPrompt(
    input: V8AnnotationPromptInput
): string {
    const metadata = {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        kindHint: input.kindHint || null,
        titleHint: input.titleHint || null,
        canonicalRef: input.canonicalRef || null,
        summaryRef: input.summaryRef || null,
        dayKey: input.dayKey ?? null,
        episodeKeyHint: input.episodeKeyHint ?? null,
        targetNodeBudget: input.targetNodeBudget ?? 4,
        sourceSummary: input.sourceSummary || null,
    };

    const outputSkeleton = {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        kind: input.kindHint || "semantic",
        title: input.titleHint || "concise bundle title",
        canonicalRef: input.canonicalRef || input.sourceRef,
        summaryRef: input.summaryRef || input.sourceRef,
        dayKey: input.dayKey ?? null,
        episodeKey: input.episodeKeyHint ?? null,
        nodes: [
            {
                kind: input.kindHint || "semantic",
                role: "topic",
                text: "short normalized node text",
                summary: "shorter summary",
                nameZh: "等效中文名",
                nameEn: "equivalent english name",
                aliases: ["optional alias"],
                sourceRefs: [],
                confidence: 0.72,
                importance: 0.7,
            },
        ],
        edges: [
            {
                type: "same_topic",
                srcRole: "topic",
                dstRole: "workflow",
                assocStrength: 0.72,
                utility: 0.72,
                trust: 0.74,
                freshness: 0.84,
                contextFit: 0.8,
                evidenceCount: 1,
            },
        ],
        notes: ["optional uncertainty or naming note"],
    };

    return [
        "Annotate the following single source item into one V8 annotation bundle draft.",
        "",
        "Metadata hints:",
        formatJson(metadata),
        "",
        "Source text:",
        '"""',
        sanitizeText(input.sourceText, 12000),
        '"""',
        "",
        "Return one JSON object using this shape:",
        formatJson(outputSkeleton),
        "",
        "Reminder:",
        "- Use bilingual equivalent node names.",
        "- Do not split Chinese and English names into separate nodes.",
        "- Prefer sparse durable structure over exhaustive extraction.",
        "- JSON only.",
    ].join("\n");
}

export function buildOfflineAnnotationMessages(
    input: V8AnnotationPromptInput
): V8AnnotationPromptMessages {
    return {
        system: buildOfflineAnnotationSystemPrompt(),
        user: buildOfflineAnnotationUserPrompt(input),
    };
}
