import * as fs from "node:fs";
import * as path from "node:path";
import { nowISO, readEvents, readFileOr, resolveWorkspace } from "../utils.js";
import { postJson } from "../http-client.js";
import { graphPaths } from "./paths.js";
import {
    buildClusterRebuildPrompt,
    buildClusterRebuildSecondCheckPrompt,
    buildClusterScenePrompt,
} from "./rebuild-prompt.js";
import { buildClusterRebuildDraftFromMarkdown } from "./rebuild-stage-parser.js";
import type {
    V8ClusterDiagnosis,
    V8ClusterRelatedMemorySnippet,
    V8ClusterRebuildRecord,
    V8ClusterRebuildRunInput,
    V8ClusterRebuildRunOutput,
    V8ClusterRebuildDraft,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8SourceIndex,
} from "./types.js";

interface ClusterRebuildApiConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
}

function sanitizeText(text: string, maxChars = 16000): string {
    return (text || "").replace(/\r/g, "").trim().slice(0, maxChars);
}

function readJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function writeJsonl<T>(filePath: string, records: T[]): void {
    const content = records.length > 0
        ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
        : "";
    fs.writeFileSync(filePath, content, "utf-8");
}

function resolveClusterRebuildApiConfig(): ClusterRebuildApiConfig | null {
    const apiKey = process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || "";
    if (!apiKey) return null;
    return {
        apiKey,
        baseUrl: (process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, ""),
        model:
            process.env.MEMORY_CLUSTER_REBUILD_MODEL ||
            process.env.MEMORY_ANNOTATION_MODEL ||
            process.env.OPENAI_MODEL ||
            "Pro/MiniMaxAI/MiniMax-M2.5",
    };
}

function extractMessageText(payload: any): string {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .join("\n")
            .trim();
    }
    return "";
}

async function callChat(
    config: ClusterRebuildApiConfig,
    messages: Array<{ role: "system" | "user"; content: string }>
): Promise<string> {
    const payload = await postJson({
        url: `${config.baseUrl}/chat/completions`,
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: {
            model: config.model,
            messages,
            temperature: 0.25,
        },
    });
    return extractMessageText(payload);
}

function eventIdToJsonlPath(workspace: string, eventId: string): string | null {
    const match = eventId.match(/^evt_(\d{4})(\d{2})(\d{2})_/);
    if (!match) return null;
    return path.join(workspace, ".memory", "events", `${match[1]}-${match[2]}-${match[3]}.jsonl`);
}

function loadEventSourceText(workspace: string, eventId: string): string {
    const jsonlPath = eventIdToJsonlPath(workspace, eventId);
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return "";
    const event = readEvents(jsonlPath).find((item) => item.id === eventId);
    if (!event) return "";
    const lines = [
        `Event ID: ${event.id}`,
        `Type: ${event.type}`,
        `Timestamp: ${event.timestamp}`,
        `Importance: ${event.importance}`,
        "",
        event.content,
    ];
    return lines.join("\n");
}

function loadSourceSnippet(workspace: string, sourceRef: string): string {
    if (sourceRef.startsWith("evt_")) {
        return loadEventSourceText(workspace, sourceRef);
    }
    return readFileOr(path.join(workspace, sourceRef));
}

function loadGraph(workspace: string): {
    bundlesById: Map<string, V8MemoryBundle>;
    nodesById: Map<string, V8MemoryNode>;
    edges: V8MemoryEdge[];
    sourceIndex: V8SourceIndex;
} {
    const gp = graphPaths(workspace);
    const bundles = readJsonl<V8MemoryBundle>(gp.bundles);
    const nodes = [
        ...readJsonl<V8MemoryNode>(gp.nodesEpisodic),
        ...readJsonl<V8MemoryNode>(gp.nodesSemantic),
        ...readJsonl<V8MemoryNode>(gp.nodesProcedural),
    ];
    const edges = [
        ...readJsonl<V8MemoryEdge>(gp.edgesAssociative),
        ...readJsonl<V8MemoryEdge>(gp.edgesStructural),
        ...readJsonl<V8MemoryEdge>(gp.edgesSupersession),
    ];
    let sourceIndex: V8SourceIndex = {};
    try {
        sourceIndex = JSON.parse(fs.readFileSync(gp.sourceIndex, "utf-8")) as V8SourceIndex;
    } catch {
        sourceIndex = {};
    }
    return {
        bundlesById: new Map(bundles.map((bundle) => [bundle.bundleId, bundle])),
        nodesById: new Map(nodes.map((node) => [node.id, node])),
        edges,
        sourceIndex,
    };
}

function rankDiagnoses(diagnoses: V8ClusterDiagnosis[], maxClusters: number): V8ClusterDiagnosis[] {
    return [...diagnoses]
        .sort((a, b) => {
            const aScore = a.avgHitCount * 0.35 + a.avgHarmRate * 4 + a.internalAssociativeDensity * 2;
            const bScore = b.avgHitCount * 0.35 + b.avgHarmRate * 4 + b.internalAssociativeDensity * 2;
            return bScore - aScore;
        })
        .slice(0, maxClusters);
}

