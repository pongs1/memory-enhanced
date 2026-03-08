import * as fs from "node:fs";
import * as path from "node:path";
import { paths, readJson, readFileOr } from "../utils.js";

interface GraphData {
    nodes: Record<string, any>;
    edges: Array<{ source: string; target: string; weight: number }>;
}

export class AssociativeScanner {
    private graph: GraphData;
    private activations: Record<string, number> = {};
    private threshold: number = 2.0; // Lowered threshold since vectors are more precise
    private decayRate: number = 0.95;
    private wordBuffer: string[] = [];
    private firedMemories: Set<string> = new Set();
    private workspace: string;

    // Xenova Integration
    private pipeline: any = null;
    private pipelineLoading: boolean = false;
    private vPrevious: number[] | null = null;
    private readonly alpha: number = 0.7; // EMA weight for current thought chunk

    constructor(workspace: string) {
        this.workspace = workspace;
        const graphPath = paths(workspace).associativeGraph;
        this.graph = readJson<GraphData>(graphPath, { nodes: {}, edges: [] });
    }

    private async initPipeline() {
        if (this.pipeline || this.pipelineLoading) return;
        this.pipelineLoading = true;
        try {
            const xenova = await import("@xenova/transformers");
            this.pipeline = await xenova.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        } catch (e) {
            console.warn("[Memory V8] Real-time Xenova failed to load. Using pure lexical triggers.", e);
        }
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Pre-excite the network based on the user's initial prompt.
     */
    public async preExcite(prompt: string) {
        if (!prompt || !this.graph || Object.keys(this.graph.nodes).length === 0) return;
        await this.initPipeline();

        const lowerPrompt = prompt.toLowerCase();
        let excitationTriggered = false;

        for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
            // Check triggers first
            if (node.triggers && node.triggers.some((t: string) => lowerPrompt.includes(t.toLowerCase()))) {
                this.activate(nodeId, 3.0);
                excitationTriggered = true;
            }
        }

        if (this.pipeline) {
            try {
                const output = await this.pipeline(prompt, { pooling: "mean", normalize: true });
                const vPrompt = Array.from(output.data) as number[];
                for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
                    if (node.vector) {
                        const sim = this.cosineSimilarity(vPrompt, node.vector as number[]);
                        if (sim > 0.5) { // Similarity threshold for user prompt
                            this.activate(nodeId, sim * 4.0);
                            excitationTriggered = true;
                        }
                    }
                }
            } catch (e) {
                // Ignore silent
            }
        }

