import * as path from "node:path";
import { ensureDir, paths } from "../utils.js";
import type { V8NodeKind } from "./types.js";

export interface V8GraphPaths {
    graphDir: string;
    manifest: string;
    nodesEpisodic: string;
    nodesSemantic: string;
    nodesProcedural: string;
    edgesAssociative: string;
    edgesStructural: string;
    edgesSupersession: string;
    bundles: string;
    updateQueue: string;
    triggerLexicon: string;
    dayIndex: string;
    sourceIndex: string;
    hardCoreIndex: string;
    embeddingIndexDir: string;
    embeddingVectors: string;
    embeddingIds: string;
    embeddingMetadata: string;
}

export function graphPaths(workspace: string): V8GraphPaths {
    const base = paths(workspace);
    const graphDir = path.join(base.dotMemory, "graph");
    const embeddingIndexDir = path.join(graphDir, "embedding_index");

    return {
        graphDir,
        manifest: path.join(graphDir, "manifest.json"),
        nodesEpisodic: path.join(graphDir, "nodes_episodic.jsonl"),
        nodesSemantic: path.join(graphDir, "nodes_semantic.jsonl"),
        nodesProcedural: path.join(graphDir, "nodes_procedural.jsonl"),
        edgesAssociative: path.join(graphDir, "edges_associative.jsonl"),
        edgesStructural: path.join(graphDir, "edges_structural.jsonl"),
        edgesSupersession: path.join(graphDir, "edges_supersession.jsonl"),
        bundles: path.join(graphDir, "bundles.jsonl"),
        updateQueue: path.join(graphDir, "update_queue.jsonl"),
        triggerLexicon: path.join(graphDir, "trigger_lexicon.json"),
        dayIndex: path.join(graphDir, "day_index.json"),
        sourceIndex: path.join(graphDir, "source_index.json"),
        hardCoreIndex: path.join(graphDir, "hard_core_index.json"),
        embeddingIndexDir,
        embeddingVectors: path.join(embeddingIndexDir, "nodes.f32"),
        embeddingIds: path.join(embeddingIndexDir, "ids.json"),
        embeddingMetadata: path.join(embeddingIndexDir, "metadata.json"),
    };
}

export function ensureGraphDirs(workspace: string): V8GraphPaths {
    const gp = graphPaths(workspace);
    ensureDir(gp.graphDir);
    ensureDir(gp.embeddingIndexDir);
    return gp;
}

export function getNodeStorePath(
    graphPathSet: V8GraphPaths,
    kind: V8NodeKind
): string {
    switch (kind) {
        case "episodic":
            return graphPathSet.nodesEpisodic;
        case "semantic":
            return graphPathSet.nodesSemantic;
        case "procedural":
            return graphPathSet.nodesProcedural;
    }
}
