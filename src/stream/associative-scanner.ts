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
    private threshold: number = 3.0; // The threshold for recall
    private decayRate: number = 0.95; // Applied every N tokens
    private tokenBuffer: string = "";
    private tokenCount: number = 0;
    private firedMemories: Set<string> = new Set();
    private workspace: string;

    constructor(workspace: string) {
        this.workspace = workspace;
        const graphPath = paths(workspace).associativeGraph;
        this.graph = readJson<GraphData>(graphPath, { nodes: {}, edges: [] });
    }

    /**
     * Pre-excite the network based on the user's initial prompt to solve the
     * "cold-start amnesia" problem. Pumps massive initial energy into matched nodes.
     */
    public preExcite(prompt: string) {
        if (!prompt || !this.graph || Object.keys(this.graph.nodes).length === 0) return;

        const lowerPrompt = prompt.toLowerCase();
        let excitationTriggered = false;

        for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
            if (node.type === "concept") {
                // If the user's prompt contains the concept, fire it up
                // We use a simple word boundary or substring match
                if (lowerPrompt.includes(nodeId)) {
                    this.activate(nodeId, 5.0); // Pump 5.0 massive initial energy
                    excitationTriggered = true;
                }
            }
        }

        if (excitationTriggered) {
            // Spread the initial shockwave
            this.spreadActivation();
            // Spread it one more time to reach deeper memories quickly
            this.spreadActivation();
        }
    }

    /**
     * Process a new text chunk from the LLM stream.
     * Returns a triggered memory file path if activation exceeds threshold,
     * otherwise returns null.
     */
    public processChunk(chunk: string): string | null {
        if (!chunk || !this.graph || Object.keys(this.graph.nodes).length === 0) return null;

        this.tokenBuffer += chunk.toLowerCase();
        this.tokenCount++;

        // Excite nodes that strictly match the end of the buffer
        let excitationTriggered = false;
        for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
            if (node.type === "concept") {
                // simple substring check at the tail of the buffer
                if (this.tokenBuffer.endsWith(nodeId)) {
                    this.activate(nodeId, 1.0); // Pump 1.0 energy unit
                    excitationTriggered = true;
                }
            }
        }

        if (excitationTriggered) {
            this.spreadActivation();
        }

        // Apply decay every some tokens
        if (this.tokenCount % 5 === 0) {
            this.applyDecay();
            // Keep buffer small
            if (this.tokenBuffer.length > 100) {
                this.tokenBuffer = this.tokenBuffer.slice(this.tokenBuffer.length - 50);
            }
        }

        // Check for threshold breach
        for (const [nodeId, node] of Object.entries(this.graph.nodes)) {
            if (node.type === "memory" && !this.firedMemories.has(nodeId)) {
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

        // For each edge, spread energy from source to target
        for (const edge of this.graph.edges) {
            const sourceEnergy = this.activations[edge.source] || 0;
            if (sourceEnergy > 0.1) {
                // Standard spreading formula: spread = source_energy * edge_weight * dampening
                const transfer = sourceEnergy * edge.weight * 0.2;
                spreadAmount[edge.target] = (spreadAmount[edge.target] || 0) + transfer;
            }
        }

        // Apply spread amounts
        for (const [target, energy] of Object.entries(spreadAmount)) {
            this.activate(target, energy);
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
        const fullPath = path.join(this.workspace, filePath); // memory/knowledge/file.md
        return readFileOr(fullPath, "No content found");
    }
}
