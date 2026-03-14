import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../utils.js";
import { v8StorePaths } from "./paths_v8.js";
import type { V8HypothesisEdge } from "./types_v8.js";

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

function appendJsonl(filePath: string, entry: unknown): void {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function normalizeModeHint(value?: string): "oblique" | "trajectory" {
    return value === "trajectory" ? "trajectory" : "oblique";
}

function normalizeStatus(value?: string): V8HypothesisEdge["status"] {
    switch (value) {
        case "validated":
        case "rejected":
        case "expired":
        case "candidate":
            return value;
        default:
            return "candidate";
    }
}

function normalizeEdge(raw: any): V8HypothesisEdge | null {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (typeof raw.src !== "string" || typeof raw.dst !== "string") return null;
    const supportEvidenceSpanIds = Array.isArray(raw.supportEvidenceSpanIds)
        ? raw.supportEvidenceSpanIds.filter((id: any) => typeof id === "string" && id)
        : [];
    const inferenceTrace =
        typeof raw.inferenceTrace === "string" ? raw.inferenceTrace : "";
    return {
        id: raw.id,
        src: raw.src,
        dst: raw.dst,
        suggestedType:
            typeof raw.suggestedType === "string" ? raw.suggestedType : "related_to",
        modeHint: normalizeModeHint(raw.modeHint),
        supportEvidenceSpanIds,
        inferenceTrace,
        confidence: clamp01(typeof raw.confidence === "number" ? raw.confidence : 0.5),
        status: normalizeStatus(raw.status),
        expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    };
}

function isExpired(edge: V8HypothesisEdge): boolean {
    if (!edge.expiresAt) return false;
    const ts = Date.parse(edge.expiresAt);
    if (Number.isNaN(ts)) return false;
    return Date.now() > ts;
}

export function loadHypothesisEdges(workspace: string): V8HypothesisEdge[] {
    const store = v8StorePaths(workspace);
    if (!fs.existsSync(store.hypothesisEdges)) return [];
    const map = new Map<string, V8HypothesisEdge>();
    const entries = readJsonl<any>(store.hypothesisEdges);
    for (const raw of entries) {
        const edge = normalizeEdge(raw);
        if (!edge) continue;
        map.set(edge.id, edge);
    }
    return Array.from(map.values()).filter((edge) => {
        if (edge.status === "rejected" || edge.status === "expired") return false;
        if (isExpired(edge)) return false;
        if (!edge.inferenceTrace) return false;
        if (!edge.supportEvidenceSpanIds || edge.supportEvidenceSpanIds.length === 0) {
            return false;
        }
        return true;
    });
}

export function appendHypothesisEdge(
    workspace: string,
    edge: V8HypothesisEdge
): void {
    const store = v8StorePaths(workspace);
    appendJsonl(store.hypothesisEdges, edge);
}
