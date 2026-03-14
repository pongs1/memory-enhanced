import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../utils.js";
import { v8StorePaths } from "./paths_v8.js";
import type { V8PackCacheRecord } from "./types_v8.js";

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

function normalizePackType(value?: string): V8PackCacheRecord["packType"] | null {
    if (value === "summary" || value === "state") return value;
    return null;
}

function normalizeRetention(
    value?: string
): V8PackCacheRecord["retentionPolicy"] {
    return value === "pinned" ? "pinned" : "default_7d";
}

function normalizeRecord(raw: any): V8PackCacheRecord | null {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || !raw.id) return null;
    const packType = normalizePackType(raw.packType);
    if (!packType) return null;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) return null;
    const createdAt =
        typeof raw.createdAt === "string" && raw.createdAt
            ? raw.createdAt
            : new Date().toISOString();
    const lastUsedAt =
        typeof raw.lastUsedAt === "string" && raw.lastUsedAt
            ? raw.lastUsedAt
            : createdAt;
    return {
        id: raw.id,
        packType,
        fingerprint:
            typeof raw.fingerprint === "string" && raw.fingerprint
                ? raw.fingerprint
                : raw.id,
        text,
        sourceItemIds: Array.isArray(raw.sourceItemIds)
            ? raw.sourceItemIds.filter((id: any) => typeof id === "string" && id)
            : [],
        evidenceSpanIds: Array.isArray(raw.evidenceSpanIds)
            ? raw.evidenceSpanIds.filter((id: any) => typeof id === "string" && id)
            : [],
        strengthScore: typeof raw.strengthScore === "number" ? raw.strengthScore : 0.4,
        createdAt,
        lastUsedAt,
        expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
        retentionPolicy: normalizeRetention(raw.retentionPolicy),
        pinReason:
            raw.pinReason === "user" || raw.pinReason === "llm" || raw.pinReason === "system"
                ? raw.pinReason
                : undefined,
    };
}

export function isPackCacheExpired(record: V8PackCacheRecord): boolean {
    if (record.retentionPolicy === "pinned") return false;
    if (!record.expiresAt) return false;
    const ts = Date.parse(record.expiresAt);
    if (Number.isNaN(ts)) return false;
    return Date.now() > ts;
}

function getRecordTimestamp(record: V8PackCacheRecord): number {
    const ts = Date.parse(record.lastUsedAt || record.createdAt);
    if (!Number.isNaN(ts)) return ts;
    return 0;
}

export function loadPackCache(workspace: string): Map<string, V8PackCacheRecord> {
    const store = v8StorePaths(workspace);
    if (!fs.existsSync(store.packCache)) return new Map();
    const map = new Map<string, V8PackCacheRecord>();
    for (const raw of readJsonl<any>(store.packCache)) {
        const record = normalizeRecord(raw);
        if (!record) continue;
        if (isPackCacheExpired(record)) continue;
        const existing = map.get(record.id);
        if (!existing || getRecordTimestamp(record) >= getRecordTimestamp(existing)) {
            map.set(record.id, record);
        }
    }
    return map;
}

export function appendPackCacheRecord(
    workspace: string,
    record: V8PackCacheRecord
): void {
    const store = v8StorePaths(workspace);
    appendJsonl(store.packCache, record);
}
