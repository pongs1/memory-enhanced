import {
    normalizeUserRequest,
    summarizeUserRequestForTask,
    type MemoryEvent,
} from "../utils.js";
import type {
    CompileEventInput,
    CompileEventOutput,
    V8EdgeType,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8NodeRole,
} from "./types.js";

const WORKFLOW_PATTERNS = [
    /\bworkflow\b/i,
    /\bsteps?\b/i,
    /\bprocess\b/i,
    /\binstall\b/i,
    /\bdeploy\b/i,
    /\brestore\b/i,
    /\breapply\b/i,
    /\bupdate\b/i,
    /\bpatch\b/i,
    /\bcheck\b/i,
    /\bverify\b/i,
    /流程/,
    /步骤/,
    /安装/,
    /部署/,
    /恢复/,
    /重试/,
    /检查/,
    /验证/,
];
const CONSTRAINT_PATTERNS = [
    /\bmust\b/i,
    /\bmust not\b/i,
    /\bdo not\b/i,
    /\bnever\b/i,
    /\bconstraint\b/i,
    /\bpolicy\b/i,
    /\bprefer(?:ence|red|s)?\b/i,
    /\bdecision\b/i,
    /必须/,
    /不要/,
    /不能/,
    /约束/,
    /规则/,
    /偏好/,
    /决定/,
];
const CHECKPOINT_PATTERNS = [
    /\bcheckpoint\b/i,
    /\bresume\b/i,
    /\bhandoff\b/i,
    /\bnext time\b/i,
    /\bcontinue from\b/i,
    /\bpaused at\b/i,
    /检查点/,
    /恢复点/,
    /交接/,
    /下次/,
    /继续从/,
    /暂停在/,
];
const CONDITION_PATTERNS = [
    /\bif\b/i,
    /\bwhen\b/i,
    /\bonly when\b/i,
    /\bunless\b/i,
    /\bunder\b/i,
    /如果/,
    /当/,
    /只有/,
    /除非/,
    /前提/,
    /条件/,
];
const EVIDENCE_PATTERNS = [
    /\berror\b/i,
    /\bbug\b/i,
    /\broot cause\b/i,
    /\blog\b/i,
    /\bstack\b/i,
    /\btrace\b/i,
    /\bfile\b/i,
    /\bpath\b/i,
    /错误/,
    /报错/,
    /根因/,
    /日志/,
    /文件/,
    /路径/,
];

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function detectLanguage(text: string): "zh" | "en" | "mixed" | "unknown" {
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;

    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > 0 && enCount > 0) return "mixed";
    return zhCount > 0 ? "zh" : "en";
}

function sanitizeMemoryText(text: string, maxChars = 320): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function takeLeadingClause(text: string, maxChars = 96): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return matched.slice(0, maxChars).trim();
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function buildBundleTitle(event: MemoryEvent, normalizedContent: string): string {
    const fromTask =
        summarizeUserRequestForTask(event.content, 96) ||
        normalizeUserRequest(event.content, 96);
    const fromClause = takeLeadingClause(normalizedContent, 96);
    const title = fromTask || fromClause || `${event.type} ${event.id}`;
    return title.slice(0, 96);
}

function extractKeywords(
    text: string,
    tags: string[],
    associations: string[],
    maxItems = 12
): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const raw = [...tags, ...englishWords, ...cjkChunks, ...associations];
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const item of raw) {
        const normalized = sanitizeMemoryText(item, 48).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        keywords.push(normalized);
        if (keywords.length >= maxItems) break;
    }

    return keywords;
}

function deriveDayKey(event: MemoryEvent): string | null {
    if (event.timestamp && /^\d{4}-\d{2}-\d{2}/.test(event.timestamp)) {
        return event.timestamp.slice(0, 10);
    }
    const idMatch = event.id.match(/^evt_(\d{4})(\d{2})(\d{2})_/);
    if (!idMatch) {
        return null;
    }
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
}

