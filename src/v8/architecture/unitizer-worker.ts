import { parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import type { V8NarrativeRecord } from "../types_v8.js";
import { unitizeNarrativeRecords, type UnitizerConfig } from "./unitizer.js";

interface WorkerNarrativeInput {
    id: string;
    sourceRef: string;
    language: V8NarrativeRecord["language"];
    metadata: V8NarrativeRecord["metadata"];
}

interface WorkerPayload {
    records: WorkerNarrativeInput[];
    config?: UnitizerConfig;
}

const payload = workerData as WorkerPayload | undefined;
const records = payload?.records ?? [];
const config = payload?.config;

const narrativeRecords: V8NarrativeRecord[] = records.map((record) => {
    const text = fs.readFileSync(record.sourceRef, "utf-8");
    return {
        id: record.id,
        sourceClass: "raw",
        sourceType: "session_narrative",
        sourceRef: record.sourceRef,
        speaker: null,
        timestamp: null,
        rawText: text,
        cleanText: text,
        cleanMap: [],
        language: record.language ?? "unknown",
        metadata: record.metadata ?? {},
    } satisfies V8NarrativeRecord;
});

const units = unitizeNarrativeRecords(narrativeRecords, config);
parentPort?.postMessage({ units });
