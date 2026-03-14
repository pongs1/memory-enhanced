import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../utils.js";

export type OperationKind =
    | "read_artifact"
    | "web_lookup"
    | "artifact_write"
    | "content_extraction"
    | "filesystem_probe"
    | "process_control"
    | "legacy_memory_write"
    | "command_execution"
    | "tool_operation";

export type OperationPromotion = "metadata_only" | "evidence_only" | "llm_ir";

export interface ToolCleaningHints {
    artifactKeys?: string[];
    queryKeys?: string[];
    urlKeys?: string[];
    payloadKeys?: string[];
    commandKeys?: string[];
    metadataKeys?: string[];
}

export interface ToolResultHints {
    textKeys?: string[];
    metadataKeys?: string[];
}

export interface ToolCleaningProfile {
    toolName: string;
    fingerprint?: string | null;
    source?: string | null;
    pluginId?: string | null;
    description?: string;
    inputHints?: ToolCleaningHints;
    resultHints?: ToolResultHints;
    cleaningMode?: string;
    kind?: OperationKind;
    promotion?: OperationPromotion;
    maxChars?: number;
    maxLines?: number;
    status?: string;
}

interface RawToolCleaningHints {
    artifact_keys?: unknown;
    query_keys?: unknown;
    url_keys?: unknown;
    payload_keys?: unknown;
    command_keys?: unknown;
    metadata_keys?: unknown;
}

interface RawToolResultHints {
    text_keys?: unknown;
    metadata_keys?: unknown;
}

interface RawToolCleaningProfile {
    tool_name?: unknown;
    fingerprint?: unknown;
    source?: unknown;
    plugin_id?: unknown;
    description?: unknown;
    input_hints?: RawToolCleaningHints;
    result_hints?: RawToolResultHints;
    cleaning_mode?: unknown;
    promotion?: unknown;
    max_chars?: unknown;
    max_lines?: unknown;
    status?: unknown;
}

interface RawToolCleaningProfileFile {
    profiles?: unknown;
}

const KNOWN_OPERATION_KINDS = new Set<OperationKind>([
    "read_artifact",
    "web_lookup",
    "artifact_write",
    "content_extraction",
    "filesystem_probe",
    "process_control",
    "legacy_memory_write",
    "command_execution",
    "tool_operation",
]);

const KNOWN_PROMOTIONS = new Set<OperationPromotion>([
    "metadata_only",
    "evidence_only",
    "llm_ir",
]);

function baselineProfilesPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../schema/v8-core-tool-cleaning-profiles.json");
}

export function runtimeToolCleaningProfilesPath(workspace: string): string {
    return path.join(
        workspace,
        ".memory",
        "raw",
        "observations",
        "tool_cleaning_profiles.json"
    );
}

function toStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const output = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    return output.length ? output : undefined;
}

function normalizeHints(raw?: RawToolCleaningHints): ToolCleaningHints | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const normalized: ToolCleaningHints = {
        artifactKeys: toStringArray(raw.artifact_keys),
        queryKeys: toStringArray(raw.query_keys),
        urlKeys: toStringArray(raw.url_keys),
        payloadKeys: toStringArray(raw.payload_keys),
        commandKeys: toStringArray(raw.command_keys),
        metadataKeys: toStringArray(raw.metadata_keys),
    };
    if (Object.values(normalized).some((value) => Array.isArray(value) && value.length > 0)) {
        return normalized;
    }
    return undefined;
}

function normalizeResultHints(
    raw?: RawToolResultHints
): ToolResultHints | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const normalized: ToolResultHints = {
        textKeys: toStringArray(raw.text_keys),
        metadataKeys: toStringArray(raw.metadata_keys),
    };
    if (Object.values(normalized).some((value) => Array.isArray(value) && value.length > 0)) {
        return normalized;
    }
    return undefined;
}