function deriveEpisodeKey(
    event: MemoryEvent,
    title: string,
    dayKey: string | null
): string | null {
    const tagSeed = event.tags.find((tag) => tag.trim()) || "";
    const seed = tagSeed || title || event.type || event.id;
    const slug = slugify(seed);
    if (!slug) {
        return dayKey ? `${dayKey}-event` : null;
    }
    return dayKey ? `${dayKey}-${slug}` : slug;
}

function createBundleId(eventId: string): string {
    return `mb_${eventId}`;
}

function createNodeId(eventId: string, role: V8NodeRole): string {
    return `mn_${eventId}_${role}`;
}

function createEdgeId(
    eventId: string,
    srcRole: V8NodeRole,
    dstRole: V8NodeRole,
    type: V8EdgeType
): string {
    return `me_${eventId}_${srcRole}_${type}_${dstRole}`;
}

function shouldAddRole(
    role: V8NodeRole,
    event: MemoryEvent,
    normalizedContent: string
): boolean {
    const text = `${event.type} ${normalizedContent} ${event.tags.join(" ")}`;
    switch (role) {
        case "topic":
            return true;
        case "workflow":
            return event.type === "decision" ||
                event.type === "correction" ||
                WORKFLOW_PATTERNS.some((pattern) => pattern.test(text));
        case "constraint":
            return event.type === "decision" ||
                event.type === "preference" ||
                CONSTRAINT_PATTERNS.some((pattern) => pattern.test(text));
        case "condition":
            return CONDITION_PATTERNS.some((pattern) => pattern.test(text));
        case "evidence":
            return event.type === "error" ||
                event.type === "observation" ||
                event.associations.length > 0 ||
                EVIDENCE_PATTERNS.some((pattern) => pattern.test(text));
        case "checkpoint":
            return event.type === "insight" ||
                CHECKPOINT_PATTERNS.some((pattern) => pattern.test(text));
    }
}

function buildRoleText(
    role: V8NodeRole,
    event: MemoryEvent,
    title: string,
    normalizedContent: string
): string {
    switch (role) {
        case "topic":
            return title;
        case "workflow":
            return takeLeadingClause(normalizedContent, 180) || title;
        case "constraint":
            return normalizeUserRequest(normalizedContent, 180) || title;
        case "condition":
            return takeLeadingClause(normalizedContent, 180) || title;
        case "evidence":
            return sanitizeMemoryText(normalizedContent, 220) || title;
        case "checkpoint":
            return sanitizeMemoryText(normalizedContent, 180) || title;
    }
}

function buildNode(
    event: MemoryEvent,
    bundle: V8MemoryBundle,
    role: V8NodeRole,
    text: string,
    language: V8MemoryNode["language"],
    dayKey: string | null,
    episodeKey: string | null
): V8MemoryNode {
    const importance = clamp01(event.importance);
    const baseConfidenceByRole: Record<V8NodeRole, number> = {
        topic: 0.68,
        workflow: 0.76,
        constraint: 0.8,
        condition: 0.62,
        evidence: 0.74,
        checkpoint: 0.78,
    };
    const normalizedText = sanitizeMemoryText(text, role === "evidence" ? 220 : 180);

    return {
        id: createNodeId(event.id, role),
        bundleId: bundle.bundleId,
        kind: bundle.kind,
        role,
        text: normalizedText,
        summary: takeLeadingClause(normalizedText, 96) || normalizedText,
        keywords: extractKeywords(
            `${event.type} ${normalizedText}`,
            event.tags,
            event.associations
        ),
        language,
        sourceRef: event.id,
        canonicalRef: bundle.canonicalRef,
        confidence: clamp01(Math.max(baseConfidenceByRole[role], importance)),
        importance,
        hitCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        harmCount: 0,
        lastUsedAt: null,
        lastVerifiedAt: event.timestamp || null,
        cooldownUntil: null,
        dayKey,
        episodeKey,
    };
}

