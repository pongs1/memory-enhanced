import * as fs from "node:fs";
import { nowISO, readJson, writeJson } from "../utils.js";
import { ensureGraphDirs, graphPaths } from "./paths.js";
import type { V8GraphManifest } from "./types.js";

export const V8_GRAPH_SCHEMA_VERSION = 1;
export const DEFAULT_V8_COMPILER_VERSION = "v8-draft-1";
export const DEFAULT_V8_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

function clampIsoString(value: unknown, fallback: string | null): string | null {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeManifest(
    value: Partial<V8GraphManifest> | null | undefined,
    fallbackCreatedAt?: string
): V8GraphManifest {
    const now = nowISO();
    const createdAt =
        clampIsoString(value?.createdAt, fallbackCreatedAt || now) || now;

    return {
        schemaVersion:
            typeof value?.schemaVersion === "number" &&
                Number.isFinite(value.schemaVersion) &&
                value.schemaVersion > 0
                ? Math.trunc(value.schemaVersion)
                : V8_GRAPH_SCHEMA_VERSION,
        compilerVersion:
            typeof value?.compilerVersion === "string" && value.compilerVersion.trim()
                ? value.compilerVersion.trim()
                : DEFAULT_V8_COMPILER_VERSION,
        embeddingModel:
            typeof value?.embeddingModel === "string" && value.embeddingModel.trim()
                ? value.embeddingModel.trim()
                : DEFAULT_V8_EMBEDDING_MODEL,
        storageFormat: "jsonl",
        createdAt,
        updatedAt: clampIsoString(value?.updatedAt, now) || now,
        lastFullRebuildAt: clampIsoString(value?.lastFullRebuildAt, null),
        legacyGraphMigrated: Boolean(value?.legacyGraphMigrated),
    };
}

export function createDefaultGraphManifest(
    overrides: Partial<V8GraphManifest> = {}
): V8GraphManifest {
    return normalizeManifest(overrides);
}

export function readGraphManifest(workspace: string): V8GraphManifest | null {
    const gp = graphPaths(workspace);
    if (!fs.existsSync(gp.manifest)) {
        return null;
    }
    const raw = readJson<Partial<V8GraphManifest> | null>(gp.manifest, null);
    return normalizeManifest(raw);
}

export function writeGraphManifest(
    workspace: string,
    manifest: Partial<V8GraphManifest>
): V8GraphManifest {
    const gp = ensureGraphDirs(workspace);
    const previous = readGraphManifest(workspace);
    const normalized = normalizeManifest(
        {
            ...previous,
            ...manifest,
            updatedAt: nowISO(),
        },
        previous?.createdAt
    );
    writeJson(gp.manifest, normalized);
    return normalized;
}

export function ensureGraphManifest(
    workspace: string,
    overrides: Partial<V8GraphManifest> = {}
): V8GraphManifest {
    const existing = readGraphManifest(workspace);
    if (existing) {
        return existing;
    }
    return writeGraphManifest(workspace, overrides);
}
