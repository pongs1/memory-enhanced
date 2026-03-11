import type {
    V8AnnotationEdgeDraft,
    V8AnnotationNodeDraft,
    V8ClusterDiagnosis,
    V8ClusterRebuildDraft,
    V8EdgeType,
    V8NodeKind,
    V8NodeRole,
} from "./types.js";

function sanitizeText(text: string, maxChars = 220): string {
    return (text || "")
        .replace(/\r/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function parseSection(text: string, heading: string): string {
    const lines = text.replace(/\r/g, "").split("\n");
    const startIndex = lines.findIndex((line) => line.trim() === `# ${heading}`);
    if (startIndex < 0) return "";
    const collected: string[] = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("# ")) break;
        collected.push(line);
    }
    return collected.join("\n").trim();
}

function parseTableRows(section: string): string[][] {
    return section
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
        .map((line) =>
            line
                .split("|")
                .slice(1, -1)
                .map((cell) => sanitizeText(cell, 240))
        )
        .filter((cells) =>
            cells.length >= 2 &&
            !/node id|zh name|src node/i.test(cells[0]) &&
            !/^\(none\)$/i.test(cells[0])
        );
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

function normalizeKind(value: string): V8NodeKind {
    if (value === "episodic" || value === "semantic" || value === "procedural") {
        return value;
    }
    return "semantic";
}

function normalizeEdgeType(value: string): V8EdgeType {
    const lower = value.trim().toLowerCase();
    if (lower === "causal") return "causal";
    if (lower === "constraint") return "constraint";
    if (lower === "workflow_next") return "workflow_next";
    if (lower === "same_topic") return "same_topic";
    if (lower === "supersedes") return "supersedes";
    if (lower === "valid_when") return "valid_when";
    if (lower === "invalid_when") return "invalid_when";
    return "associative";
}

function parseWeight(value: string): number | undefined {
    const num = Number(value);
    if (!Number.isFinite(num)) return undefined;
    return Math.max(0, Math.min(1, num));
}

export function buildClusterRebuildDraftFromMarkdown(input: {
    diagnosis: V8ClusterDiagnosis;
    sceneDraft: string;
    rebuildDraft: string;
}): V8ClusterRebuildDraft {
    const preserveRows = parseTableRows(parseSection(input.rebuildDraft, "Preserve Nodes"));
    const dropRows = parseTableRows(parseSection(input.rebuildDraft, "Drop Nodes"));
    const rebuiltNodeRows = parseTableRows(parseSection(input.rebuildDraft, "Rebuilt Nodes"));
    const rebuiltRelationRows = parseTableRows(parseSection(input.rebuildDraft, "Rebuilt Relations"));
    const rationaleSection = parseSection(input.rebuildDraft, "Rationale");

    const rebuiltNodes: V8AnnotationNodeDraft[] = [];
    for (const cells of rebuiltNodeRows) {
        const [nameZh, nameEn, role, kind, text, summary] = cells;
        if (!nameZh || !nameEn || !text) continue;
        rebuiltNodes.push({
                kind: normalizeKind(kind),
                role: normalizeRole(role),
                text,
                summary,
                nameZh,
                nameEn,
                aliases: [nameZh, nameEn],
            });
    }

    const rebuiltEdges: V8AnnotationEdgeDraft[] = [];
    for (const cells of rebuiltRelationRows) {
        const [, srcRole, , dstRole, edgeType, weight] = cells;
        if (!srcRole || !dstRole || !edgeType) continue;
        rebuiltEdges.push({
                type: normalizeEdgeType(edgeType),
                srcRole: normalizeRole(srcRole),
                dstRole: normalizeRole(dstRole),
                assocStrength: parseWeight(weight),
                utility: parseWeight(weight),
                trust: parseWeight(weight),
                freshness: 0.82,
                contextFit: 0.78,
                evidenceCount: 1,
            });
    }

    return {
        clusterId: input.diagnosis.clusterId,
        preservedNodeIds: preserveRows.map((row) => row[0]).filter(Boolean),
        droppedNodeIds: dropRows.map((row) => row[0]).filter(Boolean),
        rebuiltNodes,
        rebuiltEdges,
        rationale: [
            ...rationaleSection
                .split(/\r?\n/)
                .map((line) => sanitizeText(line.replace(/^\-\s*/, ""), 200))
                .filter(Boolean),
        ],
    };
}
