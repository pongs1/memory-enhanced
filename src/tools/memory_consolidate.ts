import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    resolveWorkspace,
    paths,
    today,
    readEvents,
    writeEvents,
    readFileOr,
    readJson,
    ensureDir,
    type MemoryEvent,
} from "../utils.js";
import { applyDecay, ageInDays } from "../decay.js";
import { postJson } from "../http-client.js";
import { buildV8Graph } from "../v8/compiler.js";
import { runOfflineBundleAnnotation } from "../v8/offline-annotator.js";

/** Parameter schema for memory_consolidate tool. */
export const MemoryConsolidateParams = Type.Object({
    scope: Type.Optional(
        Type.Union(
            [
                Type.Literal("session"),
                Type.Literal("day"),
                Type.Literal("full"),
            ],
            {
                default: "session",
                description:
                    "session: today only, day: past 7 days, full: all event files",
            }
        )
    ),
    dry_run: Type.Optional(
        Type.Boolean({
            default: false,
            description: "Preview changes without writing",
        })
    ),
});

export type MemoryConsolidateInput = Static<typeof MemoryConsolidateParams>;

interface ConsolidationReport {
    eventsScanned: number;
    unconsolidated: number;
    decayed: number;
    archived: number;
    memoryIndexChars: number;
    memoryIndexRegenerated: boolean;
    semanticCorpusEntries: number;
    associativeGraphNodes: number;
    associativeGraphEdges: number;
    v8GraphBundles: number;
    v8GraphNodes: number;
    v8GraphEdges: number;
    offlineAnnotatedBundles: number;
    offlineAnnotationSkipped: number;
    offlineAnnotationModel: string | null;
}

/**
 * Execute memory_consolidate: structural consolidation cycle.
 *
 * What this tool does (zero LLM tokens):
 *   1. Apply decay formula to consolidated events
 *   2. Archive events with decay_score < threshold
 *   3. Regenerate MEMORY_INDEX.md from knowledge files
 *
 * What this tool does NOT do (requires LLM):
 *   - Extract knowledge from events (LLM reads events, writes knowledge/*.md)
 *   - Create skill templates (LLM pattern recognition)
 *
 * The intended workflow:
 *   1. LLM reads unconsolidated events and distills knowledge
 *   2. LLM marks events as consolidated (via memory_record or direct edit)
 *   3. LLM calls memory_consolidate to run structural steps
 */
