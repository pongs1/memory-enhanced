import * as fs from "node:fs";
import * as path from "node:path";
import {
    ensureDir,
    nowISO,
    paths,
    readEvents,
    readFileOr,
    resolveWorkspace,
    type MemoryEvent,
} from "../utils.js";
import { postJson } from "../http-client.js";
import { sanitizeAnnotationBundleDraft } from "./annotation.js";
import { buildDraftFromStageMarkdown } from "./annotation-stage-parser.js";
import {
    buildRelationScoringPrompt,
    buildSceneReconstructionPrompt,
    type V8AnnotationContextBlock,
} from "./annotation-prompt.js";
import { graphPaths } from "./paths.js";
import type {
    V8MemoryBundle,
    V8OfflineAnnotationRecord,
    V8OfflineAnnotationRunInput,
    V8OfflineAnnotationRunOutput,
} from "./types.js";

interface AnnotationApiConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
}

function sanitizeText(text: string, maxChars = 16000): string {
    return (text || "").replace(/\r/g, "").trim().slice(0, maxChars);
}

function readJsonlRecords<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) {
            return [];
        }
        return content
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function writeJsonlRecords<T>(filePath: string, records: T[]): void {
    ensureDir(path.dirname(filePath));
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(filePath, content ? content + "\n" : "", "utf-8");
}

function resolveAnnotationApiConfig(): AnnotationApiConfig | null {
    const apiKey = process.env.OPENAI_API_KEY || process.env.SILICONFLOW_API_KEY || "";
    if (!apiKey) {
        return null;
    }

    return {
        apiKey,
        baseUrl: (process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, ""),
        model:
            process.env.MEMORY_ANNOTATION_MODEL ||
            process.env.OPENAI_MODEL ||
            "MiniMaxAI/MiniMax-M2.5",
    };
}

function extractMessageText(payload: any): string {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .join("\n")
            .trim();
    }
    return "";
}

async function callChat(
    config: AnnotationApiConfig,
    messages: Array<{ role: "system" | "user"; content: string }>
): Promise<string> {
    const payload = await postJson({
        url: `${config.baseUrl}/chat/completions`,
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: {
            model: config.model,
            messages,
            temperature: 0.2,
        },
    });
    return extractMessageText(payload);
}

function collectJsonlFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs
        .readdirSync(dirPath)
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .map((file) => path.join(dirPath, file));
}

