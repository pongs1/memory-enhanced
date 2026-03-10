import { Type, type Static } from "@sinclair/typebox";
import { nowISO, resolveWorkspace } from "../utils.js";
import {
    clearPendingSessionRecalls,
    getPendingSessionRecalls,
    persistRecallFeedback,
    resolveBundleNodeIds,
} from "../v8/feedback.js";

export const MemoryFeedbackParams = Type.Object({
    outcome: Type.Union([
        Type.Literal("accepted"),
        Type.Literal("ignored"),
        Type.Literal("not_reached"),
        Type.Literal("misapplied"),
        Type.Literal("contradicted"),
        Type.Literal("superseded"),
        Type.Literal("harmful"),
    ], {
        description: "How the recalled memory actually performed in execution.",
    }),
    target: Type.Optional(
        Type.Union([
            Type.Literal("latest_session_recalls"),
            Type.Literal("bundle_ids"),
        ], {
            default: "latest_session_recalls",
            description: "Use the most recent V8 recalls from this session, or provide explicit bundle IDs.",
        })
    ),
    bundle_ids: Type.Optional(
        Type.Array(Type.String(), {
            description: "Explicit V8 bundle IDs to score, e.g. mb_evt_20260310_028",
        })
    ),
    reason: Type.Optional(
        Type.String({
            description: "Optional short note explaining why the recall was accepted, wrong, stale, or harmful.",
        })
    ),
});

export type MemoryFeedbackInput = Static<typeof MemoryFeedbackParams>;

export async function executeMemoryFeedback(
    _toolCallId: string,
    params: MemoryFeedbackInput,
    ctx?: { workspaceDir?: string; sessionId?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const sessionId = ctx?.sessionId || "default";
    const targetMode = params.target ?? "latest_session_recalls";

    let bundleTargets: Array<{ bundleId: string; nodeIds: string[] }> = [];
    if (targetMode === "bundle_ids" || (params.bundle_ids && params.bundle_ids.length > 0)) {
        const uniqueBundleIds = [...new Set(params.bundle_ids || [])];
        bundleTargets = resolveBundleNodeIds(workspace, uniqueBundleIds);
    } else {
        const pending = getPendingSessionRecalls(sessionId);
        bundleTargets = pending.map((item) => ({
            bundleId: item.bundleId,
            nodeIds: item.nodeIds,
        }));
    }

    if (bundleTargets.length === 0) {
        return {
            content: [{
                type: "text",
                text: "No V8 recall targets found. Either no recent session recalls are pending, or the provided bundle IDs do not exist in the current graph.",
            }],
        };
    }

    const observedAt = nowISO();
    const feedbacks = bundleTargets.map((target) => ({
        bundleId: target.bundleId,
        nodeIds: target.nodeIds,
        outcome: params.outcome,
        reason: params.reason,
        observedAt,
    }));

    const result = persistRecallFeedback(workspace, feedbacks);
    clearPendingSessionRecalls(sessionId, result.bundleIds);

    return {
        content: [{
            type: "text",
            text: [
                `V8 recall feedback applied: ${result.applied}`,
                `Outcome: ${params.outcome}`,
                `Bundles: ${result.bundleIds.join(", ")}`,
                params.reason ? `Reason: ${params.reason}` : "",
                `Update queue items: ${result.queueItems}`,
            ].filter(Boolean).join("\n"),
        }],
    };
}
