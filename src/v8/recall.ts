import * as fs from "node:fs";
import * as path from "node:path";
import { readEvents } from "../utils.js";
import { graphPaths } from "./paths.js";
import type {
    AssembleRecallInput,
    AssembleRecallOutput,
    V8ActivatedBundle,
    V8DeliveryTier,
    V8HardCoreIndex,
    V8MemoryBundle,
    V8MemoryNode,
    V8SourceIndex,
} from "./types.js";

interface RecallAssemblyContext {
    bundlesById: Map<string, V8MemoryBundle>;
    nodesByBundleId: Map<string, V8MemoryNode[]>;
    sourceIndex: V8SourceIndex;
    hardCoreIndex: V8HardCoreIndex;
}

function loadJson<T>(filePath: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return fallback;
    }
}

function loadJsonl<T>(filePath: string): T[] {
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

function sanitizeText(text: string, maxChars = 520): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function takeLeadingClause(text: string, maxChars = 160): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return matched.slice(0, maxChars).trim();
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

function eventIdToJsonlPath(workspace: string, eventId: string): string | null {
    const match = eventId.match(/^evt_(\d{4})(\d{2})(\d{2})_/);
    if (!match) return null;
    return path.join(
        workspace,
        ".memory",
        "events",
        `${match[1]}-${match[2]}-${match[3]}.jsonl`
    );
}

function readEventSnippet(workspace: string, eventId: string): string {
    const jsonlPath = eventIdToJsonlPath(workspace, eventId);
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
        return "";
    }
    const event = readEvents(jsonlPath).find((item) => item.id === eventId);
    if (!event) {
        return "";
    }
    return sanitizeText(event.content, 420);
}

function extractMemoryNodeBlock(content: string, anchor: string): string {
    const regex =
        /<!--\s*memory-node[\s\S]*?-->\s*([\s\S]*?)<!--\s*\/memory-node\s*-->/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        const text = sanitizeText(match[1] || "", 600);
        if (!text) continue;
        if (slugify(text) === anchor || slugify(takeLeadingClause(text, 120)) === anchor) {
            return text;
        }
    }
    return "";
}

function readKnowledgeSnippet(
    workspace: string,
    relativePath: string,
    canonicalRef: string
): string {
    const fullPath = path.join(workspace, relativePath);
    if (!fs.existsSync(fullPath)) {
        return "";
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const anchor = canonicalRef.split("#")[1] || "";
    const block = anchor ? extractMemoryNodeBlock(content, anchor) : "";
    if (block) {
        return block;
    }

    const clean = content
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith("<!--"))
        .slice(0, 8)
        .join(" ");
    return sanitizeText(clean, 420);
}

function classifyTier(
    bundle: V8MemoryBundle,
    nodes: V8MemoryNode[],
    hardCoreIndex: V8HardCoreIndex
): V8DeliveryTier {
    const hardCoreIds = new Set([
        ...(hardCoreIndex.agent_identity_core || []),
        ...(hardCoreIndex.inter_agent_protocol_core || []),
    ]);
    if (nodes.some((node) => hardCoreIds.has(node.id))) {
        return "critical";
    }

    const roles = new Set(nodes.map((node) => node.role));
    if (
        roles.has("checkpoint") ||
        roles.has("constraint") ||
        (roles.has("workflow") && roles.has("constraint"))
    ) {
        return "critical";
    }

    if (
        bundle.kind === "procedural" ||
        roles.has("workflow") ||
        roles.has("condition")
    ) {
        return "decision";
    }

    return "background";
}

