import type {
    V8AnnotationBundleDraft,
    V8AnnotationEdgeDraft,
    V8AnnotationNodeDraft,
    V8BundleSourceType,
    V8EdgeType,
    V8NodeKind,
    V8NodeRole,
} from "./types.js";
import type { MemoryEncodingContext } from "../utils.js";

function sanitizeText(text: string, maxChars = 220): string {
    return (text || "")
        .replace(/\r/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function takeLeadingClause(text: string, maxChars = 120): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return sanitizeText(matched, maxChars);
}

function isLikelyGarbledTitle(text: string): boolean {
    const value = sanitizeText(text, 160);
    if (!value) return true;
    const questionCount = (value.match(/\?/g) || []).length;
    const replacementCount = (value.match(/\uFFFD/g) || []).length;
    const suspicious = questionCount + replacementCount;
    return suspicious >= Math.max(3, Math.floor(value.length * 0.2));
}

function parseSection(text: string, heading: string): string {
    const lines = text.replace(/\r/g, "").split("\n");
    const startIndex = lines.findIndex((line) => line.trim() === `# ${heading}`);
    if (startIndex < 0) {
        return "";
    }

    const collected: string[] = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("# ")) {
            break;
        }
        collected.push(line);
    }

    return collected.join("\n").trim();
}

function normalizeRole(value: string): V8NodeRole {
    const lower = value.trim().toLowerCase();
    if (lower === "topic" || /主题|topic/.test(lower)) return "topic";
    if (lower === "workflow" || /流程|步骤|workflow/.test(lower)) return "workflow";
    if (lower === "constraint" || /约束|规则|constraint/.test(lower)) return "constraint";
    if (lower === "condition" || /条件|前提|condition/.test(lower)) return "condition";
    if (lower === "evidence" || /证据|线索|evidence/.test(lower)) return "evidence";
    if (lower === "checkpoint" || /检查点|恢复点|交接|checkpoint/.test(lower)) return "checkpoint";
    return "topic";
}

function inferRoleFromMeaning(
    nameZh: string,
    nameEn: string,
    text: string
): V8NodeRole {
    const joined = `${nameZh} ${nameEn} ${text}`.toLowerCase();

    if (/流程|步骤|顺序|工作流|策略|decision|workflow|process|retrieval|summary|恢复顺序|update strategy/.test(joined)) {
        return "workflow";
    }
    if (/条件|前提|适用|范围|路径|目录|scope|path|directory|valid|only when|format requirement/.test(joined)) {
        return "condition";
    }
    if (/证据|线索|清单|列表|枚举|数量|文件数|响应内容|显示|列出|evidence|list|enumeration|count|response content/.test(joined)) {
        return /检查点|checkpoint|count/.test(joined) ? "checkpoint" : "evidence";
    }
    if (/检查点|恢复点|交接|checkpoint|resume point|handoff/.test(joined)) {
        return "checkpoint";
    }
    if (/约束|规则|禁止|必须|constraint|rule|must not|must/.test(joined)) {
        return "constraint";
    }
    return "topic";
}

function normalizeKind(value: string | undefined, fallback: V8NodeKind): V8NodeKind {
    if (value === "episodic" || value === "semantic" || value === "procedural") {
        return value;
    }
    return fallback;
}

function parseNodeBullet(line: string, fallbackKind: V8NodeKind): V8AnnotationNodeDraft | null {
    const clean = line.replace(/^\-\s*/, "").trim();
    if (!clean) return null;

    const parts = clean.split("|").map((part) => sanitizeText(part, 180));
    if (parts.length < 2) return null;

    const [nameZh, nameEn, roleRaw = "topic", why = ""] = parts;
    const text = why || `${nameZh} / ${nameEn}`;
    const normalizedRole = normalizeRole(roleRaw);
    return {
        kind: fallbackKind,
        role: normalizedRole === "topic"
            ? inferRoleFromMeaning(nameZh, nameEn, text)
            : normalizedRole,
        text,
        summary: takeLeadingClause(text, 96),
        nameZh,
        nameEn,
        aliases: [nameZh, nameEn],
    };
}

