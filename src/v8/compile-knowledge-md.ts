import * as path from "node:path";
import { readFileOr } from "../utils.js";
import type {
    CompileKnowledgeMdInput,
    CompileKnowledgeMdOutput,
    V8EdgeType,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8NodeKind,
    V8NodeRole,
} from "./types.js";
import { deriveBilingualNodeNames } from "./names.js";

interface MemoryNodeBlock {
    id: string;
    kind: V8NodeKind;
    role: V8NodeRole;
    confidence: number;
    importance: number;
    sourceRefs: string[];
    nameZh?: string;
    nameEn?: string;
    aliases: string[];
    text: string;
}

const WORKFLOW_PATTERNS = [
    /\bworkflow\b/i,
    /\bsteps?\b/i,
    /\bprocess\b/i,
    /\binstall\b/i,
    /\bdeploy\b/i,
    /\brestore\b/i,
    /\bupdate\b/i,
    /\bpatch\b/i,
    /流程/,
    /步骤/,
    /安装/,
    /部署/,
    /恢复/,
    /更新/,
    /补丁/,
];
const CONSTRAINT_PATTERNS = [
    /\bmust\b/i,
    /\bmust not\b/i,
    /\bdo not\b/i,
    /\bnever\b/i,
    /\bpolicy\b/i,
    /\bconstraint\b/i,
    /\bprefer(?:ence|red|s)?\b/i,
    /必须/,
    /不要/,
    /不能/,
    /约束/,
    /规则/,
    /偏好/,
];
const CONDITION_PATTERNS = [
    /\bif\b/i,
    /\bwhen\b/i,
    /\bunless\b/i,
    /\bunder\b/i,
    /如果/,
    /当/,
    /除非/,
    /条件/,
];
const EVIDENCE_PATTERNS = [
    /\bfile\b/i,
    /\bpath\b/i,
    /\blog\b/i,
    /\berror\b/i,
    /\btrace\b/i,
    /文件/,
    /路径/,
    /日志/,
    /错误/,
];
const CHECKPOINT_PATTERNS = [
    /\bcheckpoint\b/i,
    /\bresume\b/i,
    /\bhandoff\b/i,
    /\bnext\b/i,
    /检查点/,
    /恢复/,
    /交接/,
    /下次/,
];

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function sanitizeText(text: string, maxChars = 320): string {
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

function detectLanguage(text: string): "zh" | "en" | "mixed" | "unknown" {
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > 0 && enCount > 0) return "mixed";
    return zhCount > 0 ? "zh" : "en";
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function parseSourceRefs(value: string): string[] {
    const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!inner) return [];
    return inner
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
}

function parseMetadata(raw: string): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
        if (!match) continue;
        metadata[match[1]] = match[2];
    }
    return metadata;
}

function normalizeKind(value: string | undefined): V8NodeKind {
    if (value === "episodic" || value === "semantic" || value === "procedural") {
        return value;
    }
    return "semantic";
}

function normalizeRole(value: string | undefined, text: string): V8NodeRole {
    if (
        value === "topic" ||
        value === "workflow" ||
        value === "constraint" ||
        value === "condition" ||
        value === "evidence" ||
        value === "checkpoint"
    ) {
        return value;
    }

    if (WORKFLOW_PATTERNS.some((pattern) => pattern.test(text))) return "workflow";
    if (CONSTRAINT_PATTERNS.some((pattern) => pattern.test(text))) return "constraint";
    if (CONDITION_PATTERNS.some((pattern) => pattern.test(text))) return "condition";
    if (CHECKPOINT_PATTERNS.some((pattern) => pattern.test(text))) return "checkpoint";
    if (EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) return "evidence";
    return "topic";
}

function extractKeywords(text: string, maxItems = 12): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const raw = [...englishWords, ...cjkChunks];
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const item of raw) {
        const normalized = sanitizeText(item, 48).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        keywords.push(normalized);
        if (keywords.length >= maxItems) break;
    }

    return keywords;
}

function buildBlockId(fileBase: string, title: string, ordinal: number): string {
    const slug = slugify(title) || `block-${ordinal}`;
    return `${fileBase}-${slug}-${ordinal}`;
}

function parseStructuredBlocks(content: string, fileBase: string): MemoryNodeBlock[] {
    const blocks: MemoryNodeBlock[] = [];
    const regex =
        /<!--\s*memory-node([\s\S]*?)-->\s*([\s\S]*?)<!--\s*\/memory-node\s*-->/gi;

    let match: RegExpExecArray | null;
    let ordinal = 0;
    while ((match = regex.exec(content)) !== null) {
        ordinal += 1;
        const metadata = parseMetadata(match[1] || "");
        const text = sanitizeText(match[2] || "", 400);
        if (!text) continue;

        blocks.push({
            id: buildBlockId(fileBase, text, ordinal),
            kind: normalizeKind(metadata.kind),
            role: normalizeRole(metadata.role, text),
            confidence: clamp01(Number(metadata.confidence) || 0.72),
            importance: clamp01(Number(metadata.importance) || 0.7),
            sourceRefs: parseSourceRefs(metadata.source_refs || metadata.sourceRefs || ""),
            nameZh: sanitizeText(metadata.name_zh || metadata.nameZh || "", 72),
            nameEn: sanitizeText(metadata.name_en || metadata.nameEn || "", 72),
            aliases: parseSourceRefs(metadata.aliases || ""),
            text,
        });
    }

    return blocks;
}