function buildPrompt(
    tier: V8DeliveryTier,
    bundle: V8MemoryBundle,
    nodes: V8MemoryNode[],
    snippet: string,
    input: AssembleRecallInput
): AssembleRecallOutput {
    const bulletNodes = Array.from(
        new Set(
            nodes
                .slice(0, 6)
                .map((node) => takeLeadingClause(node.text, 120))
                .filter(Boolean)
        )
    )
        .slice(0, 4)
        .map((line) => `- ${line}`)
        .join("\n");
    const sourceRefs = Array.from(
        new Set([bundle.sourceRef, ...nodes.map((node) => node.sourceRef)])
    );

    if (tier === "critical") {
        return {
            bundleId: bundle.bundleId,
            nodeIds: nodes.map((node) => node.id),
            tier,
            sourceRefs,
            prompt: [
                "",
                "[CRITICAL MEMORY RECALL]",
                "A high-value memory bundle matches the current branch.",
                "Treat it as a validated workflow, hard constraint, known fix, or restart checkpoint.",
                "Current goal remains primary unless this memory shows the branch is wrong.",
                "",
                "Current anchors:",
                `- Goal: ${input.goal || "(none)"}`,
                `- Active task: ${input.activeTask || "(none)"}`,
                `- Latest user request: ${input.latestUserRequest || "(missing)"}`,
                "",
                `Memory bundle: ${bundle.title}`,
                bulletNodes,
                snippet ? `Source note: ${snippet}` : "Source note: (not available)",
                "",
                "Mandatory actions:",
                "1. Reconcile the current branch against this memory now.",
                "2. If it exposes a better verified path, switch immediately.",
                "3. Keep the latest user request authoritative.",
                "",
            ].join("\n"),
        };
    }

    if (tier === "decision") {
        return {
            bundleId: bundle.bundleId,
            nodeIds: nodes.map((node) => node.id),
            tier,
            sourceRefs,
            prompt: [
                "",
                "[MEMORY RECALL CANDIDATE]",
                "This looks like a prior decision, workflow, or durable condition.",
                "Use it if it directly helps the active task or latest user request.",
                "",
                `Memory bundle: ${bundle.title}`,
                bulletNodes,
                snippet ? `Source note: ${snippet}` : "Source note: (not available)",
                "",
                "Current goal remains unchanged unless this memory clearly improves execution.",
                "",
            ].join("\n"),
        };
    }

    return {
        bundleId: bundle.bundleId,
        nodeIds: nodes.map((node) => node.id),
        tier,
        sourceRefs,
        prompt: [
            "",
            "[MEMORY RECALL CANDIDATE]",
            "Optional background context only.",
            `Memory bundle: ${bundle.title}`,
            bulletNodes,
            snippet ? `Source note: ${snippet}` : "Source note: (not available)",
            "",
            "Ignore if weakly related or distracting.",
            "",
        ].join("\n"),
    };
}

function readBundleSnippet(
    workspace: string,
    bundle: V8MemoryBundle
): string {
    if (bundle.sourceRef.startsWith("evt_")) {
        return readEventSnippet(workspace, bundle.sourceRef);
    }
    return readKnowledgeSnippet(workspace, bundle.sourceRef, bundle.canonicalRef);
}

export function loadRecallAssemblyContext(
    workspace: string
): RecallAssemblyContext {
    const gp = graphPaths(workspace);
    const bundles = loadJsonl<V8MemoryBundle>(gp.bundles);
    const nodes = [
        ...loadJsonl<V8MemoryNode>(gp.nodesEpisodic),
        ...loadJsonl<V8MemoryNode>(gp.nodesSemantic),
        ...loadJsonl<V8MemoryNode>(gp.nodesProcedural),
    ];
    const nodesByBundleId = new Map<string, V8MemoryNode[]>();

    for (const node of nodes) {
        if (!nodesByBundleId.has(node.bundleId)) {
            nodesByBundleId.set(node.bundleId, []);
        }
        nodesByBundleId.get(node.bundleId)!.push(node);
    }

    return {
        bundlesById: new Map(bundles.map((bundle) => [bundle.bundleId, bundle])),
        nodesByBundleId,
        sourceIndex: loadJson<V8SourceIndex>(gp.sourceIndex, {}),
        hardCoreIndex: loadJson<V8HardCoreIndex>(gp.hardCoreIndex, {
            agent_identity_core: [],
            inter_agent_protocol_core: [],
        }),
    };
}

export function assembleRecallPrompts(
    input: AssembleRecallInput,
    context: RecallAssemblyContext
): AssembleRecallOutput[] {
    const outputs: AssembleRecallOutput[] = [];

    for (const activated of input.bundles) {
        const bundle = context.bundlesById.get(activated.bundleId);
        if (!bundle) continue;
        const nodes = context.nodesByBundleId.get(bundle.bundleId) || [];
        const tier = classifyTier(bundle, nodes, context.hardCoreIndex);
        const snippet = readBundleSnippet(input.workspace, bundle);

        outputs.push(buildPrompt(tier, bundle, nodes, snippet, input));
    }

    return outputs;
}
