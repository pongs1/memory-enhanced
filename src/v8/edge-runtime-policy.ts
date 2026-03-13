import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import type { V8EdgeRuntimePolicyEntry } from "./types_v8.js";

interface EdgeRuntimePolicyFile {
    entries: V8EdgeRuntimePolicyEntry[];
}

const schemaPath = () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../schema/v8-edge-runtime-policy.json");
};

export function loadEdgeRuntimePolicy(
    overridePath?: string
): V8EdgeRuntimePolicyEntry[] {
    const filePath = overridePath || schemaPath();
    const data = readJson<EdgeRuntimePolicyFile>(filePath, { entries: [] });
    return Array.isArray(data.entries) ? data.entries : [];
}