export async function executeMemoryConsolidate(
    _toolCallId: string,
    params: MemoryConsolidateInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const pluginConfig = (ctx as any)?.config;
    const p = paths(workspace);
    const halfLife = pluginConfig?.halfLifeDays ?? 30;
    const archiveThresh = pluginConfig?.archiveThreshold ?? 0.2;
    const scope = params.scope ?? "session";
    const dryRun = params.dry_run ?? false;
    const todayStr = today();
    const now = new Date();

    // Read the last active time from focus_stack to calculate active days
    const focusStackInfo = readJson<{ last_updated?: string }>(p.focusStack, {});
    const lastActiveStr = focusStackInfo.last_updated;
    // We only calculate decay up to the last known active session time
    // If the agent was offline for 3 months, ageInDays will only reflect time up to last active,
    // thereby solving the "forget everything if offline" issue. Let's use `now` if `last_updated`
    // is missing, but otherwise use the `last_updated` date as the reference point for decay.
    const referenceDate = lastActiveStr ? new Date(lastActiveStr) : now;

    const report: ConsolidationReport = {
        eventsScanned: 0,
        unconsolidated: 0,
        decayed: 0,
        archived: 0,
        memoryIndexChars: 0,
        memoryIndexRegenerated: false,
        semanticCorpusEntries: 0,
        associativeGraphNodes: 0,
        associativeGraphEdges: 0,
        v8GraphBundles: 0,
        v8GraphNodes: 0,
        v8GraphEdges: 0,
        offlineAnnotatedBundles: 0,
        offlineAnnotationSkipped: 0,
        offlineAnnotationModel: null,
    };

    // --- 1. Collect event files based on scope ---
    const jsonlFiles = getJsonlFiles(p.eventsDir, scope, todayStr);

    // --- 2. Apply decay and archive ---
    for (const jsonlPath of jsonlFiles) {
        const events = readEvents(jsonlPath);
        if (events.length === 0) continue;

        report.eventsScanned += events.length;
        const kept: MemoryEvent[] = [];
        const archived: MemoryEvent[] = [];

        for (const evt of events) {
            if (!evt.consolidated) {
                report.unconsolidated++;
                kept.push(evt);
                continue;
            }

            // Apply decay to consolidated events using referenceDate (active time)
            const age = ageInDays(evt.timestamp, referenceDate);
            if (age > 0) {
                const newScore = applyDecay(evt.decay_score, age, halfLife);
                if (newScore < archiveThresh) {
                    archived.push(evt);
                    report.archived++;
                } else {
                    if (newScore !== evt.decay_score) {
                        evt.decay_score = newScore;
                        report.decayed++;
                    }
                    kept.push(evt);
                }
            } else {
                kept.push(evt);
            }
        }

        if (!dryRun && (archived.length > 0 || report.decayed > 0)) {
            // Write kept events back
            writeEvents(jsonlPath, kept);

            // Archive removed events
            if (archived.length > 0) {
                const archivePath = path.join(
                    p.archiveDir,
                    path.basename(jsonlPath)
                );
                ensureDir(p.archiveDir);
                const existing = readEvents(archivePath);
                writeEvents(archivePath, [...existing, ...archived]);
            }
        }
    }

    // --- 3. Regenerate MEMORY_INDEX.md ---
    const memoryIndexContent = generateMemoryIndex(p.knowledgeDir);
    report.memoryIndexChars = memoryIndexContent.length;

    if (!dryRun) {
        fs.writeFileSync(p.memoryIndex, memoryIndexContent, "utf-8");
        report.memoryIndexRegenerated = true;
    }

    // --- 4. Regenerate Dual-Storage Architecture ---

    // 4A. Build Semantic Corpus (The "Library" for Offline LLM Annotation)
    const semanticCorpus = buildSemanticCorpus(p.knowledgeDir);
    report.semanticCorpusEntries = semanticCorpus.length;

    // 4B. Offline LLM Semantic Wiring (The "Batch Annotation" phase)
    // We only perform the expensive API call if we are NOT in dry_run mode
    let annotatedEdges: AssociativeEdge[] = [];
    if (!dryRun) {
        annotatedEdges = await annotateEdgesWithLLM(semanticCorpus);
    }

    // 4C. Build Associative Graph (The "Nerve Net" for Real-Time CPU Scanner)
    const { nodes, edges } = await buildAssociativeGraph(semanticCorpus, annotatedEdges);
    report.associativeGraphNodes = Object.keys(nodes).length;
    report.associativeGraphEdges = edges.length;

    if (!dryRun) {
        fs.writeFileSync(p.semanticCorpus, JSON.stringify(semanticCorpus, null, 2), "utf-8");
        fs.writeFileSync(p.associativeGraph, JSON.stringify({ nodes, edges }, null, 2), "utf-8");

        const v8Graph = await buildV8Graph({
            workspace,
            includeEvents: true,
            includeKnowledgeMd: true,
            includeSkillMd: false,
            writeToDisk: true,
        });
        report.v8GraphBundles = v8Graph.bundles.length;
        report.v8GraphNodes = v8Graph.nodes.length;
        report.v8GraphEdges = v8Graph.edges.length;

        const annotationRun = await runOfflineBundleAnnotation({
            workspace,
            bundles: v8Graph.bundles,
        });
        report.offlineAnnotatedBundles = annotationRun.records.length;
        report.offlineAnnotationSkipped = annotationRun.skipped;
        report.offlineAnnotationModel = annotationRun.model;
    }

    // --- Format report ---
    const lines = [
        `Consolidation ${dryRun ? "(DRY RUN) " : ""}complete:`,
        `  Scope: ${scope}`,
        `  Events scanned: ${report.eventsScanned}`,
        `  Unconsolidated (need LLM distillation): ${report.unconsolidated}`,
        `  Decay applied: ${report.decayed}`,
        `  Archived (score < ${archiveThresh}): ${report.archived}`,
        `  MEMORY_INDEX.md: ${report.memoryIndexChars} chars ${report.memoryIndexRegenerated ? "(regenerated)" : "(preview)"}`,
        `  Semantic Corpus: ${report.semanticCorpusEntries} events compiled for offline LLM annotation`,
        `  Associative Graph: ${report.associativeGraphNodes} fast nodes, ${report.associativeGraphEdges} structural edges`,
        `  V8 Graph: ${report.v8GraphBundles} bundles, ${report.v8GraphNodes} nodes, ${report.v8GraphEdges} edges`,
        `  Offline Annotation Drafts: ${report.offlineAnnotatedBundles} new, ${report.offlineAnnotationSkipped} skipped${report.offlineAnnotationModel ? ` (${report.offlineAnnotationModel})` : " (no model configured)"}`,
    ];

    if (report.unconsolidated > 0) {
        lines.push(
            "",
            `⚠️ ${report.unconsolidated} events are unconsolidated.`,
            `To distill them: read .memory/events/*.jsonl, extract durable knowledge`,
            `into memory/knowledge/*.md, then mark events as consolidated.`
        );
    }

    const maxChars = pluginConfig?.memoryMdMaxChars ?? 5000;
    if (report.memoryIndexChars > maxChars) {
        lines.push(
            "",
            `⚠️ MEMORY_INDEX.md is ${report.memoryIndexChars} chars (target: <${maxChars}).`,
            `Consider consolidating knowledge files or archiving old entries.`
        );
    }

    return {
        content: [{ type: "text", text: lines.join("\n") }],
    };
}