function buildEdge(
    event: MemoryEvent,
    srcRole: V8NodeRole,
    dstRole: V8NodeRole,
    type: V8EdgeType,
    srcId: string,
    dstId: string
): V8MemoryEdge {
    const importance = clamp01(event.importance);
    return {
        id: createEdgeId(event.id, srcRole, dstRole, type),
        type,
        src: srcId,
        dst: dstId,
        assocStrength: clamp01(0.55 + importance * 0.3),
        utility: clamp01(0.55 + importance * 0.25),
        trust: clamp01(0.6 + importance * 0.2),
        freshness: 0.9,
        contextFit: 0.75,
        evidenceCount: Math.max(1, event.associations.length),
        activationCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        lastUpdatedAt: event.timestamp,
        lastVerifiedAt: event.timestamp || null,
    };
}

export function compileEventToBundle(
    input: CompileEventInput
): CompileEventOutput {
    const { event } = input;
    const normalizedContent = sanitizeMemoryText(event.content, 320);
    const title = buildBundleTitle(event, normalizedContent);
    const dayKey = deriveDayKey(event);
    const summaryRef = dayKey ? `memory/${dayKey}.md` : "memory";
    const canonicalRef = dayKey ? `${summaryRef}#${event.id}` : `event#${event.id}`;
    const episodeKey = deriveEpisodeKey(event, title, dayKey);
    const language = detectLanguage(`${title} ${normalizedContent}`);
    const bundleId = createBundleId(event.id);
    const now = event.timestamp;

    const bundle: V8MemoryBundle = {
        bundleId,
        sourceType: "event",
        sourceRef: event.id,
        kind: "episodic",
        title,
        nodeIds: [],
        canonicalRef,
        summaryRef,
        dayKey,
        episodeKey,
        createdAt: now,
        updatedAt: now,
    };

    const roles: V8NodeRole[] = ["topic"];
    const orderedOptionalRoles: V8NodeRole[] = [
        "workflow",
        "constraint",
        "condition",
        "evidence",
        "checkpoint",
    ];

    for (const role of orderedOptionalRoles) {
        if (shouldAddRole(role, event, normalizedContent)) {
            roles.push(role);
        }
    }

    if (roles.length === 1) {
        roles.push("evidence");
    }

    const uniqueRoles = Array.from(new Set(roles)).slice(0, 6);
    const nodes = uniqueRoles.map((role) =>
        buildNode(
            event,
            bundle,
            role,
            buildRoleText(role, event, title, normalizedContent),
            language,
            dayKey,
            episodeKey
        )
    );
    bundle.nodeIds = nodes.map((node) => node.id);

    const nodeByRole = new Map(nodes.map((node) => [node.role, node]));
    const edges: V8MemoryEdge[] = [];
    const topicNode = nodeByRole.get("topic");

    if (topicNode) {
        for (const node of nodes) {
            if (node.role === "topic") continue;
            edges.push(
                buildEdge(
                    event,
                    "topic",
                    node.role,
                    "same_topic",
                    topicNode.id,
                    node.id
                )
            );
        }
    }

    const workflowNode = nodeByRole.get("workflow");
    const constraintNode = nodeByRole.get("constraint");
    const conditionNode = nodeByRole.get("condition");
    const checkpointNode = nodeByRole.get("checkpoint");

    if (workflowNode && constraintNode) {
        edges.push(
            buildEdge(
                event,
                "workflow",
                "constraint",
                "constraint",
                workflowNode.id,
                constraintNode.id
            )
        );
    }

    if (conditionNode && workflowNode) {
        edges.push(
            buildEdge(
                event,
                "condition",
                "workflow",
                "valid_when",
                conditionNode.id,
                workflowNode.id
            )
        );
    }

    if (workflowNode && checkpointNode) {
        edges.push(
            buildEdge(
                event,
                "workflow",
                "checkpoint",
                "workflow_next",
                workflowNode.id,
                checkpointNode.id
            )
        );
    }

    return { bundle, nodes, edges };
}