function parseFallbackSections(content: string, fileBase: string): MemoryNodeBlock[] {
    const lines = content.split(/\r?\n/);
    const topTitle =
        lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim() ||
        fileBase;
    const sections = content.split(/^##\s+/m).map((chunk) => chunk.trim()).filter(Boolean);

    const blocks: MemoryNodeBlock[] = [];
    let ordinal = 0;

    if (sections.length <= 1) {
        const clean = sanitizeText(content, 480);
        if (!clean) return [];
        blocks.push({
            id: buildBlockId(fileBase, topTitle, 1),
            kind: WORKFLOW_PATTERNS.some((pattern) => pattern.test(clean))
                ? "procedural"
                : "semantic",
            role: normalizeRole(undefined, clean),
            confidence: 0.62,
            importance: 0.64,
            sourceRefs: [],
            aliases: [],
            text: clean,
        });
        return blocks;
    }

    for (const section of sections) {
        ordinal += 1;
        const [headingLine, ...bodyLines] = section.split(/\r?\n/);
        const heading = sanitizeText(headingLine || "", 120);
        const body = sanitizeText(bodyLines.join("\n"), 360);
        const text = sanitizeText(`${heading}. ${body}`, 420);
        if (!text) continue;

        blocks.push({
            id: buildBlockId(fileBase, heading || topTitle, ordinal),
            kind: WORKFLOW_PATTERNS.some((pattern) => pattern.test(text))
                ? "procedural"
                : "semantic",
            role: normalizeRole(undefined, text),
            confidence: 0.58,
            importance: 0.62,
            sourceRefs: [],
            aliases: [],
            text,
        });
    }

    return blocks;
}

function buildNode(
    block: MemoryNodeBlock,
    bundle: V8MemoryBundle,
    dayKey: string | null
): V8MemoryNode {
    const text = sanitizeText(block.text, 220);
    const bilingual = deriveBilingualNodeNames(
        text,
        [bundle.title, bundle.sourceRef, ...block.sourceRefs],
        {
            explicitZh: block.nameZh,
            explicitEn: block.nameEn,
            explicitAliases: block.aliases,
        }
    );
    return {
        id: `mn_${block.id}_${block.role}`,
        bundleId: bundle.bundleId,
        kind: bundle.kind,
        role: block.role,
        names: bilingual.names,
        aliases: bilingual.aliases,
        text,
        summary: takeLeadingClause(text, 96) || text,
        keywords: extractKeywords(text),
        language: detectLanguage(text),
        sourceRef: bundle.sourceRef,
        canonicalRef: bundle.canonicalRef,
        confidence: block.confidence,
        importance: block.importance,
        hitCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        harmCount: 0,
        lastUsedAt: null,
        lastVerifiedAt: null,
        cooldownUntil: null,
        dayKey,
        episodeKey: bundle.episodeKey,
    };
}

function buildEdge(
    bundleId: string,
    src: V8MemoryNode,
    dst: V8MemoryNode,
    type: V8EdgeType,
    confidence: number,
    importance: number
): V8MemoryEdge {
    return {
        id: `me_${bundleId}_${src.role}_${type}_${dst.role}`,
        type,
        src: src.id,
        dst: dst.id,
        assocStrength: clamp01(0.55 + importance * 0.25),
        utility: clamp01(0.55 + importance * 0.2),
        trust: clamp01(0.58 + confidence * 0.25),
        freshness: 0.88,
        contextFit: 0.8,
        evidenceCount: 1,
        activationCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        lastUpdatedAt: new Date().toISOString(),
        lastVerifiedAt: null,
    };
}

export function compileKnowledgeMdToBundles(
    input: CompileKnowledgeMdInput
): CompileKnowledgeMdOutput {
    const { filePath, workspace } = input;
    const content = readFileOr(filePath);
    if (!content.trim()) {
        return { bundles: [], nodes: [], edges: [] };
    }

    const relativePath = path
        .relative(workspace, filePath)
        .replace(/\\/g, "/");
    const fileBase = path.basename(filePath, ".md");
    const blocks =
        parseStructuredBlocks(content, fileBase).length > 0
            ? parseStructuredBlocks(content, fileBase)
            : parseFallbackSections(content, fileBase);

    const bundles: V8MemoryBundle[] = [];
    const nodes: V8MemoryNode[] = [];
    const edges: V8MemoryEdge[] = [];

    let ordinal = 0;
    for (const block of blocks) {
        ordinal += 1;
        const blockSlug = slugify(block.text) || `block-${ordinal}`;
        const canonicalRef = `${relativePath}#${blockSlug}`;
        const bundle: V8MemoryBundle = {
            bundleId: `mb_${block.id}`,
            sourceType: "knowledge_md",
            sourceRef: relativePath,
            kind: block.kind,
            title: takeLeadingClause(block.text, 96) || path.basename(filePath, ".md"),
            nodeIds: [],
            canonicalRef,
            summaryRef: relativePath,
            dayKey: null,
            episodeKey: block.sourceRefs[0] || null,
            encodingContext: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const primaryNode = buildNode(block, bundle, null);
        const bundleNodes: V8MemoryNode[] = [primaryNode];

        if (block.role !== "topic") {
            bundleNodes.unshift(
                buildNode(
                    { ...block, role: "topic", text: bundle.title },
                    bundle,
                    null
                )
            );
        }

        const topicNode = bundleNodes.find((node) => node.role === "topic");
        if (topicNode) {
            for (const node of bundleNodes) {
                if (node.id === topicNode.id) continue;
                edges.push(
                    buildEdge(
                        bundle.bundleId,
                        topicNode,
                        node,
                        "same_topic",
                        block.confidence,
                        block.importance
                    )
                );
            }
        }

        bundle.nodeIds = bundleNodes.map((node) => node.id);
        bundles.push(bundle);
        nodes.push(...bundleNodes);
    }

    return { bundles, nodes, edges };
}