        if (excitationTriggered) {
            this.spreadActivation();
            this.spreadActivation();
        }
    }

    /**
     * Process a new text chunk from the LLM stream.
     * Buffers tokens. Every ~10 words, triggers real-time vector EMA.
     */
    public async processChunk(chunk: string): Promise<string | null> {
        if (!chunk || !this.graph || Object.keys(this.graph.nodes).length === 0) return null;
        await this.initPipeline();

        // 1. Primitive Lexical Ignition (Fallback & Fast Match)
        const lowerChunk = chunk.toLowerCase();
        let excitationTriggered = false;
        for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
            if (node.triggers && node.triggers.some((t: string) => lowerChunk.includes(t.toLowerCase()))) {
                this.activate(nodeId, 0.5);
                excitationTriggered = true;
            }
        }

        // 2. Sliding Window Buffer
        // We split by spaces just to approximate word counts
        const newWords = chunk.split(/(\s+)/).filter(w => w.trim().length > 0);
        this.wordBuffer.push(...newWords);

        if (this.wordBuffer.length >= 10) {
            this.applyDecay();
            const thoughtString = this.wordBuffer.join(" ");

            // 3. V8 Continuous Vector Thought Trajectory
            if (this.pipeline) {
                try {
                    const output = await this.pipeline(thoughtString, { pooling: "mean", normalize: true });
                    const vCurrent = Array.from(output.data) as number[];

                    let vQuery: number[];
                    if (this.vPrevious) {
                        vQuery = vCurrent.map((v, i) => (this.alpha * v) + ((1 - this.alpha) * this.vPrevious![i]));
                    } else {
                        vQuery = vCurrent;
                    }
                    this.vPrevious = vQuery;

                    // Surface Match
                    for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
                        if (node.vector) {
                            const sim = this.cosineSimilarity(vQuery, node.vector as number[]);
                            if (sim > 0.55) { // Ignition Threshold
                                this.activate(nodeId, sim * 1.5);
                                excitationTriggered = true;
                            }
                        }
                    }
                } catch (e) {
                    // Ignore silent
                }
            }

            // Keep window rolling, retain last 5 words for overlap context
            this.wordBuffer = this.wordBuffer.slice(this.wordBuffer.length - 5);
        }

        if (excitationTriggered) {
            this.spreadActivation();
        }

        // 4. Memory Threshold Breach Check
        for (const nodeId of Object.keys(this.graph.nodes)) {
            if (!this.firedMemories.has(nodeId)) {
                const energy = this.activations[nodeId] || 0;
                if (energy >= this.threshold) {
                    this.firedMemories.add(nodeId);
                    return nodeId; // Trigger Recall!
                }
            }
        }

        return null;
    }

    private activate(nodeId: string, energy: number) {
        this.activations[nodeId] = (this.activations[nodeId] || 0) + energy;
    }

    private spreadActivation() {
        const spreadAmount: Record<string, number> = {};

        // Calculate node degrees (how many edges connect to each node) to penalize super-hubs
        const degree: Record<string, number> = {};
        for (const edge of this.graph.edges) {
            degree[edge.source] = (degree[edge.source] || 0) + 1;
            degree[edge.target] = (degree[edge.target] || 0) + 1;
        }

        // For each edge, spread energy bidirectionally
        for (const edge of this.graph.edges) {
            const sourceEnergy = this.activations[edge.source] || 0;
            const targetEnergy = this.activations[edge.target] || 0;

            if (sourceEnergy > 0.1) {
                // Forward spread with Hub Penalization (Activation Storm prevention)
                const penalty = Math.sqrt(degree[edge.source] || 1);
                const transfer = (sourceEnergy * edge.weight * 0.3) / penalty;
                spreadAmount[edge.target] = (spreadAmount[edge.target] || 0) + transfer;
            }
            if (targetEnergy > 0.1) {
                // Reverse spread (back-propagation) with Hub Penalization
                const penalty = Math.sqrt(degree[edge.target] || 1);
                const reverseTransfer = (targetEnergy * edge.weight * 0.15) / penalty;
                spreadAmount[edge.source] = (spreadAmount[edge.source] || 0) + reverseTransfer;
            }
        }

        // Apply spread amounts
        for (const [target, energy] of Object.entries(spreadAmount)) {
            this.activate(target, energy);
        }
    }

    /**
     * RLHF Graph Adaptation: Punish or reinforce edges leading to a specific memory node.
     * Called when the system detects the user ignoring or rejecting an injected memory.
     */
    public adaptWeights(targetNodeId: string, feedback: "positive" | "negative") {
        let changed = false;
        const adjustment = feedback === "positive" ? 1.2 : 0.5; // boost 20% or slash 50%

        for (const edge of this.graph.edges) {
            if (edge.target === targetNodeId || edge.source === targetNodeId) {
                edge.weight = Math.min(Math.max(edge.weight * adjustment, 0.01), 1.0);
                changed = true;
            }
        }

        if (changed) {
            // Save the updated personalized graph (Dynamic LoRA effect)
            const p = paths(this.workspace);
            fs.writeFileSync(p.associativeGraph, JSON.stringify(this.graph, null, 2), "utf-8");
            console.log(`[Memory V8] RLHF applied: ${feedback} feedback for ${targetNodeId}. Edge weights adapted.`);
        }
    }

    private applyDecay() {
        for (const nodeId of Object.keys(this.activations)) {
            this.activations[nodeId] *= this.decayRate;
            if (this.activations[nodeId] < 0.05) {
                delete this.activations[nodeId]; // Prune near-zero activations
            }
        }
    }

    public getMemoryContent(filePath: string): string {
        const p = paths(this.workspace);
        const fullPath = path.join(this.workspace, filePath);
        return readFileOr(fullPath, "No content found");
    }
}
