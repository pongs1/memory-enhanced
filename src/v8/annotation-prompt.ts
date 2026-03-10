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

function renderContextBlocks(blocks: V8AnnotationContextBlock[]): string {
    if (blocks.length === 0) {
        return "(none)";
    }

    return blocks
        .map((block) => `## ${block.label}\n${sanitizeText(block.text, 2400)}`)
        .join("\n\n");
}

export interface V8AnnotationContextBlock {
    label: string;
    text: string;
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
    contextBlocks?: V8AnnotationContextBlock[];
}

export interface V8AnnotationPromptMessages {
    system: string;
    user: string;
}

export interface V8AnnotationWorkflowStagePrompt {
    stage: "scene" | "relations" | "bundle_draft";
    goal: string;
    messages: V8AnnotationPromptMessages;
}

export interface V8AnnotationStage2Input extends V8AnnotationPromptInput {
    sceneDraft: string;
}

export interface V8AnnotationStage3Input extends V8AnnotationPromptInput {
    sceneDraft: string;
    relationDraft: string;
}

export function buildSceneReconstructionPrompt(
    input: V8AnnotationPromptInput
): V8AnnotationPromptMessages {
    const metadata = {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        kindHint: input.kindHint || null,
        titleHint: input.titleHint || null,
        dayKey: input.dayKey ?? null,
        episodeKeyHint: input.episodeKeyHint ?? null,
        targetNodeBudget: input.targetNodeBudget ?? 4,
        sourceSummary: input.sourceSummary || null,
    };

    return {
        system: [
            "Job: reconstruct the scene around one source memory item and name only the few core nodes worth keeping.",
            "",
            "Do this first, before trying to emit final graph JSON.",
            "Focus on what was happening, why it mattered, and which 2-6 concepts should survive into long-term memory.",
            "",
            "Rules:",
            "- Do not invent facts outside the provided source and context.",
            "- Keep the node set sparse.",
            "- Each node should have one Chinese name and one English name for the same concept.",
            "- Do not split zh/en names into separate nodes.",
            "- No JSON is required in this stage.",
            "- Short markdown sections are enough.",
        ].join("\n"),
        user: [
            "Step 1: restore the original scene and extract the core nodes.",
            "",
            "Metadata hints:",
            formatJson(metadata),
            "",
            "Context blocks:",
            renderContextBlocks(input.contextBlocks || []),
            "",
            "Source text:",
            '"""',
            sanitizeText(input.sourceText, 12000),
            '"""',
            "",
            "Output only these short sections:",
            "",
            "# Scene",
            "- what was happening",
            "- what the task/problem was",
            "- why this memory matters later",
            "",
            "# Core Nodes",
            "- zh name | en name | tentative role | why it matters",
            "",
            "Keep it sparse. Prefer 2-6 nodes. Skip decorative details.",
        ].join("\n"),
    };
}

export function buildRelationScoringPrompt(
    input: V8AnnotationStage2Input
): V8AnnotationPromptMessages {
    return {
        system: [
            "Job: connect the core nodes discovered in stage 1.",
            "",
            "Only keep relations that are explicit in the source or strongly justified by the same local scene.",
            "This stage is about relation meaning and initial weight, not final graph JSON.",
            "",
            "Rules:",
            `- Allowed edge types: ${allowedList(ALLOWED_EDGE_TYPES)}`,
            "- Give one initial weight between 0 and 1 for each relation.",
            "- If a relation is weak or speculative, omit it.",
            "- Keep the relation set sparse.",
            "- No JSON is required in this stage.",
        ].join("\n"),
        user: [
            "Step 2: score the relations between the core nodes.",
            "",
            "Stage 1 result:",
            '"""',
            sanitizeText(input.sceneDraft, 12000),
            '"""',
            "",
            "Original source text for grounding:",
            '"""',
            sanitizeText(input.sourceText, 10000),
            '"""',
            "",
            "Output only this short section:",
            "",
            "# Relations",
            "- src zh/en -> dst zh/en | edge type | initial weight 0-1 | short reason",
            "",
            "Prefer only the few relations that would actually matter for future recall.",
        ].join("\n"),
    };
}

export function buildBundleDraftPrompt(
    input: V8AnnotationStage3Input
): V8AnnotationPromptMessages {
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

    return {
        system: [
            "Job: compile the approved scene and relation analysis into one V8 annotation bundle draft.",
            "",
            "This is the first stage that must return strict JSON.",
            "Do not rediscover the scene from scratch. Reuse the node set and relations already extracted.",
            "",
            "Rules:",
            "- Return exactly one JSON object.",
            "- Do not wrap it in markdown fences.",
            `- Allowed node kinds: ${allowedList(ALLOWED_NODE_KINDS)}`,
            `- Allowed node roles: ${allowedList(ALLOWED_NODE_ROLES)}`,
            `- Allowed edge types: ${allowedList(ALLOWED_EDGE_TYPES)}`,
            "- Keep bilingual names on the same node.",
            "- Do not create extra nodes just because two languages exist.",
            "- Prefer sparse durable structure over exhaustive extraction.",
            "- If uncertain, put the uncertainty in `notes`.",
        ].join("\n"),
        user: [
            "Step 3: convert the approved scene and relation analysis into one JSON bundle draft.",
            "",
            "Metadata hints:",
            formatJson(metadata),
            "",
            "Stage 1 scene result:",
            '"""',
            sanitizeText(input.sceneDraft, 12000),
            '"""',
            "",
            "Stage 2 relation result:",
            '"""',
            sanitizeText(input.relationDraft, 12000),
            '"""',
            "",
            "Original source text:",
            '"""',
            sanitizeText(input.sourceText, 10000),
            '"""',
            "",
            "Return one JSON object using this shape:",
            formatJson(outputSkeleton),
            "",
            "Remember:",
            "- bilingual names stay on the same node",
            "- use only the core nodes and relations that survived stages 1 and 2",
            "- JSON only",
        ].join("\n"),
    };
}

export function buildOfflineAnnotationWorkflow(
    input: V8AnnotationPromptInput
): V8AnnotationWorkflowStagePrompt[] {
    return [
        {
            stage: "scene",
            goal: "Reconstruct the source scene and extract the few core nodes worth keeping.",
            messages: buildSceneReconstructionPrompt(input),
        },
        {
            stage: "relations",
            goal: "Score only the sparse relations that matter between the core nodes.",
            messages: buildRelationScoringPrompt({
                ...input,
                sceneDraft: "(fill with stage 1 output)",
            }),
        },
        {
            stage: "bundle_draft",
            goal: "Compile the approved scene and relations into one sanitized-ready JSON draft.",
            messages: buildBundleDraftPrompt({
                ...input,
                sceneDraft: "(fill with stage 1 output)",
                relationDraft: "(fill with stage 2 output)",
            }),
        },
    ];
}
