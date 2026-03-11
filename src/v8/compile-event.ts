import {
    normalizeUserRequest,
    paths,
    readFileOr,
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
import { deriveBilingualNodeNames } from "./names.js";

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
    /查找/,
    /检索/,
    /搜索/,
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
        .replace(/\b(?:User|Asst|Assistant|System)\s*:/gi, " ")
        .replace(/(?:用户|助手|系统)\s*：/g, " ")
        .replace(/\b(?:HEARTBEAT_OK|Read HEARTBEAT\.md if it exists)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function extractDailyLogFragmentByEventId(markdown: string, eventId: string): string {
    const normalized = (markdown || "").replace(/\r/g, "").trim();
    if (!normalized) return "";
    const marker = `ID: ${eventId}`;
    const sections = normalized
        .split(/\n(?=###\s)/)
        .map((section) => section.trim())
        .filter(Boolean);
    const matched = sections.find((section) => section.includes(marker));
    return matched ? sanitizeMemoryText(matched, 4200) : "";
}

function stripDailyLogScaffolding(text: string, eventId: string): string {
    if (!text) return "";
    const idPattern = new RegExp(`^.*\\bID:\\s*${eventId}\\b.*$`, "im");
    return sanitizeMemoryText(
        text
            .replace(/^###\s.*$/im, " ")
            .replace(idPattern, " "),
        4000
    );
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

function buildBundleTitle(
    event: MemoryEvent,
    normalizedContent: string,
    preferredRequest = ""
): string {
    const fromTask =
        summarizeUserRequestForTask(preferredRequest || event.content, 96) ||
        normalizeUserRequest(preferredRequest || event.content, 96);
    const fromClause = takeLeadingClause(normalizedContent, 96);
    const title = fromTask || fromClause || `${event.type} ${event.id}`;
    return title.slice(0, 96);
}

function extractConversationSlices(content: string): {
    userText: string;
    assistantText: string;
} {
    const raw = content || "";
    const userText =
        raw.match(/(?:^|\n)\s*(?:User|用户)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Asst|Assistant|助手)\s*[:：]|$)/i)?.[1] ||
        "";
    const assistantText =
        raw.match(/(?:^|\n)\s*(?:Asst|Assistant|助手)\s*[:：]\s*([\s\S]*)$/i)?.[1] || "";
    return {
        userText: sanitizeMemoryText(userText, 420),
        assistantText: sanitizeMemoryText(assistantText, 420),
    };
}

function splitIntentPhrases(text: string, maxItems = 8): string[] {
    const cleaned = sanitizeMemoryText(normalizeUserRequest(text, 420), 420);
    if (!cleaned) return [];
    const normalized = cleaned
        .replace(/[，,。；;、\n]/g, "|")
        .replace(/(?:并且|并|然后|再|同时|以及|且|并行|再去)/g, "|")
        .replace(/\s{2,}/g, " ");

    const chunks = normalized
        .split("|")
        .map((item) => sanitizeMemoryText(item, 72))
        .filter((item) => item.length >= 2);

    const expandedChunks = chunks.flatMap((item) => {
        if (item.length <= 24 || !/\s+/.test(item)) {
            return [item];
        }
        return item
            .split(/\s+/)
            .map((part) => sanitizeMemoryText(part, 48))
            .filter((part) => part.length >= 2);
    });

    const semanticHints = [
        cleaned.match(/可视化系统开发|系统开发|可视化/)?.[0] || "",
        cleaned.match(/张宇[^，。;\s]*?(?:三十讲|30讲)|基础三十讲|三十讲/)?.[0] || "",
        cleaned.match(/二重积分/)?.[0] || "",
        cleaned.match(/(?:上网|网上|网络|web)[^，。;\s]{0,8}(?:查找|检索|查询|搜索)|查找|检索|搜索/i)?.[0] || "",
        cleaned.match(/详细总结|总结|不要省略|完整总结/)?.[0] || "",
    ]
        .map((item) => sanitizeMemoryText(item, 48))
        .filter(Boolean);

    const mergedBase = expandedChunks.length > 0 ? expandedChunks : chunks;
    const merged = [...mergedBase, ...semanticHints];
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of merged) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(item);
        if (output.length >= maxItems) break;
    }
    return output;
}

function pickRolePhrase(
    role: V8NodeRole,
    phrases: string[],
    fallback: string
): string {
    const joined = phrases.join(" | ");
    if (!joined) return fallback;

    const roleMatchers: Record<V8NodeRole, RegExp[]> = {
        topic: [/系统|项目|课程|主题|积分|pdf|仓库|字幕|网关|日志|workflow|topic/i],
        workflow: [/查找|检索|搜索|上网|网上|网络|web|查|部署|排查|修复|构建|编译|运行|search|deploy|fix|check/i],
        constraint: [/不要|不能|必须|约束|仅|只|must|must not|do not|never/i],
        condition: [/如果|当|前提|条件|unless|if|when|only when/i],
        evidence: [/错误|报错|日志|路径|文件|证据|error|log|path|file|trace/i],
        checkpoint: [/总结|进度|检查点|恢复|交接|完成|summary|checkpoint|resume|handoff/i],
    };

    const matches = phrases.filter((phrase) =>
        roleMatchers[role].some((pattern) => pattern.test(phrase))
    );
    if (matches.length === 0) {
        return fallback;
    }

    if (role === "checkpoint") {
        return [...matches].sort((a, b) => b.length - a.length)[0];
    }

    return [...matches].sort((a, b) => a.length - b.length)[0];
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

function resolveEventSourceText(workspace: string, event: MemoryEvent): string {
    const dayKey = deriveDayKey(event);
    if (!dayKey) {
        return event.content || "";
    }
    const dailyLogPath = paths(workspace).dailyLog(dayKey);
    const dailyLogContent = readFileOr(dailyLogPath);
    const dailyLogFragment = extractDailyLogFragmentByEventId(dailyLogContent, event.id);
    const cleaned = stripDailyLogScaffolding(dailyLogFragment, event.id);
    return cleaned || dailyLogFragment || event.content || "";
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
    normalizedContent: string,
    userIntentText: string,
    assistantEvidenceText: string,
    intentPhrases: string[]
): string {
    const userFallback = sanitizeMemoryText(userIntentText || normalizedContent, 180) || title;
    switch (role) {
        case "topic":
            return pickRolePhrase("topic", intentPhrases, title);
        case "workflow":
            return pickRolePhrase("workflow", intentPhrases, takeLeadingClause(userFallback, 180) || title);
        case "constraint":
            return pickRolePhrase("constraint", intentPhrases, normalizeUserRequest(userFallback, 180) || title);
        case "condition":
            return pickRolePhrase("condition", intentPhrases, takeLeadingClause(userFallback, 180) || title);
        case "evidence":
            return sanitizeMemoryText(
                assistantEvidenceText || normalizedContent,
                220
            ) || pickRolePhrase("evidence", intentPhrases, userFallback);
        case "checkpoint":
            return pickRolePhrase("checkpoint", intentPhrases, sanitizeMemoryText(userFallback, 180) || title);
    }
}

function buildNode(
    event: MemoryEvent,
    bundle: V8MemoryBundle,
    role: V8NodeRole,
    text: string,
    sourceSeedText: string,
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
    const bilingual = deriveBilingualNodeNames(normalizedText, [
        bundle.title,
        sanitizeMemoryText(sourceSeedText || event.content, 220),
        ...event.tags.filter((tag) => !/^(auto-recorded|semantic-candidate)$/i.test(tag)),
        ...event.associations,
    ]);

    return {
        id: createNodeId(event.id, role),
        bundleId: bundle.bundleId,
        kind: bundle.kind,
        role,
        names: bilingual.names,
        aliases: bilingual.aliases,
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
    const { event, workspace } = input;
    const sourceText = resolveEventSourceText(workspace, event);
    const conversationSlices = extractConversationSlices(sourceText);
    const userIntentText =
        sanitizeMemoryText(
            normalizeUserRequest(conversationSlices.userText || sourceText || event.content, 320),
            320
        ) || sanitizeMemoryText(sourceText || event.content, 320);
    const assistantEvidenceText = sanitizeMemoryText(conversationSlices.assistantText, 320);
    const normalizedContent = sanitizeMemoryText(
        `${userIntentText} ${assistantEvidenceText}`.trim(),
        320
    );
    const intentPhrases = splitIntentPhrases(userIntentText, 10);
    const title = buildBundleTitle(
        event,
        userIntentText || normalizedContent,
        userIntentText
    );
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
        encodingContext: event.encoding_context ?? null,
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
            buildRoleText(
                role,
                event,
                title,
                normalizedContent,
                userIntentText,
                assistantEvidenceText,
                intentPhrases
            ),
            sourceText,
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
