import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../utils.js";
import { ensureV8StoreDirs, v8StorePaths } from "./paths_v8.js";

export type FeedbackKind = "reinforce" | "suppress";
export type FeedbackLayer = "flash" | "scene" | "durable";
export type FeedbackOperation = "reinforce" | "suppress" | "scope_shift" | "clear";

export interface FeedbackRecord {
    feedbackId: string;
    sessionId?: string;
    runId?: string;
    recallTraceId?: string;
    source?: "user" | "tool" | "model";
    label?: string;
    polarity?: "positive" | "negative" | "neutral";
    targets: string[];
    scope: FeedbackLayer;
    evidenceRefs?: string[];
    reason?: string;
    createdAt: string;
}

export interface FeedbackOverride {
    overrideId: string;
    feedbackId?: string;
    targetId: string;
    layer: FeedbackLayer;
    operation: FeedbackOperation;
    delta: number;
    reason?: string;
    createdAt: string;
    expiresAt: string | null;
}

const feedbackByNode = new Map<string, FeedbackOverride[]>();
let feedbackLoadedAt = 0;
let feedbackFileMtime = 0;

interface NodeLabelEntry {
    label: string;
    aliases: string[];
}

let nodeLabelCache: Map<string, NodeLabelEntry> | null = null;
let nodeLabelMtime = 0;