function buildRelatedMemorySnippets(input: {
    workspace: string;
    diagnosis: V8ClusterDiagnosis;
    graph: {
        nodesById: Map<string, V8MemoryNode>;
        edges: V8MemoryEdge[];
        sourceIndex: V8SourceIndex;
    };
    maxSnippets: number;
}): V8ClusterRelatedMemorySnippet[] {
    const clusterNodeIds = new Set(input.diagnosis.nodeIds);
    const sourceCache = new Map<string, string>();

    const getSourceText = (sourceRef: string): string => {
        const normalized = sourceRef || "";
        if (!normalized) return "";
        if (sourceCache.has(normalized)) {
            return sourceCache.get(normalized)!;
        }
        const text = sanitizeText(loadSourceSnippet(input.workspace, normalized), 360);
        sourceCache.set(normalized, text);
        return text;
    };

    const scoredEdges = input.graph.edges
        .filter((edge) => clusterNodeIds.has(edge.src) || clusterNodeIds.has(edge.dst))
        .map((edge) => {
            const src = input.graph.nodesById.get(edge.src);
            const dst = input.graph.nodesById.get(edge.dst);
            if (!src || !dst) return null;
            const internal = clusterNodeIds.has(edge.src) && clusterNodeIds.has(edge.dst);
            const score =
                (internal ? 1.0 : 0.72) +
                edge.assocStrength * 0.6 +
                edge.utility * 0.35 +
                edge.trust * 0.25;
            return { edge, src, dst, internal, score };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => b.score - a.score);

    const output: V8ClusterRelatedMemorySnippet[] = [];
    const seen = new Set<string>();

    for (const item of scoredEdges) {
        if (output.length >= input.maxSnippets) break;
        const key = `${item.edge.id}:${item.src.id}:${item.dst.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const srcEntry = input.graph.sourceIndex[item.src.sourceRef];
        const dstEntry = input.graph.sourceIndex[item.dst.sourceRef];
        const srcSourceRef = srcEntry?.sourceRef || item.src.sourceRef;
        const dstSourceRef = dstEntry?.sourceRef || item.dst.sourceRef;

        const srcNodeText = sanitizeText(item.src.summary || item.src.text, 180);
        const dstNodeText = sanitizeText(item.dst.summary || item.dst.text, 180);
        const srcMemory = getSourceText(srcSourceRef);
        const dstMemory = getSourceText(dstSourceRef);

        output.push({
            edgeId: item.edge.id,
            edgeType: item.edge.type,
            srcNodeId: item.src.id,
            srcRole: item.src.role,
            srcName: item.src.names.zh || item.src.names.en || item.src.id,
            srcText: srcMemory ? `${srcNodeText}\n[Source]\n${srcMemory}` : srcNodeText,
            srcSourceRef,
            dstNodeId: item.dst.id,
            dstRole: item.dst.role,
            dstName: item.dst.names.zh || item.dst.names.en || item.dst.id,
            dstText: dstMemory ? `${dstNodeText}\n[Source]\n${dstMemory}` : dstNodeText,
            dstSourceRef,
            note: item.internal
                ? "internal established edge"
                : "adjacent memory connected by established edge",
        });
    }

    return output;
}

function shouldRunSecondCheck(
    rebuiltDraft: V8ClusterRebuildDraft,
    clusterNodeCount: number,
    relatedMemoryCount: number
): boolean {
    if (relatedMemoryCount <= 0) return false;
    const preserved = rebuiltDraft.preservedNodeIds.filter(Boolean);
    const dropped = rebuiltDraft.droppedNodeIds.filter(Boolean);
    const noRebuildOutput = rebuiltDraft.rebuiltNodes.length === 0 && rebuiltDraft.rebuiltEdges.length === 0;
    const droppedMost = clusterNodeCount > 0 && dropped.length >= Math.max(1, Math.ceil(clusterNodeCount * 0.75));
    return noRebuildOutput && (preserved.length === 0 || droppedMost);
}

export async function runClusterRebuild(
    input: V8ClusterRebuildRunInput
): Promise<V8ClusterRebuildRunOutput> {
    const workspace = resolveWorkspace(input.workspace);
    const config = resolveClusterRebuildApiConfig();
    if (!config) {
        return { records: [], skipped: input.diagnoses.length, model: null };
    }

    const gp = graphPaths(workspace);
    const previous = readJsonl<V8ClusterRebuildRecord>(gp.clusterRebuildDrafts);
    const previousByCluster = new Map(previous.map((record) => [record.clusterId, record]));
    const force =
        input.force === true ||
        /^(1|true|yes)$/i.test(process.env.MEMORY_CLUSTER_REBUILD_FORCE || "");
    const clusterIdFilter = new Set(
        (input.clusterIds && input.clusterIds.length > 0
            ? input.clusterIds
            : (process.env.MEMORY_CLUSTER_REBUILD_CLUSTER_IDS || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean))
    );
    const selectedBase = clusterIdFilter.size > 0
        ? input.diagnoses.filter((diagnosis) => clusterIdFilter.has(diagnosis.clusterId))
        : input.diagnoses;
    const maxClusters = Math.max(
        0,
        Number(process.env.MEMORY_CLUSTER_REBUILD_MAX_CLUSTERS || input.maxClusters || 0)
    );
    if (maxClusters <= 0) {
        return { records: [], skipped: selectedBase.length, model: config.model };
    }

    const selected = rankDiagnoses(selectedBase, maxClusters);
    const graph = loadGraph(workspace);
    const nextRecords = [...previous];
    const newRecords: V8ClusterRebuildRecord[] = [];
    let skipped = Math.max(0, selectedBase.length - selected.length);

    for (const diagnosis of selected) {
        if (!force && previousByCluster.has(diagnosis.clusterId)) {
            skipped += 1;
            continue;
        }

        const nodes = diagnosis.nodeIds
            .map((nodeId) => graph.nodesById.get(nodeId))
            .filter((node): node is V8MemoryNode => Boolean(node));
        const nodeIdSet = new Set(nodes.map((node) => node.id));
        const bundles = diagnosis.bundleIds
            .map((bundleId) => graph.bundlesById.get(bundleId))
            .filter((bundle): bundle is V8MemoryBundle => Boolean(bundle));
        const edges = graph.edges.filter(
            (edge) => nodeIdSet.has(edge.src) && nodeIdSet.has(edge.dst)
        );
        const sourceRefs = [...new Set(bundles.map((bundle) => bundle.sourceRef))];
        const sourceSnippets = sourceRefs.map((sourceRef) => ({
            sourceRef,
            text: sanitizeText(loadSourceSnippet(workspace, sourceRef), 2400),
        })).filter((item) => item.text);
        const relatedMemorySnippets = buildRelatedMemorySnippets({
            workspace,
            diagnosis,
            graph,
            maxSnippets: Math.max(
                2,
                Number(process.env.MEMORY_CLUSTER_REBUILD_RELATED_MAX || 10)
            ),
        });

        const scenePrompt = buildClusterScenePrompt({
            diagnosis,
            bundles,
            nodes,
            edges,
            sourceSnippets,
            relatedMemorySnippets,
        });
        const stage1SceneDraft = await callChat(config, [
            { role: "system", content: scenePrompt.system },
            { role: "user", content: scenePrompt.user },
        ]);
        if (!stage1SceneDraft) continue;

        const rebuildPrompt = buildClusterRebuildPrompt({
            diagnosis,
            bundles,
            nodes,
            edges,
            sourceSnippets,
            relatedMemorySnippets,
        }, stage1SceneDraft);
        let stage2RebuildDraft = await callChat(config, [
            { role: "system", content: rebuildPrompt.system },
            { role: "user", content: rebuildPrompt.user },
        ]);
        if (!stage2RebuildDraft) continue;

        let rebuiltDraft = buildClusterRebuildDraftFromMarkdown({
            diagnosis,
            sceneDraft: stage1SceneDraft,
            rebuildDraft: stage2RebuildDraft,
        });
        let secondCheckUsed = false;

        if (shouldRunSecondCheck(rebuiltDraft, nodes.length, relatedMemorySnippets.length)) {
            const secondCheckPrompt = buildClusterRebuildSecondCheckPrompt(
                {
                    diagnosis,
                    bundles,
                    nodes,
                    edges,
                    sourceSnippets,
                    relatedMemorySnippets,
                },
                stage1SceneDraft,
                stage2RebuildDraft
            );
            const secondDraft = await callChat(config, [
                { role: "system", content: secondCheckPrompt.system },
                { role: "user", content: secondCheckPrompt.user },
            ]);
            if (secondDraft) {
                stage2RebuildDraft = secondDraft;
                rebuiltDraft = buildClusterRebuildDraftFromMarkdown({
                    diagnosis,
                    sceneDraft: stage1SceneDraft,
                    rebuildDraft: stage2RebuildDraft,
                });
                secondCheckUsed = true;
            }
        }

        const relatedMemoryRefs = [
            ...new Set(
                relatedMemorySnippets.flatMap((item) => [item.srcSourceRef, item.dstSourceRef]).filter(Boolean)
            ),
        ];

        const record: V8ClusterRebuildRecord = {
            clusterId: diagnosis.clusterId,
            diagnosis,
            sourceRefs,
            relatedMemoryRefs,
            stage1SceneDraft,
            stage2RebuildDraft,
            rebuiltDraft,
            secondCheckUsed,
            model: config.model,
            createdAt: nowISO(),
        };

        const existingIndex = nextRecords.findIndex((item) => item.clusterId === diagnosis.clusterId);
        if (existingIndex >= 0) {
            nextRecords.splice(existingIndex, 1, record);
        } else {
            nextRecords.push(record);
        }
        newRecords.push(record);
    }

    writeJsonl(gp.clusterRebuildDrafts, nextRecords);
    return {
        records: newRecords,
        skipped,
        model: config.model,
    };
}
