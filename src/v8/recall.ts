import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import { loadEdgeRuntimePolicy } from "./edge-runtime-policy.js";
import { loadHypothesisEdges } from "./hypothesis-store.js";
import { appendPackCacheRecord, isPackCacheExpired, loadPackCache } from "./pack-cache.js";
import { v8StorePaths } from "./paths_v8.js";
import type {
    AssembleRecallInput,
    AssembleRecallOutput,
    V8ActivatedBundle,
    V8EvidenceSpan,
    V8EdgeCatalogEntry,
    V8EdgeRuntimePolicyEntry,
    V8GraphEdge,
    V8GraphNode,
    V8HypothesisEdge,
    V8PackCacheRecord,
    V8RecallBundleProjection,
    V8RecallMode,
} from "./types_v8.js";

interface RecallAssemblyContext {
    nodesById: Map<string, V8GraphNode>;
    evidenceById: Map<string, V8EvidenceSpan>;
    edges: V8GraphEdge[];
    edgesByNode: Map<string, V8GraphEdge[]>;
    edgeKinds: Map<string, V8EdgeCatalogEntry["kind"]>;
    policyByKindMode: Map<string, V8EdgeRuntimePolicyEntry>;
    recallBundlesById: Map<string, V8RecallBundleProjection>;
    hypothesisByNode: Map<string, V8HypothesisEdge[]>;
    packCacheById: Map<string, V8PackCacheRecord>;
}

interface EdgeCatalogFile {
    edges?: Array<Partial<V8EdgeCatalogEntry> & { type?: string }>;
}

const recallContextCache = new Map<
    string,
    { mtime: number; context: RecallAssemblyContext }
>();

function edgeCatalogPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../schema/v8-edge-catalog.json");
}

function loadEdgeCatalog(): Map<string, V8EdgeCatalogEntry["kind"]> {
    const data = readJson<EdgeCatalogFile>(edgeCatalogPath(), { edges: [] });
    const entries = Array.isArray(data.edges) ? data.edges : [];
    const map = new Map<string, V8EdgeCatalogEntry["kind"]>();
    for (const entry of entries) {
        if (!entry?.type || !entry.kind) continue;
        map.set(entry.type, entry.kind as V8EdgeCatalogEntry["kind"]);
    }
    return map;
}

function policyKey(kind: string, mode: V8RecallMode): string {
    return `${kind}:${mode}`;
}

function buildPolicyMap(
    entries: V8EdgeRuntimePolicyEntry[]
): Map<string, V8EdgeRuntimePolicyEntry> {
    const map = new Map<string, V8EdgeRuntimePolicyEntry>();
    for (const entry of entries) {
        map.set(policyKey(entry.kind, entry.mode), entry);
    }
    return map;
}

function loadJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split(/\\r?\\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function readMtime(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function sanitizeText(text: string, maxChars = 520): string {
    return (text || "")
        .replace(/<!--[\\s\\S]*?-->/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

interface NarrativeCacheEntry {
    mtimeMs: number;
    text: string;
}

const narrativeCache = new Map<string, NarrativeCacheEntry>();

function readFileMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function readNarrativeSlice(span: V8EvidenceSpan): string {
    const ref = span.narrativeRef;
    if (!ref) return span.text;
    const currentMtime = readFileMtimeMs(ref);
    const cached = narrativeCache.get(ref);
    if (cached && cached.mtimeMs === currentMtime) {
        return cached.text.slice(span.charStart, span.charEnd) || span.text;
    }
    try {
        const raw = fs.readFileSync(ref, "utf-8");
        narrativeCache.set(ref, { text: raw, mtimeMs: currentMtime });
        return raw.slice(span.charStart, span.charEnd) || span.text;
    } catch {
        narrativeCache.set(ref, { text: "", mtimeMs: 0 });
        return span.text;
    }
}

function formatEvidence(span: V8EvidenceSpan): string {
    const speaker = span.speaker || "unknown";
    const ts = span.timestamp ? ` @ ${span.timestamp}` : "";
    const text = sanitizeText(readNarrativeSlice(span), 420);
    return `[${speaker}${ts}] ${text}`;
}

function resolveEvidenceSpanIds(
    bundle: V8ActivatedBundle,
    node: V8GraphNode,
    recallBundle?: V8RecallBundleProjection
): string[] {
    if (bundle.evidenceSpanIds && bundle.evidenceSpanIds.length > 0) {
        return bundle.evidenceSpanIds;
    }
    if (recallBundle?.bestEvidenceSpanIds && recallBundle.bestEvidenceSpanIds.length > 0) {
        return recallBundle.bestEvidenceSpanIds;
    }
    if (recallBundle?.evidenceSpanIds && recallBundle.evidenceSpanIds.length > 0) {
        return recallBundle.evidenceSpanIds;
    }
    if (node.bestEvidenceSpanIds && node.bestEvidenceSpanIds.length > 0) {
        return node.bestEvidenceSpanIds;
    }
    return node.evidenceSpanIds || [];
}

export function loadRecallAssemblyContext(workspace: string): RecallAssemblyContext {
    const store = v8StorePaths(workspace);
    const mtime = Math.max(
        readMtime(store.graphNodes),
        readMtime(store.graphEdges),
        readMtime(store.evidenceSpans),
        readMtime(store.recallBundles),
        readMtime(store.hypothesisEdges),
        readMtime(store.packCache)
    );
    const cacheKey = store.rootDir;
    const cached = recallContextCache.get(cacheKey);
    if (cached && cached.mtime === mtime) {
        return cached.context;
    }

    const nodes = loadJsonl<V8GraphNode>(store.graphNodes);
    const evidence = loadJsonl<V8EvidenceSpan>(store.evidenceSpans);
    const edges = loadJsonl<V8GraphEdge>(store.graphEdges);
    const recallBundles = loadJsonl<V8RecallBundleProjection>(store.recallBundles);
    const hypotheses = loadHypothesisEdges(workspace);
    const packCacheById = loadPackCache(workspace);

    const edgesByNode = new Map<string, V8GraphEdge[]>();
    for (const edge of edges) {
        if (!edgesByNode.has(edge.src)) edgesByNode.set(edge.src, []);
        if (!edgesByNode.has(edge.dst)) edgesByNode.set(edge.dst, []);
        edgesByNode.get(edge.src)!.push(edge);
        edgesByNode.get(edge.dst)!.push(edge);
    }

    const edgeKinds = loadEdgeCatalog();
    const policyByKindMode = buildPolicyMap(loadEdgeRuntimePolicy());
    const hypothesisByNode = new Map<string, V8HypothesisEdge[]>();
    for (const edge of hypotheses) {
        const srcList = hypothesisByNode.get(edge.src) || [];
        srcList.push(edge);
        hypothesisByNode.set(edge.src, srcList);
        const dstList = hypothesisByNode.get(edge.dst) || [];
        dstList.push(edge);
        hypothesisByNode.set(edge.dst, dstList);
    }

    const context: RecallAssemblyContext = {
        nodesById: new Map(nodes.map((node) => [node.id, node])),
        evidenceById: new Map(evidence.map((span) => [span.id, span])),
        edges,
        edgesByNode,
        edgeKinds,
        policyByKindMode,
        recallBundlesById: new Map(recallBundles.map((bundle) => [bundle.bundleId, bundle])),
        hypothesisByNode,
        packCacheById,
    };
    recallContextCache.set(cacheKey, { mtime, context });
    return context;
}

export function assembleRecallPrompts(
    input: AssembleRecallInput,
    context: RecallAssemblyContext
): AssembleRecallOutput[] {
    const outputs: AssembleRecallOutput[] = [];
    const mode: V8RecallMode = input.mode || "profile";
    const isStructuralMode = mode === "trajectory" || mode === "audit";
    const maxEvidence = mode === "audit" ? 8 : mode === "trajectory" ? 6 : 4;
    const packTtlDays = input.packCacheTtlDays ?? 7;

    for (const bundle of input.bundles) {
        const recallBundle = context.recallBundlesById.get(bundle.bundleId);
        const node = context.nodesById.get(recallBundle?.nodeIds?.[0] || bundle.bundleId);
        if (!node) continue;

        let evidenceSpanIds = resolveEvidenceSpanIds(bundle, node, recallBundle);
        if (isStructuralMode) {
            const structural = collectBacktraceEvidence(
                recallBundle?.nodeIds && recallBundle.nodeIds.length > 0
                    ? recallBundle.nodeIds
                    : bundle.nodeIds.length > 0
                      ? bundle.nodeIds
                      : [bundle.bundleId],
                mode,
                context
            );
            evidenceSpanIds = mergeUnique(evidenceSpanIds, structural);
        }
        const evidenceLines: string[] = [];
        const sourceRefs = new Set<string>(recallBundle?.sourceRefs || []);

        for (const spanId of evidenceSpanIds.slice(0, maxEvidence)) {
            const span = context.evidenceById.get(spanId);
            if (!span) continue;
            if (span.narrativeRef) {
                sourceRefs.add(span.narrativeRef);
            }
            evidenceLines.push(formatEvidence(span));
        }

        if (evidenceLines.length === 0) {
            continue;
        }

        const header = `<!-- Memory Recall (${bundle.tier}) -->`;
        const title = recallBundle?.title || node.canonicalLabel;
        const summaryText = recallBundle?.summaryText || "";
        const packType = recallBundle?.packType || null;
        const packText =
            packType && (packType === "summary" || packType === "state")
                ? resolvePackText(
                      {
                          workspace: input.workspace,
                          bundleId: bundle.bundleId,
                          packType,
                          title: title || node.canonicalLabel,
                          node,
                          evidenceSpanIds,
                          packTtlDays,
                      },
                      context
                  )
                : null;
        const packLines = packText
            ? packText
                  .split(/\\r?\\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
            : [];
        const body = [
            `Topic: ${sanitizeText(title || node.canonicalLabel, 120)}`,
            summaryText && summaryText !== title
                ? `Summary: ${sanitizeText(summaryText, 200)}`
                : null,
            packType ? `Pack: ${packType}` : null,
            ...packLines,
            `Evidence:`,
            ...evidenceLines.map((line) => `- ${line}`),
        ]
            .filter(Boolean)
            .join("\\n");

        const prompt = `${header}\\n${body}\\n<!-- End Memory Recall -->`;

        outputs.push({
            bundleId: bundle.bundleId,
            nodeIds:
                recallBundle?.nodeIds && recallBundle.nodeIds.length > 0
                    ? recallBundle.nodeIds
                    : bundle.nodeIds.length > 0
                      ? bundle.nodeIds
                      : [node.id],
            tier: bundle.tier,
            prompt,
            sourceRefs: [...sourceRefs],
        });
    }

    return outputs;
}

function collectBacktraceEvidence(
    seedNodeIds: string[],
    mode: V8RecallMode,
    context: RecallAssemblyContext
): string[] {
    if (seedNodeIds.length === 0) return [];
    const maxDepth = mode === "audit" ? 4 : 3;
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [];
    const evidence = new Set<string>();

    for (const seed of seedNodeIds) {
        queue.push({ id: seed, depth: 0 });
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);

        if (current.id.startsWith("es_")) {
            evidence.add(current.id);
            continue;
        }

        const node = context.nodesById.get(current.id);
        if (node) {
            for (const spanId of node.evidenceSpanIds || []) {
                evidence.add(spanId);
            }
        }

        const edges = context.edgesByNode.get(current.id) || [];
        for (const edge of edges) {
            for (const spanId of edge.evidenceSpanIds || []) {
                evidence.add(spanId);
            }

            const kind = context.edgeKinds.get(edge.type) || "semantic";
            const policy =
                context.policyByKindMode.get(policyKey(kind, mode));

            if (!policy || policy.role === "spread") {
                continue;
            }
            if (policy.role === "gate") {
                continue;
            }
            if (
                policy.role === "reweight" &&
                mode !== "trajectory" &&
                mode !== "audit"
            ) {
                continue;
            }

            const nextId = edge.src === current.id ? edge.dst : edge.src;
            if (nextId === current.id) continue;
            if (current.depth >= maxDepth) continue;
            queue.push({ id: nextId, depth: current.depth + 1 });
        }

        if (mode === "oblique" || mode === "trajectory") {
            const hypotheses = context.hypothesisByNode.get(current.id) || [];
            for (const hypothesis of hypotheses) {
                if (hypothesis.modeHint !== mode) continue;
                for (const spanId of hypothesis.supportEvidenceSpanIds || []) {
                    evidence.add(spanId);
                }
                const nextId = hypothesis.src === current.id ? hypothesis.dst : hypothesis.src;
                if (nextId === current.id) continue;
                if (current.depth >= maxDepth) continue;
                queue.push({ id: nextId, depth: current.depth + 1 });
            }
        }
    }

    return Array.from(evidence);
}

function mergeUnique(base: string[], extra: string[]): string[] {
    if (!extra.length) return base;
    const seen = new Set(base);
    for (const item of extra) {
        if (!seen.has(item)) {
            base.push(item);
            seen.add(item);
        }
    }
    return base;
}

function resolvePackText(
    options: {
        workspace: string;
        bundleId: string;
        packType: "summary" | "state";
        title: string;
        node: V8GraphNode;
        evidenceSpanIds: string[];
        packTtlDays: number;
    },
    context: RecallAssemblyContext
): string | null {
    const cached = context.packCacheById.get(options.bundleId);
    if (cached && !isPackCacheExpired(cached)) {
        return cached.text;
    }

    const packText = buildPackText(
        options.packType,
        options.title,
        options.evidenceSpanIds,
        context.evidenceById
    );
    if (!packText) return null;

    const now = new Date();
    const ttlMs =
        typeof options.packTtlDays === "number" && options.packTtlDays > 0
            ? options.packTtlDays * 24 * 60 * 60 * 1000
            : null;
    const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null;

    const record: V8PackCacheRecord = {
        id: options.bundleId,
        packType: options.packType,
        fingerprint: options.bundleId,
        text: packText,
        sourceItemIds:
            options.node.sourceItemIds && options.node.sourceItemIds.length > 0
                ? options.node.sourceItemIds
                : [options.bundleId],
        evidenceSpanIds: options.evidenceSpanIds.slice(0, 6),
        strengthScore: options.node.state?.confidence ?? 0.4,
        createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
        expiresAt,
        retentionPolicy: "default_7d",
    };

    appendPackCacheRecord(options.workspace, record);
    context.packCacheById.set(options.bundleId, record);
    return packText;
}

function buildPackText(
    packType: "summary" | "state",
    title: string,
    evidenceSpanIds: string[],
    evidenceById: Map<string, V8EvidenceSpan>
): string | null {
    const maxLines = packType === "state" ? 4 : 3;
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const spanId of evidenceSpanIds) {
        const span = evidenceById.get(spanId);
        if (!span) continue;
        const text = sanitizePackLine(span.text, 180);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        lines.push(text);
        if (lines.length >= maxLines) break;
    }

    const header = packType === "state" ? "State" : "Summary";
    const headLine = title ? `${header}: ${sanitizeText(title, 120)}` : `${header}:`;

    if (lines.length === 0) {
        return headLine.trim() ? headLine : null;
    }

    return [headLine, ...lines.map((line) => `- ${line}`)].join("\n");
}

function sanitizePackLine(text: string, maxChars = 160): string {
    return sanitizeText(text, maxChars);
}