function nowIso(): string {
    return new Date().toISOString();
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

function appendJsonl(filePath: string, entry: unknown): void {
    ensureDir(path.dirname(filePath));
    const line = JSON.stringify(entry);
    fs.appendFileSync(filePath, line + "\n", "utf-8");
}

function normalizeText(text: string): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function tokenize(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const english = normalized.match(/[a-z0-9_-]{3,}/g) || [];
    const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const chunks: string[] = [];
    for (const chunk of cjk) {
        if (chunk.length <= 4) {
            chunks.push(chunk);
            continue;
        }
        for (let size = 2; size <= Math.min(4, chunk.length); size++) {
            for (let i = 0; i <= chunk.length - size; i++) {
                chunks.push(chunk.slice(i, i + size));
            }
        }
    }
    return [...english, ...chunks];
}

function overlapScore(tokens: Set<string>, referenceTokens: Set<string>): number {
    if (tokens.size === 0 || referenceTokens.size === 0) return 0;
    let matches = 0;
    for (const token of referenceTokens) {
        if (tokens.has(token)) matches += 1;
    }
    return matches / referenceTokens.size;
}

function feedbackOverridesPath(workspace: string): string {
    const store = v8StorePaths(workspace);
    return store.feedbackOverrides;
}

function feedbackRecordsPath(workspace: string): string {
    const store = v8StorePaths(workspace);
    return store.feedbackRecords;
}

function legacyOverridesPath(workspace: string): string {
    const store = v8StorePaths(workspace);
    return store.packCache.replace("pack_cache.jsonl", "feedback_overrides.jsonl");
}

function loadFeedbackStore(workspace: string): void {
    const filePath = feedbackOverridesPath(workspace);
    const legacyPath = legacyOverridesPath(workspace);
    let stat: fs.Stats | null = null;
    let legacyStat: fs.Stats | null = null;
    try {
        stat = fs.statSync(filePath);
    } catch {
        stat = null;
    }
    try {
        if (legacyPath !== filePath) {
            legacyStat = fs.statSync(legacyPath);
        }
    } catch {
        legacyStat = null;
    }

    const mtime = Math.max(stat ? stat.mtimeMs : 0, legacyStat ? legacyStat.mtimeMs : 0);
    if (feedbackLoadedAt > 0 && mtime === feedbackFileMtime) {
        return;
    }

    feedbackByNode.clear();
    const entries = stat ? readJsonl<any>(filePath) : [];
    for (const raw of entries) {
        const entry = normalizeOverride(raw);
        if (!entry?.targetId) continue;
        const list = feedbackByNode.get(entry.targetId) || [];
        list.push(entry);
        feedbackByNode.set(entry.targetId, list);
    }

    // Backward compatibility: load legacy overrides if present.
    if (legacyPath !== filePath && legacyStat) {
        const legacy = readJsonl<any>(legacyPath);
        for (const raw of legacy) {
            const entry = normalizeOverride(raw);
            if (!entry?.targetId) continue;
            const list = feedbackByNode.get(entry.targetId) || [];
            list.push(entry);
            feedbackByNode.set(entry.targetId, list);
        }
    }
    feedbackLoadedAt = Date.now();
    feedbackFileMtime = mtime;
}

function storeNodeLabels(workspace: string): void {
    const store = v8StorePaths(workspace);
    let stat: fs.Stats | null = null;
    try {
        stat = fs.statSync(store.graphNodes);
    } catch {
        stat = null;
    }
    const mtime = stat ? stat.mtimeMs : 0;
    if (nodeLabelCache && nodeLabelMtime === mtime) return;

    const nodes = stat ? readJsonl<any>(store.graphNodes) : [];
    const next = new Map<string, NodeLabelEntry>();
    for (const node of nodes) {
        if (!node?.id) continue;
        next.set(node.id, {
            label: String(node.canonicalLabel || ""),
            aliases: Array.isArray(node.aliases) ? node.aliases : [],
        });
    }
    nodeLabelCache = next;
    nodeLabelMtime = mtime;
}

function pruneExpired(): void {
    const now = Date.now();
    for (const [nodeId, entries] of feedbackByNode.entries()) {
        const next = entries.filter((entry) => {
            if (!entry.expiresAt) return true;
            return Date.parse(entry.expiresAt) > now;
        });
        if (next.length === 0) {
            feedbackByNode.delete(nodeId);
        } else {
            feedbackByNode.set(nodeId, next);
        }
    }
}

export function refreshFeedbackStore(workspace: string): void {
    loadFeedbackStore(workspace);
    pruneExpired();
}

export function recordFeedback(
    workspace: string,
    entries: Array<{
        nodeId: string;
        kind: FeedbackKind;
        delta: number;
        reason: string;
        ttlDays?: number;
        layer?: FeedbackLayer;
        sessionId?: string;
        runId?: string;
        recallTraceId?: string;
        source?: "user" | "tool" | "model";
        label?: string;
        evidenceRefs?: string[];
    }>
): void {
    if (!entries || entries.length === 0) return;
    ensureV8StoreDirs(workspace);
    const overridePath = feedbackOverridesPath(workspace);
    const recordPath = feedbackRecordsPath(workspace);
    const now = nowIso();
    for (const entry of entries) {
        const ttlMs =
            typeof entry.ttlDays === "number" ? entry.ttlDays * 24 * 60 * 60 * 1000 : null;
        const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
        const feedbackId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const layer: FeedbackLayer =
            entry.layer || (ttlMs ? "scene" : "durable");
        const record: FeedbackRecord = {
            feedbackId,
            sessionId: entry.sessionId,
            runId: entry.runId,
            recallTraceId: entry.recallTraceId,
            source: entry.source,
            label: entry.label || (entry.kind === "reinforce" ? "memory_helped" : "memory_content_error"),
            polarity: entry.kind === "reinforce" ? "positive" : "negative",
            targets: [entry.nodeId],
            scope: layer,
            evidenceRefs: entry.evidenceRefs,
            reason: entry.reason,
            createdAt: now,
        };
        const override: FeedbackOverride = {
            overrideId: `fo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            feedbackId,
            targetId: entry.nodeId,
            layer,
            operation: entry.kind,
            delta: entry.delta,
            reason: entry.reason,
            createdAt: now,
            expiresAt,
        };
        appendJsonl(recordPath, record);
        appendJsonl(overridePath, override);
        const list = feedbackByNode.get(entry.nodeId) || [];
        list.push(override);
        feedbackByNode.set(entry.nodeId, list);
    }
    feedbackLoadedAt = Date.now();
}

export function recordFeedbackRecords(
    workspace: string,
    entries: Array<{
        targets: string[];
        label: string;
        polarity: "positive" | "negative" | "neutral";
        scope?: FeedbackLayer;
        reason?: string;
        sessionId?: string;
        runId?: string;
        recallTraceId?: string;
        source?: "user" | "tool" | "model";
        evidenceRefs?: string[];
    }>
): void {
    if (!entries || entries.length === 0) return;
    ensureV8StoreDirs(workspace);
    const recordPath = feedbackRecordsPath(workspace);
    const now = nowIso();
    for (const entry of entries) {
        if (!entry.targets || entry.targets.length === 0) {
            continue;
        }
        const record: FeedbackRecord = {
            feedbackId: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId: entry.sessionId,
            runId: entry.runId,
            recallTraceId: entry.recallTraceId,
            source: entry.source,
            label: entry.label,
            polarity: entry.polarity,
            targets: Array.isArray(entry.targets) ? entry.targets : [],
            scope: entry.scope || "scene",
            evidenceRefs: entry.evidenceRefs,
            reason: entry.reason,
            createdAt: now,
        };
        appendJsonl(recordPath, record);
    }
}

export function getNodeFeedbackBias(nodeId: string): number {
    const entries = feedbackByNode.get(nodeId);
    if (!entries || entries.length === 0) return 0;
    let bias = 0;
    for (const entry of entries) {
        if (entry.operation === "clear") {
            continue;
        }
        bias += entry.delta;
    }
    return Math.max(-0.6, Math.min(0.6, bias));
}

export function findMatchingNodes(
    workspace: string,
    text: string,
    limit = 2,
    threshold = 0.25
): string[] {
    storeNodeLabels(workspace);
    if (!nodeLabelCache) return [];

    const tokens = new Set(tokenize(text));
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, entry] of nodeLabelCache.entries()) {
        const referenceTokens = new Set(
            tokenize([entry.label, ...entry.aliases].join(" "))
        );
        const score = overlapScore(tokens, referenceTokens);
        if (score >= threshold) {
            scored.push({ id, score });
        }
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((item) => item.id);
}

export function isExplicitMemoryCorrection(text: string): boolean {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return (
        /(?:记忆|回忆|回想|你刚才回忆|你回忆|你上次回忆|memory|recall).*(?:记错|不对|错了|错误|incorrect|wrong)/i.test(
            normalized
        ) ||
        /记.{0,3}(?:错|不对|错误|偏|反|混|搞错|不准)/i.test(normalized)
    );
}

export function isExplicitMemoryAffirmation(text: string): boolean {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    return (
        /(?:记忆|回忆|回想|你刚才回忆|你回忆|你上次回忆|memory|recall).*(?:没错|对的|正确|准确|没问题|correct|right|accurate)/i.test(
            normalized
        ) ||
        /记.{0,3}(?:对|正确|没错|准确|很准|没问题)/i.test(normalized)
    );
}

function normalizeOverride(raw: any): FeedbackOverride | null {
    if (!raw || typeof raw !== "object") return null;
    // New format
    if (typeof raw.targetId === "string") {
        return {
            overrideId: String(raw.overrideId || ""),
            feedbackId: raw.feedbackId ? String(raw.feedbackId) : undefined,
            targetId: raw.targetId,
            layer: (raw.layer as FeedbackLayer) || "scene",
            operation: (raw.operation as FeedbackOperation) || "reinforce",
            delta: typeof raw.delta === "number" ? raw.delta : 0,
            reason: typeof raw.reason === "string" ? raw.reason : undefined,
            createdAt: String(raw.createdAt || nowIso()),
            expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
        };
    }
    // Legacy format
    if (typeof raw.nodeId === "string") {
        const kind = raw.kind === "suppress" ? "suppress" : "reinforce";
        return {
            overrideId: String(raw.overrideId || ""),
            feedbackId: raw.feedbackId ? String(raw.feedbackId) : undefined,
            targetId: raw.nodeId,
            layer: raw.expiresAt ? "scene" : "durable",
            operation: kind,
            delta: typeof raw.delta === "number" ? raw.delta : 0,
            reason: typeof raw.reason === "string" ? raw.reason : undefined,
            createdAt: String(raw.createdAt || nowIso()),
            expiresAt: raw.expiresAt ? String(raw.expiresAt) : null,
        };
    }
    return null;
}