function parseNodeTableRow(line: string, fallbackKind: V8NodeKind): V8AnnotationNodeDraft | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) return null;
    if (/^\|\s*-+/.test(trimmed)) return null;

    const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((cell) => sanitizeText(cell, 180));

    if (cells.length < 4) return null;

    const [nameZh, nameEn, roleRaw, why] = cells;
    const headerJoined = `${nameZh} ${nameEn} ${roleRaw}`.toLowerCase();
    if (/zh name|en name|tentative role|what part/.test(headerJoined)) {
        return null;
    }

    const text = why || `${nameZh} / ${nameEn}`;
    const normalizedRole = normalizeRole(roleRaw);
    return {
        kind: fallbackKind,
        role: normalizedRole === "topic"
            ? inferRoleFromMeaning(nameZh, nameEn, text)
            : normalizedRole,
        text,
        summary: takeLeadingClause(text, 96),
        nameZh,
        nameEn,
        aliases: [nameZh, nameEn],
    };
}

function mapRelationToEdgeType(family: string, label: string): V8EdgeType {
    const joined = `${family} ${label}`.toLowerCase();
    if (/causal|cause|trigger|导致|触发/.test(joined)) return "causal";
    if (/temporal|before|after|next|先后|时序/.test(joined)) return "workflow_next";
    if (/condition|valid|invalid|前提|条件/.test(joined)) {
        return /invalid|不适用|失效/.test(joined) ? "invalid_when" : "valid_when";
    }
    if (/same|identity|alias|共指|同一/.test(joined)) return "same_topic";
    if (/supersede|replace|弃用|取代/.test(joined)) return "supersedes";
    if (/constraint|must|禁止|约束/.test(joined)) return "constraint";
    return "associative";
}

function parseWeight(value: string): number | undefined {
    const num = Number(value.trim());
    if (!Number.isFinite(num)) return undefined;
    return Math.max(0, Math.min(1, num));
}

function parseRelationRow(line: string): V8AnnotationEdgeDraft | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) return null;
    if (/^\|\s*-+/.test(trimmed)) return null;

    const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((cell) => sanitizeText(cell, 180));

    if (cells.length < 8) return null;

    const [, srcRole, , dstRole, family, label, weightText] = cells;
    if (!srcRole || !dstRole || !family || !label) return null;

    return {
        type: mapRelationToEdgeType(family, label),
        srcRole: normalizeRole(srcRole),
        dstRole: normalizeRole(dstRole),
        assocStrength: parseWeight(weightText),
        utility: parseWeight(weightText),
        trust: parseWeight(weightText),
        freshness: 0.84,
        contextFit: 0.8,
        evidenceCount: 1,
    };
}

export interface BuildDraftFromStageMarkdownInput {
    sourceType: V8BundleSourceType;
    sourceRef: string;
    kindHint?: V8NodeKind;
    titleHint?: string;
    canonicalRef?: string;
    summaryRef?: string;
    dayKey?: string | null;
    episodeKey?: string | null;
    encodingContext?: MemoryEncodingContext | null;
    sceneDraft: string;
    relationDraft: string;
}

export function buildDraftFromStageMarkdown(
    input: BuildDraftFromStageMarkdownInput
): V8AnnotationBundleDraft {
    const fallbackKind = normalizeKind(input.kindHint, input.sourceType === "event" ? "episodic" : "semantic");
    const coreNodesSection = parseSection(input.sceneDraft, "Core Nodes");
    const sceneSection = parseSection(input.sceneDraft, "Scene Snapshot");
    const elementsSection = parseSection(input.sceneDraft, "Elements");
    const relationSection = parseSection(input.relationDraft, "Relation Candidates");

    const nodes = coreNodesSection
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("|")) {
                return parseNodeTableRow(trimmed, fallbackKind);
            }
            return parseNodeBullet(line, fallbackKind);
        })
        .filter((node): node is V8AnnotationNodeDraft => Boolean(node));

    const edges = relationSection
        .split(/\r?\n/)
        .map((line) => parseRelationRow(line))
        .filter((edge): edge is V8AnnotationEdgeDraft => Boolean(edge));

    const titleHint = sanitizeText(input.titleHint || "", 120);
    const title =
        (!isLikelyGarbledTitle(titleHint) ? titleHint : "") ||
        takeLeadingClause(sceneSection, 120) ||
        nodes[0]?.nameZh ||
        input.sourceRef;

    return {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        kind: fallbackKind,
        title,
        canonicalRef: sanitizeText(input.canonicalRef || input.sourceRef, 220),
        summaryRef: sanitizeText(input.summaryRef || input.sourceRef, 220),
        dayKey: input.dayKey ?? null,
        episodeKey: input.episodeKey ?? null,
        encodingContext: input.encodingContext ?? null,
        nodes,
        edges,
        notes: [
            sanitizeText(sceneSection, 200),
            sanitizeText(elementsSection, 200),
        ].filter(Boolean),
    };
}