function normalizeProfile(raw: RawToolCleaningProfile): ToolCleaningProfile | null {
    const toolName =
        typeof raw.tool_name === "string" ? raw.tool_name.trim().toLowerCase() : "";
    if (!toolName) return null;
    const cleaningMode =
        typeof raw.cleaning_mode === "string" ? raw.cleaning_mode.trim() : "";
    const promotion =
        typeof raw.promotion === "string" &&
        KNOWN_PROMOTIONS.has(raw.promotion as OperationPromotion)
            ? (raw.promotion as OperationPromotion)
            : undefined;
    const kind = KNOWN_OPERATION_KINDS.has(cleaningMode as OperationKind)
        ? (cleaningMode as OperationKind)
        : undefined;
    const maxChars =
        typeof raw.max_chars === "number" && Number.isFinite(raw.max_chars)
            ? raw.max_chars
            : undefined;
    const maxLines =
        typeof raw.max_lines === "number" && Number.isFinite(raw.max_lines)
            ? raw.max_lines
            : undefined;

    return {
        toolName,
        fingerprint:
            typeof raw.fingerprint === "string" ? raw.fingerprint : null,
        source: typeof raw.source === "string" ? raw.source : null,
        pluginId: typeof raw.plugin_id === "string" ? raw.plugin_id : null,
        description: typeof raw.description === "string" ? raw.description : undefined,
        inputHints: normalizeHints(raw.input_hints),
        resultHints: normalizeResultHints(raw.result_hints),
        cleaningMode: cleaningMode || undefined,
        kind,
        promotion,
        maxChars,
        maxLines,
        status: typeof raw.status === "string" ? raw.status : undefined,
    };
}

function loadProfilesFromFile(filePath: string): ToolCleaningProfile[] {
    const data = readJson<RawToolCleaningProfileFile | RawToolCleaningProfile[]>(
        filePath,
        { profiles: [] }
    );
    const rawProfiles = Array.isArray(data)
        ? data
        : Array.isArray(data.profiles)
          ? (data.profiles as RawToolCleaningProfile[])
          : [];
    return rawProfiles
        .map((raw) => normalizeProfile(raw))
        .filter((profile): profile is ToolCleaningProfile => Boolean(profile));
}

function mergeStringArrays(
    left?: string[],
    right?: string[]
): string[] | undefined {
    const merged = [...(left || []), ...(right || [])]
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!merged.length) return undefined;
    return [...new Set(merged)];
}

function mergeHints(
    left?: ToolCleaningHints,
    right?: ToolCleaningHints
): ToolCleaningHints | undefined {
    const merged: ToolCleaningHints = {
        artifactKeys: mergeStringArrays(left?.artifactKeys, right?.artifactKeys),
        queryKeys: mergeStringArrays(left?.queryKeys, right?.queryKeys),
        urlKeys: mergeStringArrays(left?.urlKeys, right?.urlKeys),
        payloadKeys: mergeStringArrays(left?.payloadKeys, right?.payloadKeys),
        commandKeys: mergeStringArrays(left?.commandKeys, right?.commandKeys),
        metadataKeys: mergeStringArrays(left?.metadataKeys, right?.metadataKeys),
    };
    if (Object.values(merged).some((value) => Array.isArray(value) && value.length > 0)) {
        return merged;
    }
    return undefined;
}

function mergeResultHints(
    left?: ToolResultHints,
    right?: ToolResultHints
): ToolResultHints | undefined {
    const merged: ToolResultHints = {
        textKeys: mergeStringArrays(left?.textKeys, right?.textKeys),
        metadataKeys: mergeStringArrays(left?.metadataKeys, right?.metadataKeys),
    };
    if (Object.values(merged).some((value) => Array.isArray(value) && value.length > 0)) {
        return merged;
    }
    return undefined;
}

function mergeProfiles(
    left: ToolCleaningProfile,
    right: ToolCleaningProfile
): ToolCleaningProfile {
    return {
        ...left,
        ...right,
        toolName: right.toolName || left.toolName,
        inputHints: mergeHints(left.inputHints, right.inputHints),
        resultHints: mergeResultHints(left.resultHints, right.resultHints),
        kind: right.kind ?? left.kind,
        promotion: right.promotion ?? left.promotion,
        maxChars: right.maxChars ?? left.maxChars,
        maxLines: right.maxLines ?? left.maxLines,
        cleaningMode: right.cleaningMode ?? left.cleaningMode,
    };
}

export function loadResolvedToolCleaningProfiles(
    workspace?: string
): Map<string, ToolCleaningProfile> {
    const merged = new Map<string, ToolCleaningProfile>();

    for (const profile of loadProfilesFromFile(baselineProfilesPath())) {
        merged.set(profile.toolName, profile);
    }

    if (workspace) {
        const runtimePath = runtimeToolCleaningProfilesPath(workspace);
        for (const profile of loadProfilesFromFile(runtimePath)) {
            const existing = merged.get(profile.toolName);
            merged.set(
                profile.toolName,
                existing ? mergeProfiles(existing, profile) : profile
            );
        }
    }

    return merged;
}

export function getToolCleaningProfile(
    profiles: Map<string, ToolCleaningProfile> | undefined,
    toolName: string
): ToolCleaningProfile | undefined {
    if (!profiles) return undefined;
    const normalized = toolName.trim().toLowerCase();
    if (!normalized) return undefined;
    return profiles.get(normalized);
}
