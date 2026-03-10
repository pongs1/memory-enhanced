import * as fs from "node:fs";
import * as path from "node:path";
import {
    ensureDir,
    readEvents,
    resolveWorkspace,
    type MemoryEvent,
} from "../utils.js";
import { compileEventToBundle } from "./compile-event.js";
import { compileKnowledgeMdToBundles } from "./compile-knowledge-md.js";
import { buildDayIndex, buildHardCoreIndex, buildSourceIndex, buildTriggerLexicon } from "./indexes.js";
import { ensureGraphManifest, writeGraphManifest } from "./manifest.js";
import { ensureGraphDirs, graphPaths } from "./paths.js";
import type {
    BuildGraphInput,
    BuildGraphOutput,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
} from "./types.js";

function collectJsonlFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs
        .readdirSync(dirPath)
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .map((file) => path.join(dirPath, file));
}

function collectMarkdownFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs
        .readdirSync(dirPath)
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => path.join(dirPath, file));
}

function appendJsonl<T>(filePath: string, items: T[]): void {
    if (items.length === 0) {
        fs.writeFileSync(filePath, "", "utf-8");
        return;
    }
    const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf-8");
}

function dedupeBundles(bundles: V8MemoryBundle[]): V8MemoryBundle[] {
    const seen = new Map<string, V8MemoryBundle>();
    for (const bundle of bundles) {
        seen.set(bundle.bundleId, bundle);
    }
    return [...seen.values()];
}

function dedupeNodes(nodes: V8MemoryNode[]): V8MemoryNode[] {
    const seen = new Map<string, V8MemoryNode>();
    for (const node of nodes) {
        seen.set(node.id, node);
    }
    return [...seen.values()];
}

function dedupeEdges(edges: V8MemoryEdge[]): V8MemoryEdge[] {
    const seen = new Map<string, V8MemoryEdge>();
    for (const edge of edges) {
        seen.set(edge.id, edge);
    }
    return [...seen.values()];
}

function persistGraph(output: BuildGraphOutput, workspace: string) {
    const gp = ensureGraphDirs(workspace);
    const episodicNodes = output.nodes.filter((node) => node.kind === "episodic");
    const semanticNodes = output.nodes.filter((node) => node.kind === "semantic");
    const proceduralNodes = output.nodes.filter((node) => node.kind === "procedural");
    const associativeEdges = output.edges.filter((edge) => edge.type === "associative");
    const supersessionEdges = output.edges.filter((edge) => edge.type === "supersedes");
    const structuralEdges = output.edges.filter((edge) => edge.type !== "associative" && edge.type !== "supersedes");

    appendJsonl(gp.bundles, output.bundles);
    appendJsonl(gp.nodesEpisodic, episodicNodes);
    appendJsonl(gp.nodesSemantic, semanticNodes);
    appendJsonl(gp.nodesProcedural, proceduralNodes);
    appendJsonl(gp.edgesAssociative, associativeEdges);
    appendJsonl(gp.edgesStructural, structuralEdges);
    appendJsonl(gp.edgesSupersession, supersessionEdges);
    fs.writeFileSync(gp.updateQueue, "", "utf-8");
    fs.writeFileSync(gp.triggerLexicon, JSON.stringify(output.triggerLexicon, null, 2), "utf-8");
    fs.writeFileSync(gp.dayIndex, JSON.stringify(output.dayIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.sourceIndex, JSON.stringify(output.sourceIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.hardCoreIndex, JSON.stringify(output.hardCoreIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.embeddingIds, JSON.stringify([], null, 2), "utf-8");
    fs.writeFileSync(gp.embeddingMetadata, JSON.stringify({ items: 0 }, null, 2), "utf-8");
    if (!fs.existsSync(gp.embeddingVectors)) {
        fs.writeFileSync(gp.embeddingVectors, "", "utf-8");
    }

    return writeGraphManifest(workspace, {
        updatedAt: new Date().toISOString(),
        lastFullRebuildAt: new Date().toISOString(),
    });
}

export async function buildV8Graph(
    input: BuildGraphInput
): Promise<BuildGraphOutput> {
    const workspace = resolveWorkspace(input.workspace);
    const includeEvents = input.includeEvents ?? true;
    const includeKnowledgeMd = input.includeKnowledgeMd ?? true;
    const includeSkillMd = input.includeSkillMd ?? false;
    const writeToDisk = input.writeToDisk ?? false;

    const basePaths = graphPaths(workspace);
    ensureDir(basePaths.graphDir);
    ensureDir(basePaths.embeddingIndexDir);

    const bundles: V8MemoryBundle[] = [];
    const nodes: V8MemoryNode[] = [];
    const edges: V8MemoryEdge[] = [];

    if (includeEvents) {
        const eventFiles = collectJsonlFiles(path.join(workspace, ".memory", "events"));
        for (const eventFile of eventFiles) {
            const eventList = readEvents(eventFile);
            for (const event of eventList) {
                const compiled = compileEventToBundle({ workspace, event: event as MemoryEvent });
                bundles.push(compiled.bundle);
                nodes.push(...compiled.nodes);
                edges.push(...compiled.edges);
            }
        }
    }

    if (includeKnowledgeMd) {
        const knowledgeFiles = collectMarkdownFiles(path.join(workspace, "memory", "knowledge"));
        for (const filePath of knowledgeFiles) {
            const compiled = compileKnowledgeMdToBundles({ workspace, filePath });
            bundles.push(...compiled.bundles);
            nodes.push(...compiled.nodes);
            edges.push(...compiled.edges);
        }
    }

    if (includeSkillMd) {
        const skillsDir = path.join(workspace, "memory", "skills");
        const verifiedDir = path.join(skillsDir, "verified");
        const draftDir = path.join(skillsDir, "drafts");
        for (const root of [verifiedDir, draftDir]) {
            const files = collectMarkdownFiles(root);
            for (const filePath of files) {
                const compiled = compileKnowledgeMdToBundles({ workspace, filePath });
                bundles.push(
                    ...compiled.bundles.map((bundle) => ({
                        ...bundle,
                        sourceType: "skill_md" as const,
                        kind: bundle.kind === "episodic" ? "procedural" : bundle.kind,
                    }))
                );
                nodes.push(
                    ...compiled.nodes.map((node) => ({
                        ...node,
                        kind: node.kind === "episodic" ? "procedural" : node.kind,
                    }))
                );
                edges.push(...compiled.edges);
            }
        }
    }

    const finalBundles = dedupeBundles(bundles);
    const finalNodes = dedupeNodes(nodes);
    const finalEdges = dedupeEdges(edges);
    const triggerLexicon = buildTriggerLexicon(finalNodes);
    const dayIndex = buildDayIndex(finalNodes);
    const sourceIndex = buildSourceIndex(finalBundles);
    const hardCoreIndex = buildHardCoreIndex(finalNodes);
    let manifest = ensureGraphManifest(workspace);

    const output: BuildGraphOutput = {
        manifest,
        bundles: finalBundles,
        nodes: finalNodes,
        edges: finalEdges,
        triggerLexicon,
        dayIndex,
        sourceIndex,
        hardCoreIndex,
    };

    if (writeToDisk) {
        manifest = persistGraph(output, workspace);
        output.manifest = manifest;
    }

    return output;
}
