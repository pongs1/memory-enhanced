import { resolveWorkspace } from "../utils.js";
import { ensureV8StoreDirs } from "./paths_v8.js";
import { loadSessionTraces } from "./adapters/session-source.js";
import { normalizeSessionMessages } from "./architecture/source-normalizer.js";
import { unitizeSourceRecords } from "./architecture/unitizer.js";
import { extractEvidenceSpans } from "./architecture/evidence.js";
import { extractMemoryItems } from "./architecture/ir-extractor.js";
import { materializeGraph } from "./architecture/graph-materializer.js";
import { writeJsonl } from "./architecture/io.js";

export interface CleanSlateBuildOptions {
    workspace?: string;
    sessionTraceDir?: string;
    maxSessionFiles?: number;
}

export function buildCleanSlateGraph(options?: CleanSlateBuildOptions) {
    const workspace = resolveWorkspace(options?.workspace);
    const store = ensureV8StoreDirs(workspace);

    const traceGroups = loadSessionTraces(workspace, {
        sessionTraceDir: options?.sessionTraceDir,
        maxFiles: options?.maxSessionFiles,
    });

    const sourceRecords = traceGroups.flatMap((group) =>
        normalizeSessionMessages(group.messages, {
            sourceRefPrefix: group.sourceRefPrefix,
        })
    );

    const units = unitizeSourceRecords(sourceRecords);
    const evidenceSpans = extractEvidenceSpans(units, sourceRecords);
    const memoryItems = extractMemoryItems(sourceRecords, units, evidenceSpans);
    const { nodes, edges } = materializeGraph(memoryItems, units, evidenceSpans);

    writeJsonl(store.sourceRecords, sourceRecords);
    writeJsonl(store.units, units);
    writeJsonl(store.evidenceSpans, evidenceSpans);
    writeJsonl(store.memoryItems, memoryItems);
    writeJsonl(store.graphNodes, nodes);
    writeJsonl(store.graphEdges, edges);

    return {
        sourceRecords,
        units,
        evidenceSpans,
        memoryItems,
        nodes,
        edges,
    };
}
