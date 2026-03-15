import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, readJson } from "../../utils.js";
import type { ToolCleaningProfile } from "./tool-cleaning-profiles.js";

export interface ToolCatalogTool {
    id: string;
    label?: string;
    description?: string;
    source?: string;
    pluginId?: string;
    optional?: boolean;
    defaultProfiles?: string[];
    groupId?: string;
    groupLabel?: string;
}

interface ToolCatalogGroup {
    id?: string;
    label?: string;
    source?: string;
    pluginId?: string;
    tools?: unknown;
}

interface ToolCatalogSnapshot {
    agentId?: string;
    groups?: ToolCatalogGroup[];
    tools?: unknown;
}

export interface ToolCatalogCheckResult {
    status: "ok" | "missing_catalog" | "mismatch" | "skipped";
    toolCount: number;
    ruleCount: number;
    missingRules: ToolCatalogTool[];
    extraRules: string[];
    promptPath?: string;
    catalogPath?: string;
}

const CATALOG_FILENAME = "tool_catalog_snapshot.json";
const REVIEW_FILENAME = "tool_cleaning_profile_review.md";

export function checkToolCatalogAgainstRules(params: {
    workspace: string;
    profiles: Map<string, ToolCleaningProfile>;
}): ToolCatalogCheckResult {
    const catalogPath = path.join(
        params.workspace,
        ".memory",
        "raw",
        "observations",
        CATALOG_FILENAME
    );
    if (!fs.existsSync(catalogPath)) {
        return {
            status: "missing_catalog",
            toolCount: 0,
            ruleCount: params.profiles.size,
            missingRules: [],
            extraRules: [],
            catalogPath,
        };
    }

    const snapshot = readJson<ToolCatalogSnapshot>(catalogPath, {
        groups: [],
    });
    const tools = extractTools(snapshot);
    const toolIds = new Set(tools.map((tool) => tool.id));
    const ruleIds = new Set(Array.from(params.profiles.keys()));
    const missingRules = tools.filter((tool) => !ruleIds.has(tool.id));
    const extraRules = Array.from(ruleIds).filter((id) => !toolIds.has(id));

    if (missingRules.length === 0 && extraRules.length === 0) {
        return {
            status: "ok",
            toolCount: tools.length,
            ruleCount: ruleIds.size,
            missingRules: [],
            extraRules: [],
            catalogPath,
        };
    }

    const promptPath = writeReviewPrompt(params.workspace, {
        catalogPath,
        tools,
        missingRules,
        extraRules,
    });

    return {
        status: "mismatch",
        toolCount: tools.length,
        ruleCount: ruleIds.size,
        missingRules,
        extraRules,
        promptPath,
        catalogPath,
    };
}

function extractTools(snapshot: ToolCatalogSnapshot): ToolCatalogTool[] {
    const tools: ToolCatalogTool[] = [];
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    for (const group of groups) {
        const toolList = Array.isArray(group.tools) ? group.tools : [];
        for (const entry of toolList) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id.trim() : "";
            if (!id) continue;
            tools.push({
                id,
                label: typeof record.label === "string" ? record.label : undefined,
                description:
                    typeof record.description === "string"
                        ? record.description
                        : undefined,
                source: typeof record.source === "string" ? record.source : undefined,
                pluginId:
                    typeof record.pluginId === "string" ? record.pluginId : undefined,
                optional:
                    typeof record.optional === "boolean"
                        ? record.optional
                        : undefined,
                defaultProfiles: Array.isArray(record.defaultProfiles)
                    ? record.defaultProfiles.filter(
                          (profile) => typeof profile === "string"
                      )
                    : undefined,
                groupId: typeof group.id === "string" ? group.id : undefined,
                groupLabel:
                    typeof group.label === "string" ? group.label : undefined,
            });
        }
    }
    return tools;
}

function writeReviewPrompt(
    workspace: string,
    input: {
        catalogPath: string;
        tools: ToolCatalogTool[];
        missingRules: ToolCatalogTool[];
        extraRules: string[];
    }
): string {
    const outputDir = path.join(workspace, ".memory", "raw", "observations");
    ensureDir(outputDir);
    const filePath = path.join(outputDir, REVIEW_FILENAME);

    const lines: string[] = [];
    lines.push("# Tool Cleaning Profile Review");
    lines.push("");
    lines.push("A mismatch was detected between the tool catalog snapshot and cleaning rules.");
    lines.push("");
    lines.push(`Catalog snapshot: \`${input.catalogPath}\``);
    lines.push("Rule file: `.memory/raw/observations/tool_cleaning_profiles.json`");
    lines.push("Baseline: `schema/v8-core-tool-cleaning-profiles.json`");
    lines.push("");
    lines.push("## Summary");
    lines.push(`- tools in catalog: ${input.tools.length}`);
    lines.push(`- missing rule entries: ${input.missingRules.length}`);
    lines.push(`- extra rule entries: ${input.extraRules.length}`);
    lines.push("");
    lines.push("## Task");
    lines.push(
        "For each missing tool below, inspect the tool implementation and describe:"
    );
    lines.push("- input parameters (paths, urls, payload fields)");
    lines.push("- result shape (text fields, metadata fields)");
    lines.push("- recommended cleaning_mode and promotion");
    lines.push("- safe max_chars / max_lines defaults");
    lines.push("");
    lines.push(
        "Output Markdown with one block per tool, using this exact field order:"
    );
    lines.push("");
    lines.push("### Tool");
    lines.push("tool_name: <id>");
    lines.push("description: <short description>");
    lines.push("input_hints:");
    lines.push("  artifact_keys: ...");
    lines.push("  query_keys: ...");
    lines.push("  url_keys: ...");
    lines.push("  payload_keys: ...");
    lines.push("  command_keys: ...");
    lines.push("  metadata_keys: ...");
    lines.push("result_hints:");
    lines.push("  text_keys: ...");
    lines.push("  metadata_keys: ...");
    lines.push("cleaning_mode: read_artifact|web_lookup|artifact_write|content_extraction|filesystem_probe|process_control|command_execution|tool_operation");
    lines.push("promotion: llm_ir|evidence_only|metadata_only");
    lines.push("max_chars: <number>");
    lines.push("max_lines: <number>");
    lines.push("status: active|baseline|deprecated");
    lines.push("");
    lines.push("Use `status: deprecated` for tools that are no longer in the catalog.");
    lines.push("");
    if (input.missingRules.length > 0) {
        lines.push("## Missing tools");
        for (const tool of input.missingRules) {
            lines.push(
                `- ${tool.id} | ${tool.label || "tool"} | ${tool.source || "unknown"}`
            );
            if (tool.description) {
                lines.push(`  description: ${tool.description}`);
            }
            if (tool.groupId || tool.groupLabel) {
                lines.push(
                    `  group: ${tool.groupId || "unknown"}${
                        tool.groupLabel ? ` (${tool.groupLabel})` : ""
                    }`
                );
            }
            if (tool.pluginId) {
                lines.push(`  plugin_id: ${tool.pluginId}`);
            }
            if (tool.defaultProfiles && tool.defaultProfiles.length > 0) {
                lines.push(
                    `  default_profiles: ${tool.defaultProfiles.join(", ")}`
                );
            }
        }
        lines.push("");
    }
    if (input.extraRules.length > 0) {
        lines.push("## Extra rules (not in catalog)");
        for (const rule of input.extraRules) {
            lines.push(`- ${rule}`);
        }
        lines.push("");
    }

    fs.writeFileSync(filePath, lines.join("\n").trim() + "\n", "utf-8");
    return filePath;
}