// --- Internal helpers ---

function getJsonlFiles(
    eventsDir: string,
    scope: string,
    todayStr: string
): string[] {
    if (!fs.existsSync(eventsDir)) return [];

    const allFiles = fs
        .readdirSync(eventsDir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => path.join(eventsDir, f))
        .sort();

    if (scope === "session") {
        const todayFile = path.join(eventsDir, `${todayStr}.jsonl`);
        return allFiles.filter((f: string) => f === todayFile);
    }

    if (scope === "day") {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        return allFiles.filter((f: string) => {
            const basename = path.basename(f, ".jsonl");
            return basename >= cutoffStr;
        });
    }

    // scope === "full"
    return allFiles;
}

function generateMemoryIndex(knowledgeDir: string): string {
    const lines = [
        `# Long-Term Memory Index`,
        `> **Core Project Context & User Knowledge**`,
        `> This is a lightweight index. If a file looks relevant, use the \`read\` or \`memory_explore\` tool to fetch its full contents.`,
        ``
    ];

    if (!fs.existsSync(knowledgeDir)) {
        lines.push("(No knowledge files yet. Consolidation will populate this.)");
        return lines.join("\n");
    }

    const files = fs
        .readdirSync(knowledgeDir)
        .filter((f: string) => f.endsWith(".md"))
        .sort();

    for (const file of files) {
        const content = readFileOr(path.join(knowledgeDir, file));
        const entryCount = content.split("\n").filter((l: string) => l.trim().startsWith("## ")).length;

        const contentLines = content.split("\n");
        const titleLine = contentLines.find((l: string) => l.startsWith("# ")) || `# ${file.replace(".md", "")}`;

        let description = "";
        for (const line of contentLines) {
            if (line.trim() === "" || line.startsWith("# ")) continue;
            if (line.length > 5 && !line.startsWith("<!--")) {
                description = line.replace(/^[>|│]\s*/, "").substring(0, 100);
                if (description.length === 100) description += "...";
                break;
            }
        }

        const cleanTitle = titleLine.replace(/^#\s*/, "");
        lines.push(`- \`memory/knowledge/${file}\` (${entryCount} entries) — **${cleanTitle}**: ${description}`);
    }

    return lines.join("\n");
}

export interface SemanticCorpusEntry {
    id: string;          // e.g. "macro_economy_analysis_2026.md"
    title: string;
    summary: string;
    entities: string[];
}

function buildSemanticCorpus(knowledgeDir: string): SemanticCorpusEntry[] {
    const corpus: SemanticCorpusEntry[] = [];
    if (!fs.existsSync(knowledgeDir)) return corpus;

    const files = fs
        .readdirSync(knowledgeDir)
        .filter((f: string) => f.endsWith(".md"));

    const stopWords = new Set(["the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "about", "is", "are", "was", "were", "be", "this", "that", "it", "of", "by", "as", "from", "how", "what", "where", "when", "why", "who", "which", "can", "will", "would", "should"]);

    // Extremely basic entity extraction purely for LLM context hints. 
    // True intelligence lies in the offline LLM deep wiring, not this extraction.
    const extractEntities = (text: string): string[] => {
        const words = text
            .replace(/[^a-zA-Z\u4e00-\u9fa5]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 2 && !stopWords.has(w.toLowerCase()));

        // Simple trick: proper nouns or specific Chinese keywords often appear multiple times.
        // We just return a deduplicated array of the top words.
        const freq: Record<string, number> = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;

        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(e => e[0]);
    };

    for (const file of files) {
        const filePath = `memory/knowledge/${file}`;
        const content = readFileOr(path.join(knowledgeDir, file));

        const headers = content.match(/^#+\s+(.*)$/gm) || [];
        const titleLine = headers[0]?.replace(/^#\s*/, "") || file.replace(".md", "");

        // Extract a crude summary (first non-header chunk of text)
        let summary = "";
        const lines = content.split("\n");
        for (const line of lines) {
            if (line.trim() && !line.startsWith("#") && !line.startsWith("<!--")) {
                summary = line.substring(0, 200).trim();
                break;
            }
        }

        const entities = extractEntities(headers.join(" ") + " " + summary);

        corpus.push({
            id: filePath,
            title: titleLine,
            summary: summary,
            entities: entities
        });
    }

    return corpus;
}

export interface AssociativeNode {
    id: string;
    triggers: string[];
    vector?: number[];
}

export interface AssociativeEdge {
    source: string;
    target: string;
    weight: number;
}

async function buildAssociativeGraph(corpus: SemanticCorpusEntry[], annotatedEdges: AssociativeEdge[]): Promise<{ nodes: Record<string, AssociativeNode>; edges: AssociativeEdge[] }> {
    const nodes: Record<string, AssociativeNode> = {};
    const edges: AssociativeEdge[] = [...annotatedEdges];

    let pipeline: any;
    try {
        const xenova = await import("@xenova/transformers");
        // Using the tiny, blazing fast 22MB all-MiniLM-L6-v2 model
        pipeline = await xenova.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    } catch (e) {
        console.warn("[Memory V8] @xenova/transformers failed to load. Falling back to keyword triggers only.", e);
    }

    for (const entry of corpus) {
        // Fast Trigger generation: The CPU scanner matches against these triggers as a fallback.
        const titleWords = entry.title
            .replace(/[^a-zA-Z\u4e00-\u9fa5]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 2);

        const triggers = Array.from(new Set([...titleWords, ...entry.entities]));

        // V8 Latent Surface Target: Embed the node's core identity down to 384 dimensions
        let vector: number[] | undefined = undefined;
        if (pipeline) {
            try {
                // We embed the title and top entities to represent the 'surface' area of the node
                const textToEmbed = `${entry.title}. ${entry.entities.join(" ")}`;
                const output = await pipeline(textToEmbed, { pooling: "mean", normalize: true });
                vector = Array.from(output.data);
            } catch (e) {
                console.warn(`[Memory V8] Embedding failed for ${entry.id}`, e);
            }
        }

        nodes[entry.id] = {
            id: entry.id,
            triggers: triggers,
            vector: vector
        };
    }

    return { nodes, edges };
}

/**
 * Batches the Semantic Corpus and sends it to an LLM API to deduce deep semantic wormholes (edges).
 * Uses process.env.OPENAI_API_KEY and OPENAI_BASE_URL (compatible with SiliconFlow/Ollama/DeepSeek).
 */
async function annotateEdgesWithLLM(corpus: SemanticCorpusEntry[]): Promise<AssociativeEdge[]> {
    if (corpus.length < 2) return [];

    const apiKey = process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1";
    // Defaulting to a strong reasoning model suitable for topology generation
    const model =
        process.env.MEMORY_ANNOTATION_MODEL ||
        process.env.OPENAI_MODEL ||
        "MiniMaxAI/MiniMax-M2.5";

    if (!apiKey) {
        console.warn("[Memory V8] No OPENAI_API_KEY or SILICONFLOW_API_KEY found. Skipping offline semantic wiring.");
        return [];
    }

    // We constrain the payload by selecting a concise representation of the entries
    const batchPayload = corpus.map(c => ({
        id: c.id,
        title: c.title,
        entities: c.entities.join(", ")
    }));

    const systemPrompt = `You are a Subconscious Pattern Recognizer (Hippocampus Consolidator).
Your task is to analyze a batch of disjointed memory nodes and discover deep, latent, non-obvious structural connections between them (e.g., causality, strong metaphor, hidden correlation).

CRITICAL CONSTRAINTS:
1. Do NOT link nodes just because they share trivial words. Only link them if triggering one should absolutely bring the other into the conscious mind context.
2. The "source" and "target" MUST perfectly match the exact "id" provided in the input JSON. Do not hallucinate IDs.
3. You must ONLY output a valid JSON array. Do not include markdown formatting like \`\`\`json. Do not include conversational text or explanations outside the JSON array. Output perfectly parsable JSON.

Format requirement:
[
  {
    "source": "memory/knowledge/node_A.md",
    "target": "memory/knowledge/node_B.md",
    "weight": 0.9,
    "reason": "Causality: event A directly caused event B."
  }
]`;

    const userPrompt = `Here is the current memory corpus:\n${JSON.stringify(batchPayload, null, 2)}\n\nGenerate the structural edges as a raw JSON array. Do not wrap in markdown code blocks.`;

    try {
        console.log(`[Memory V8] Sending ${corpus.length} nodes to ${model} for deep semantic wiring...`);
        const data = await postJson({
            url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
            headers: {
                "Authorization": `Bearer ${apiKey}`
            },
            body: {
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
                response_format: { type: "json_object" } // if supported, else rely on prompt
            },
        });
        let rawContent = data.choices[0].message.content.trim();

        // Strip markdown blocks if the LLM ignored instructions
        if (rawContent.startsWith("\`\`\`json")) {
            rawContent = rawContent.replace(/^\`\`\`json/i, "").replace(/\`\`\`$/, "").trim();
        } else if (rawContent.startsWith("\`\`\`")) {
            rawContent = rawContent.replace(/^\`\`\`/i, "").replace(/\`\`\`$/, "").trim();
        }

        let parsed = JSON.parse(rawContent);
        // If wrapped in an object
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const possibleArray = Object.values(parsed).find(v => Array.isArray(v));
            if (possibleArray) parsed = possibleArray;
        }

        if (Array.isArray(parsed)) {
            // Validate output
            const validEdges: AssociativeEdge[] = [];
            for (const item of parsed) {
                if (item.source && item.target && typeof item.weight === "number") {
                    validEdges.push({
                        source: item.source,
                        target: item.target,
                        weight: Math.min(Math.max(item.weight, 0.1), 1.0)
                    });
                }
            }
            console.log(`[Memory V8] Successfully wired ${validEdges.length} latent semantic edges.`);
            return validEdges;
        }

    } catch (e) {
        console.warn(`[Memory V8] Failed to parse LLM annotation JSON: ${String(e)}`);
    }

    return [];
}
