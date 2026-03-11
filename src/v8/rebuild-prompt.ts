import type {
    V8ClusterDiagnosis,
    V8ClusterRelatedMemorySnippet,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
} from "./types.js";

function sanitizeText(text: string, maxChars = 12000): string {
    return (text || "").replace(/\r/g, "").trim().slice(0, maxChars);
}

export interface V8ClusterRebuildPromptInput {
    diagnosis: V8ClusterDiagnosis;
    bundles: V8MemoryBundle[];
    nodes: V8MemoryNode[];
    edges: V8MemoryEdge[];
    sourceSnippets: Array<{ sourceRef: string; text: string }>;
    relatedMemorySnippets: V8ClusterRelatedMemorySnippet[];
}

export interface V8ClusterRebuildPromptMessages {
    system: string;
    user: string;
}

function renderNodeTable(nodes: V8MemoryNode[], diagnosis: V8ClusterDiagnosis): string {
    const hitchhikers = new Set(diagnosis.hitchhikerNodeIds);
    const lines = [
        "| node id | role | zh name | en name | summary | hits | adopts | harms | hint |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const node of nodes) {
        lines.push(
            `| ${node.id} | ${node.role} | ${node.names.zh} | ${node.names.en} | ${sanitizeText(node.summary || node.text, 96)} | ${node.hitCount} | ${node.adoptCount} | ${node.harmCount} | ${hitchhikers.has(node.id) ? "possible hitchhiker" : ""} |`
        );
    }
    return lines.join("\n");
}

function renderEdgeTable(edges: V8MemoryEdge[]): string {
    const lines = [
        "| edge id | type | src | dst | assoc | utility | trust | freshness | context fit |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const edge of edges) {
        lines.push(
            `| ${edge.id} | ${edge.type} | ${edge.src} | ${edge.dst} | ${edge.assocStrength.toFixed(2)} | ${edge.utility.toFixed(2)} | ${edge.trust.toFixed(2)} | ${edge.freshness.toFixed(2)} | ${edge.contextFit.toFixed(2)} |`
        );
    }
    return lines.join("\n");
}

function renderSources(sourceSnippets: Array<{ sourceRef: string; text: string }>): string {
    if (sourceSnippets.length === 0) {
        return "(none)";
    }
    return sourceSnippets
        .map((item) => `## ${item.sourceRef}\n${sanitizeText(item.text, 2400)}`)
        .join("\n\n");
}

function renderRelatedMemorySnippets(
    relatedMemorySnippets: V8ClusterRelatedMemorySnippet[]
): string {
    if (relatedMemorySnippets.length === 0) {
        return "(none)";
    }

    const sections: string[] = [];
    for (const item of relatedMemorySnippets) {
        sections.push(
            [
                `## edge ${item.edgeId} (${item.edgeType})`,
                `note: ${item.note}`,
                `src: ${item.srcNodeId} [${item.srcRole}] ${item.srcName} @ ${item.srcSourceRef}`,
                `src memory: ${sanitizeText(item.srcText, 300)}`,
                `dst: ${item.dstNodeId} [${item.dstRole}] ${item.dstName} @ ${item.dstSourceRef}`,
                `dst memory: ${sanitizeText(item.dstText, 300)}`,
            ].join("\n")
        );
    }
    return sections.join("\n\n");
}

export function buildClusterScenePrompt(
    input: V8ClusterRebuildPromptInput
): V8ClusterRebuildPromptMessages {
    return {
        system: [
            "Job: reconstruct the local memory scene for one suspicious cluster before any rebuild.",
            "",
            "Focus on what the cluster is really preserving, what should remain stable, what looks like a hitchhiker, and what new structure would better preserve future recall.",
            "",
            "Rules:",
            "- Do not rewrite the whole memory system.",
            "- Think locally around this cluster only.",
            "- Stable or core-like nodes should be preserved unless the evidence clearly says otherwise.",
            "- Lack of usage history alone is not proof that the memory should be deleted.",
            "- If the cluster contains factual or potentially reusable content, prefer a smaller sparse rebuild over full deletion.",
            "- Use short markdown sections only.",
        ].join("\n"),
        user: [
            "Step 1: restore the local scene and decide what looks essential versus parasitic.",
            "",
            "Diagnosis summary:",
            `- cluster id: ${input.diagnosis.clusterId}`,
            `- bundle ids: ${input.diagnosis.bundleIds.join(", ") || "(none)"}`,
            `- zone: ${input.diagnosis.zone}`,
            `- avg hit count: ${input.diagnosis.avgHitCount.toFixed(2)}`,
            `- avg adopt rate: ${input.diagnosis.avgAdoptRate.toFixed(2)}`,
            `- avg harm rate: ${input.diagnosis.avgHarmRate.toFixed(2)}`,
            `- internal density: ${input.diagnosis.internalAssociativeDensity.toFixed(2)}`,
            `- reasons: ${input.diagnosis.reasons.join(" ; ") || "(none)"}`,
            "",
            "Current cluster nodes:",
            renderNodeTable(input.nodes, input.diagnosis),
            "",
            "Current associative edges inside the cluster:",
            renderEdgeTable(input.edges),
            "",
            "Source snippets:",
            renderSources(input.sourceSnippets),
            "",
            "Edge-linked memory snippets for second check:",
            renderRelatedMemorySnippets(input.relatedMemorySnippets),
            "",
            "Output only these sections:",
            "",
            "# Cluster Scene",
            "- what this cluster is really about",
            "- what should remain stable",
            "- what looks stale, parasitic, or over-coupled",
            "- what new structure should exist after rebuild",
            "",
            "# Preserve Signals",
            "- node id | why it should survive",
            "",
            "# Drop Signals",
            "- node id | why it should be dropped or demoted",
        ].join("\n"),
    };
}