function findEventById(workspace: string, eventId: string): MemoryEvent | null {
    const p = paths(workspace);
    for (const root of [p.eventsDir, p.archiveDir]) {
        const files = collectJsonlFiles(root);
        for (const filePath of files) {
            const found = readEvents(filePath).find((event) => event.id === eventId);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function deriveEventDayKey(event: MemoryEvent): string | null {
    if (event.timestamp && /^\d{4}-\d{2}-\d{2}/.test(event.timestamp)) {
        return event.timestamp.slice(0, 10);
    }
    const idMatch = event.id.match(/^evt_(\d{4})(\d{2})(\d{2})_/);
    if (!idMatch) return null;
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
}

function extractDailyLogFragmentByEventId(markdown: string, eventId: string): string {
    const normalized = (markdown || "").replace(/\r/g, "").trim();
    if (!normalized) return "";
    const marker = `ID: ${eventId}`;
    const sections = normalized
        .split(/\n(?=###\s)/)
        .map((section) => section.trim())
        .filter(Boolean);
    const matched = sections.find((section) => section.includes(marker));
    return matched ? sanitizeText(matched, 3600) : "";
}

function formatEventSourceText(event: MemoryEvent): string {
    const lines = [
        `Event ID: ${event.id}`,
        `Type: ${event.type}`,
        `Timestamp: ${event.timestamp}`,
        `Importance: ${event.importance}`,
    ];

    if (event.tags.length > 0) {
        lines.push(`Tags: ${event.tags.join(", ")}`);
    }
    if (event.associations.length > 0) {
        lines.push(`Associations: ${event.associations.join(", ")}`);
    }
    lines.push("", event.content);
    return lines.join("\n");
}

function formatEventSourceTextWithDailyLog(workspace: string, event: MemoryEvent): string {
    const dayKey = deriveEventDayKey(event);
    if (!dayKey) {
        return formatEventSourceText(event);
    }
    const dailyLogPath = paths(workspace).dailyLog(dayKey);
    const dailyLogFragment = extractDailyLogFragmentByEventId(readFileOr(dailyLogPath), event.id);
    if (!dailyLogFragment) {
        return formatEventSourceText(event);
    }
    const lines = [
        `Event ID: ${event.id}`,
        `Type: ${event.type}`,
        `Timestamp: ${event.timestamp}`,
        `Importance: ${event.importance}`,
        `Daily Log Ref: memory/${dayKey}.md`,
        "",
        dailyLogFragment,
    ];
    return lines.join("\n");
}

function loadBundleSourceText(workspace: string, bundle: V8MemoryBundle): string {
    if (bundle.sourceType === "event") {
        const event = findEventById(workspace, bundle.sourceRef);
        return event ? formatEventSourceTextWithDailyLog(workspace, event) : "";
    }

    const filePath = path.join(workspace, bundle.sourceRef);
    return readFileOr(filePath);
}

function buildContextBlocks(bundle: V8MemoryBundle): V8AnnotationContextBlock[] {
    const blocks: V8AnnotationContextBlock[] = [
        {
            label: "Bundle Metadata",
            text: [
                `title: ${bundle.title}`,
                `sourceType: ${bundle.sourceType}`,
                `canonicalRef: ${bundle.canonicalRef}`,
                `summaryRef: ${bundle.summaryRef}`,
                `dayKey: ${bundle.dayKey || "(none)"}`,
                `episodeKey: ${bundle.episodeKey || "(none)"}`,
            ].join("\n"),
        },
    ];

    return blocks;
}

function rankBundlesForAnnotation(bundles: V8MemoryBundle[], maxBundles: number): V8MemoryBundle[] {
    return [...bundles]
        .filter((bundle) => bundle.sourceType === "event" || bundle.sourceType === "knowledge_md" || bundle.sourceType === "skill_md")
        .sort((a, b) => {
            const aScore = (a.sourceType === "event" ? 3 : 1) + (a.encodingContext ? 1 : 0);
            const bScore = (b.sourceType === "event" ? 3 : 1) + (b.encodingContext ? 1 : 0);
            if (aScore !== bScore) {
                return bScore - aScore;
            }
            return (b.updatedAt || "").localeCompare(a.updatedAt || "");
        })
        .slice(0, maxBundles);
}

function normalizeSourceRefFilter(values: string[] | undefined): Set<string> | null {
    const cleaned = (values || [])
        .map((value) => sanitizeText(value, 220))
        .filter(Boolean);
    return cleaned.length > 0 ? new Set(cleaned) : null;
}

async function annotateBundle(
    workspace: string,
    bundle: V8MemoryBundle,
    config: AnnotationApiConfig
): Promise<V8OfflineAnnotationRecord | null> {
    const sourceText = sanitizeText(loadBundleSourceText(workspace, bundle), 16000);
    if (!sourceText) {
        return null;
    }

    const promptInput = {
        sourceType: bundle.sourceType,
        sourceRef: bundle.sourceRef,
        sourceText,
        kindHint: bundle.kind,
        titleHint: bundle.title,
        canonicalRef: bundle.canonicalRef,
        summaryRef: bundle.summaryRef,
        dayKey: bundle.dayKey,
        episodeKeyHint: bundle.episodeKey,
        encodingContext: bundle.encodingContext,
        targetNodeBudget: bundle.sourceType === "event" ? 5 : 4,
        contextBlocks: buildContextBlocks(bundle),
    } as const;

    const scenePrompt = buildSceneReconstructionPrompt(promptInput);
    const stage1SceneDraft = await callChat(config, [
        { role: "system", content: scenePrompt.system },
        { role: "user", content: scenePrompt.user },
    ]);

    if (!stage1SceneDraft) {
        return null;
    }

    const relationPrompt = buildRelationScoringPrompt({
        ...promptInput,
        sceneDraft: stage1SceneDraft,
    });
    const stage2RelationDraft = await callChat(config, [
        { role: "system", content: relationPrompt.system },
        { role: "user", content: relationPrompt.user },
    ]);

    if (!stage2RelationDraft) {
        return null;
    }

    const draft = buildDraftFromStageMarkdown({
        sourceType: bundle.sourceType,
        sourceRef: bundle.sourceRef,
        kindHint: bundle.kind,
        titleHint: bundle.title,
        canonicalRef: bundle.canonicalRef,
        summaryRef: bundle.summaryRef,
        dayKey: bundle.dayKey,
        episodeKey: bundle.episodeKey,
        encodingContext: bundle.encodingContext,
        sceneDraft: stage1SceneDraft,
        relationDraft: stage2RelationDraft,
    });

    return {
        bundleId: bundle.bundleId,
        sourceType: bundle.sourceType,
        sourceRef: bundle.sourceRef,
        title: bundle.title,
        stage1SceneDraft,
        stage2RelationDraft,
        sanitizedDraft: sanitizeAnnotationBundleDraft(draft),
        model: config.model,
        createdAt: nowISO(),
        bundleUpdatedAt: bundle.updatedAt,
    };
}

export async function runOfflineBundleAnnotation(
    input: V8OfflineAnnotationRunInput
): Promise<V8OfflineAnnotationRunOutput> {
    const workspace = resolveWorkspace(input.workspace);
    const config = resolveAnnotationApiConfig();
    if (!config) {
        return {
            records: [],
            skipped: input.bundles.length,
            model: null,
        };
    }

    const gp = graphPaths(workspace);
    const previous = readJsonlRecords<V8OfflineAnnotationRecord>(gp.offlineAnnotationDrafts);
    const previousByBundle = new Map(previous.map((record) => [record.bundleId, record]));
    const maxBundles = Math.max(
        1,
        Number(process.env.MEMORY_ANNOTATION_MAX_BUNDLES || input.maxBundles || 8)
    );
    const force =
        input.force === true ||
        /^(1|true|yes)$/i.test(process.env.MEMORY_ANNOTATION_FORCE || "");
    const sourceRefFilter = normalizeSourceRefFilter(
        input.sourceRefs && input.sourceRefs.length > 0
            ? input.sourceRefs
            : (process.env.MEMORY_ANNOTATION_SOURCE_REFS || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
    );

    const candidateBundles = sourceRefFilter
        ? input.bundles.filter((bundle) => sourceRefFilter.has(bundle.sourceRef))
        : input.bundles;
    const selected = rankBundlesForAnnotation(candidateBundles, maxBundles);
    const nextRecords = [...previous];
    const newRecords: V8OfflineAnnotationRecord[] = [];
    let skipped = Math.max(0, candidateBundles.length - selected.length);

    for (const bundle of selected) {
        const previousRecord = previousByBundle.get(bundle.bundleId);
        if (!force && previousRecord && previousRecord.bundleUpdatedAt === bundle.updatedAt) {
            skipped += 1;
            continue;
        }

        try {
            const record = await annotateBundle(workspace, bundle, config);
            if (!record) {
                skipped += 1;
                continue;
            }

            const existingIndex = nextRecords.findIndex((item) => item.bundleId === bundle.bundleId);
            if (existingIndex >= 0) {
                nextRecords.splice(existingIndex, 1, record);
            } else {
                nextRecords.push(record);
            }
            newRecords.push(record);
        } catch (error) {
            console.warn(`[Memory V8] Offline annotation failed for ${bundle.bundleId}: ${String(error)}`);
            skipped += 1;
        }
    }

    if (newRecords.length > 0) {
        writeJsonlRecords(gp.offlineAnnotationDrafts, nextRecords);
    }

    return {
        records: newRecords,
        skipped,
        model: config.model,
    };
}
