import type {
    V8BundleSourceType,
    V8NodeKind,
} from "./types.js";
import type { MemoryEncodingContext } from "../utils.js";

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
    encodingContext?: MemoryEncodingContext | null;
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

export interface V8InterMemoryPromptInput {
    memories: Array<{
        sourceRef: string;
        title?: string;
        summary?: string;
        scene?: string;
        nodeDraft?: string;
    }>;
    contextBlocks?: V8AnnotationContextBlock[];
}

export interface V8AnnotationStage2Input extends V8AnnotationPromptInput {
    sceneDraft: string;
}

export interface V8AnnotationStage3Input extends V8AnnotationPromptInput {
    sceneDraft: string;
    relationDraft: string;
}

function renderEncodingContextCue(context: MemoryEncodingContext | null | undefined): string {
    if (!context) {
        return "(none)";
    }

    const lines = [
        `- goal: ${sanitizeText(context.goal || "", 180) || "(unknown)"}`,
        `- active task: ${sanitizeText(context.activeTask || "", 160) || "(unknown)"}`,
        `- last user request: ${sanitizeText(context.lastUserRequest || "", 180) || "(unknown)"}`,
    ];

    if ((context.topNextTasks || []).length > 0) {
        lines.push(`- next tasks: ${(context.topNextTasks || []).map((item) => sanitizeText(item, 120)).filter(Boolean).join(" ; ")}`);
    }

    if ((context.scopeHints || []).length > 0) {
        lines.push(`- scope hints: ${(context.scopeHints || []).map((item) => sanitizeText(item, 96)).filter(Boolean).join(" ; ")}`);
    }

    if (context.recordedAt) {
        lines.push(`- recorded at: ${sanitizeText(context.recordedAt, 48)}`);
    }

    return lines.join("\n");
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
            "Job: restore the local scene around one source memory item, then pull out only the few core nodes worth keeping.",
            "",
            "Focus on the concrete scene first: what was happening, which elements were present, what changed, what blocked progress, what should be recoverable later.",
            "",
            "Rules:",
            "- Do not invent facts outside the provided source and context.",
            "- Keep the node set sparse.",
            "- Each node should have one Chinese name and one English name for the same concept.",
            "- Do not split zh/en names into separate nodes.",
            "- Historical task cues are only scene hints. Do not copy them as hard limits on what the memory can generalize to.",
            "- Use a short markdown template only.",
        ].join("\n"),
        user: [
            "Step 1: restore the original scene and extract the core nodes.",
            "",
            "Metadata hints:",
            formatJson(metadata),
            "",
            "Historical task cue from record time:",
            renderEncodingContextCue(input.encodingContext),
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
            "# Scene Snapshot",
            "- what was happening",
            "- current state / trigger / turning point",
            "- explicit goal, subgoal, or blocking point",
            "- why it mattered",
            "",
            "# Elements",
            "- actors / agents / roles",
            "- objects / files / paths / APIs / tools / docs / models",
            "- place / scope / module / repo / workspace / environment",
            "- explicit emotion / stance / urgency / risk if present",
            "",
            "# Core Nodes",
            "- zh name | en name | tentative role | what part of the scene it preserves",
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
            "Job: connect the core nodes discovered in stage 1 using the deeper relations hidden in the same scene.",
            "",
            "Do not stop at plain semantic similarity.",
            "Prefer relations such as:",
            "- identity / same referent / alias / role equivalence",
            "- temporal order or overlap",
            "- causal or diagnostic relation",
            "- subevent / part-whole / dependency",
            "- participant role relation",
            "- condition / prerequisite / valid-when",
            "- evidence / support / contradiction",
            "- spatial or scope relation",
            "- stance / affect / urgency relation when explicit",
            "- goal-support or plan-step relation",
            "",
            "Rules:",
            "- Give one initial weight between 0 and 1 for each relation.",
            "- If a relation is weak or speculative, omit it.",
            "- Keep the relation set sparse.",
            "- Use the relation template below.",
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
            "# Relation Candidates",
            "| src node | src role | dst node | dst role | relation family | relation label | initial weight | evidence from scene |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 节点A / Node A | workflow | 节点B / Node B | evidence | causal | causes / triggered-by | 0.82 | short evidence |",
            "",
            "Only keep the few relations that would actually help later recovery.",
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
            "Job: compile the approved scene and relation analysis into one final structured draft.",
            "",
            "Do not rediscover the scene from scratch. Reuse the nodes and relations already extracted.",
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

export function buildInterMemoryRelationPrompt(
    input: V8InterMemoryPromptInput
): V8AnnotationPromptMessages {
    const memoryList = input.memories.map((memory, index) => ({
        id: `memory_${index + 1}`,
        sourceRef: memory.sourceRef,
        title: memory.title || null,
        summary: memory.summary || null,
        scene: memory.scene || null,
        nodeDraft: memory.nodeDraft || null,
    }));

    return {
        system: [
            "Job: look across multiple memory items, restore the larger shared scene, and identify the important links between memories.",
            "",
            "Focus on cross-memory relations, not single-memory internal structure.",
            "Prefer deeper links such as temporal chain, causal chain, shared checkpoint, conflicting policy, same actor/object, same workflow branch, supersession, or recovery dependency.",
            "",
            "Rules:",
            "- Do not invent links that are not justified by the provided memory material.",
            "- Keep the link set sparse.",
            "- Use initial weights between 0 and 1.",
            "- Use the markdown template below.",
        ].join("\n"),
        user: [
            "Compare the following memory items and recover the important relations between them.",
            "",
            "Context blocks:",
            renderContextBlocks(input.contextBlocks || []),
            "",
            "Memory items:",
            formatJson(memoryList),
            "",
            "Output only these sections:",
            "",
            "# Shared Scene",
            "- what larger situation these memories belong to",
            "- what common actors / artifacts / goals / risks appear across them",
            "",
            "# Cross-Memory Links",
            "| memory A | memory B | linked nodes or concepts | relation family | relation label | initial weight | reason |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| memory_1 | memory_2 | 节点A <-> 节点B | temporal | before / after | 0.78 | short reason |",
            "",
            "# Candidate Shared Nodes",
            "- zh name | en name | comes from which memories | why it should exist as a shared node or bridge",
        ].join("\n"),
    };
}