export function buildClusterRebuildPrompt(
    input: V8ClusterRebuildPromptInput,
    sceneDraft: string
): V8ClusterRebuildPromptMessages {
    return {
        system: [
            "Job: rebuild only this local cluster into a cleaner reusable structure.",
            "",
            "Preserve stable signal. Remove hitchhiker structure. Prefer a sparse rebuild.",
            "",
            "Rules:",
            "- Keep it local to this cluster.",
            "- Preserve stable node ids only in the preserve/drop sections; rebuilt nodes are new conceptual nodes.",
            "- Use exact node ids when listing preserve or drop decisions.",
            "- Do not treat zero-hit history as enough reason to erase factual memory.",
            "- If the source contains durable factual value, output at least 1 rebuilt node that preserves the useful part.",
            "- Complete deletion is a last resort for obvious noise or decorative junk only.",
            "- Use short markdown tables only.",
        ].join("\n"),
        user: [
            "Step 2: produce a local rebuild draft.",
            "",
            "Stage 1 result:",
            '"""',
            sanitizeText(sceneDraft, 12000),
            '"""',
            "",
            "Current nodes:",
            renderNodeTable(input.nodes, input.diagnosis),
            "",
            "Edge-linked memory snippets for second check:",
            renderRelatedMemorySnippets(input.relatedMemorySnippets),
            "",
            "Output only these sections:",
            "",
            "# Preserve Nodes",
            "| node id | keep reason |",
            "| --- | --- |",
            "| mn_xxx | keep because ... |",
            "",
            "# Drop Nodes",
            "| node id | drop reason |",
            "| --- | --- |",
            "| mn_yyy | hitchhiker / stale / merged elsewhere |",
            "",
            "# Rebuilt Nodes",
            "| zh name | en name | role | kind | text | summary |",
            "| --- | --- | --- | --- | --- | --- |",
            "| 更新前清理核心 | pre-patch core cleanup | workflow | procedural | short node text | short summary |",
            "",
            "# Rebuilt Relations",
            "| src node | src role | dst node | dst role | relation type | initial weight | why |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| 节点A | workflow | 节点B | condition | valid_when | 0.78 | short reason |",
            "",
            "# Rationale",
            "- why this rebuilt cluster is better for future recall",
        ].join("\n"),
    };
}

export function buildClusterRebuildSecondCheckPrompt(
    input: V8ClusterRebuildPromptInput,
    sceneDraft: string,
    firstDraft: string
): V8ClusterRebuildPromptMessages {
    return {
        system: [
            "Job: second-check a potentially over-pruned local rebuild draft.",
            "",
            "Do not keep noisy hitchhikers, but do not delete useful memory only because it is hard to trigger in token flow.",
            "Use edge-linked memory snippets to verify if latent reusable knowledge exists.",
            "",
            "Rules:",
            "- Keep this local to the same cluster.",
            "- If first draft dropped almost everything, re-check evidence/checkpoint/workflow value before confirming.",
            "- If any reusable memory exists, output a sparse preserved/rebuilt structure.",
            "- Use short markdown tables only.",
        ].join("\n"),
        user: [
            "Second check required: first draft may have over-pruned this cluster.",
            "",
            "Stage 1 scene:",
            '"""',
            sanitizeText(sceneDraft, 12000),
            '"""',
            "",
            "First rebuild draft:",
            '"""',
            sanitizeText(firstDraft, 12000),
            '"""',
            "",
            "Current nodes:",
            renderNodeTable(input.nodes, input.diagnosis),
            "",
            "Edge-linked memory snippets for second check:",
            renderRelatedMemorySnippets(input.relatedMemorySnippets),
            "",
            "Output only these sections:",
            "",
            "# Preserve Nodes",
            "| node id | keep reason |",
            "| --- | --- |",
            "",
            "# Drop Nodes",
            "| node id | drop reason |",
            "| --- | --- |",
            "",
            "# Rebuilt Nodes",
            "| zh name | en name | role | kind | text | summary |",
            "| --- | --- | --- | --- | --- | --- |",
            "",
            "# Rebuilt Relations",
            "| src node | src role | dst node | dst role | relation type | initial weight | why |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "",
            "# Rationale",
            "- explain what was retained after second check",
        ].join("\n"),
    };
}
