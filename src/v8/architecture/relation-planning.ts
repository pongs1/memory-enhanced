import * as crypto from "node:crypto";
import type {
    V8EvidenceSpan,
    V8EntityPosting,
    V8EntityScopeCard,
    V8GraphEdge,
    V8GraphNode,
    V8GroupSummary,
    V8HintSource,
    V8NarrativeShardSelection,
    V8RecallBundleProjection,
    V8RelationCandidateHit,
    V8RelationReviewJob,
    V8RelationSearchPlan,
    V8ScoredHint,
    V8SearchLane,
} from "../types_v8.js";

export interface BuildRelationPlanningArtifactsInput {
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
    evidenceSpans: V8EvidenceSpan[];
    recallBundles: V8RecallBundleProjection[];
    compilePhase: "stream" | "final";
}

export interface RelationPlanningArtifacts {
    entityPostings: V8EntityPosting[];
    entityScopeCards: V8EntityScopeCard[];
    groupSummaries: V8GroupSummary[];
    relationSearchPlans: V8RelationSearchPlan[];
    narrativeShardSelections: V8NarrativeShardSelection[];
    relationCandidateHits: V8RelationCandidateHit[];
    relationReviewJobs: V8RelationReviewJob[];
}

const ANCHOR_MEMORY_TYPES = new Set<string>([
    "entity",
    "concept",
    "method",
    "goal",
    "decision",
    "constraint",
    "session_state",
    "topic_state",
    "relationship_state",
    "workflow_validity_state",
    "compatibility_state",
    "preference_state",
    "belief_state",
    "risk_state",
]);

const STATE_MEMORY_TYPES = new Set<string>([
    "session_state",
    "topic_state",
    "relationship_state",
    "workflow_validity_state",
    "compatibility_state",
    "preference_state",
    "belief_state",
    "risk_state",
]);

const EDGE_PRIOR_BY_TYPE: Record<string, string[]> = {
    entity: ["supports", "contradicts", "before", "after", "evolves_to"],
    concept: ["is_a", "part_of", "uses", "supports", "contradicts"],
    method: ["uses", "produces", "conditioned_on", "better_than", "worse_than"],
    goal: ["targets", "requires", "enables", "prevents", "supersedes"],
    decision: ["decides", "requires", "conflicts_with", "supersedes", "conditioned_on"],
    constraint: ["requires", "prevents", "conditioned_on", "conflicts_with", "refines"],
    session_state: ["state_supersedes_state", "state_refines_state", "valid_during"],
    topic_state: ["state_supersedes_state", "state_refines_state", "valid_during"],
};

export function buildRelationPlanningArtifacts(
    input: BuildRelationPlanningArtifactsInput
): RelationPlanningArtifacts {
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const spanById = new Map(input.evidenceSpans.map((span) => [span.id, span]));
    const bundlesByNodeId = indexBundlesByNode(input.recallBundles);
    const allShardHints = buildGlobalShardHints(input.evidenceSpans);

    const anchorNodes = input.nodes.filter(isAnchorNode);
    const entityPostings: V8EntityPosting[] = [];
    const entityScopeCards: V8EntityScopeCard[] = [];

    for (const node of anchorNodes) {
        const bundleRefs = bundlesByNodeId.get(node.id) || [];
        const postings = buildEntityPostingsForNode(node, spanById, bundleRefs);
        entityPostings.push(...postings);
        entityScopeCards.push(
            buildScopeCardForNode({
                node,
                edges: input.edges,
                nodeById,
                spanById,
                bundleRefs,
                postings,
            })
        );
    }

    const groupSummaries = buildGroupSummaries(input.recallBundles);
    const { relationSearchPlans, narrativeShardSelections } = buildRelationSearchPlans({
        cards: entityScopeCards,
        nodes: anchorNodes,
        bundlesByNodeId,
        allShardHints,
        compilePhase: input.compilePhase,
    });
    const { relationCandidateHits, relationReviewJobs } = buildRelationCandidateHitsAndJobs({
        relationSearchPlans,
        narrativeShardSelections,
        evidenceSpans: input.evidenceSpans,
        compilePhase: input.compilePhase,
    });

    return {
        entityPostings: sortById(entityPostings),
        entityScopeCards: sortById(entityScopeCards),
        groupSummaries: sortById(groupSummaries),
        relationSearchPlans: sortById(relationSearchPlans),
        narrativeShardSelections: sortById(narrativeShardSelections),
        relationCandidateHits: sortById(relationCandidateHits),
        relationReviewJobs: sortById(relationReviewJobs),
    };
}

function isAnchorNode(node: V8GraphNode): boolean {
    if (node.primaryLayer !== "micro") return false;
    if (node.memoryType === "evidence" || node.memoryType === "discourse_unit") return false;
    if (ANCHOR_MEMORY_TYPES.has(node.memoryType)) return true;
    return node.id.startsWith("node_sem_");
}

function buildEntityPostingsForNode(
    node: V8GraphNode,
    spanById: Map<string, V8EvidenceSpan>,
    bundleRefs: V8RecallBundleProjection[]
): V8EntityPosting[] {
    const postingsByShard = new Map<
        string,
        {
            hitCount: number;
            firstSeenAt: string | null;
            lastSeenAt: string | null;
            dayKey: string | null;
            bundleIds: Set<string>;
        }
    >();
    const bundleIds = bundleRefs.map((bundle) => bundle.bundleId);

    for (const spanId of node.evidenceSpanIds || []) {
        const span = spanById.get(spanId);
        if (!span) continue;
        const shardId = normalizeShardId(span.narrativeRecordId);
        const entry = postingsByShard.get(shardId) || {
            hitCount: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            dayKey: null,
            bundleIds: new Set<string>(),
        };
        entry.hitCount += 1;
        if (!entry.firstSeenAt || compareTs(span.timestamp, entry.firstSeenAt) < 0) {
            entry.firstSeenAt = span.timestamp || entry.firstSeenAt;
        }
        if (!entry.lastSeenAt || compareTs(span.timestamp, entry.lastSeenAt) > 0) {
            entry.lastSeenAt = span.timestamp || entry.lastSeenAt;
        }
        if (!entry.dayKey) {
            entry.dayKey = toDayKey(span.timestamp);
        }
        postingsByShard.set(shardId, entry);
    }

    for (const entry of postingsByShard.values()) {
        for (const bundleId of bundleIds) {
            entry.bundleIds.add(bundleId);
        }
    }

    const postings: V8EntityPosting[] = [];
    for (const [shardId, posting] of postingsByShard.entries()) {
        postings.push({
            id: `ep_${shortHash(`${node.id}|${shardId}`)}`,
            entityNodeId: node.id,
            canonicalLabel: node.canonicalLabel,
            alias: node.aliases?.[0] || node.canonicalLabel,
            shardId,
            bundleIds: Array.from(posting.bundleIds).sort(),
            dayKey: posting.dayKey,
            firstSeenAt: posting.firstSeenAt,
            lastSeenAt: posting.lastSeenAt,
            hitCount: posting.hitCount,
        });
    }
    return postings;
}

function buildScopeCardForNode(input: {
    node: V8GraphNode;
    edges: V8GraphEdge[];
    nodeById: Map<string, V8GraphNode>;
    spanById: Map<string, V8EvidenceSpan>;
    bundleRefs: V8RecallBundleProjection[];
    postings: V8EntityPosting[];
}): V8EntityScopeCard {
    const shardHints = toHints(
        input.postings.map((posting) => ({
            id: posting.shardId,
            score: posting.hitCount,
            source: "history" as V8HintSource,
            label: posting.dayKey || undefined,
        }))
    );
    const coanchorHints = buildCoanchorHints(input.node.id, input.bundleRefs);
    const stateHints = buildStateHints(input.node.id, input.edges, input.nodeById);
    const topicHints = toHints(
        input.bundleRefs.map((bundle) => ({
            id: bundle.bundleId,
            score: Math.max(1, bundle.nodeIds.length),
            source: "history" as V8HintSource,
            label: bundle.title,
        }))
    );
    const edgeFamilyHints = buildEdgeFamilyHints({
        node: input.node,
        edges: input.edges,
    });

    return {
        id: `esc_${shortHash(input.node.id)}`,
        entityNodeId: input.node.id,
        canonicalLabel: input.node.canonicalLabel,
        aliases: input.node.aliases || [],
        entityKind: input.node.memoryType,
        shardHints,
        coanchorHints,
        stateHints,
        topicHints,
        edgeFamilyHints,
        updatedAt: new Date().toISOString(),
    };
}

function buildCoanchorHints(
    nodeId: string,
    bundleRefs: V8RecallBundleProjection[]
): V8ScoredHint[] {
    const counter = new Map<string, number>();
    for (const bundle of bundleRefs) {
        for (const candidate of bundle.nodeIds || []) {
            if (candidate === nodeId) continue;
            counter.set(candidate, (counter.get(candidate) || 0) + 1);
        }
    }
    return toHints(
        Array.from(counter.entries()).map(([id, score]) => ({
            id,
            score,
            source: "coanchor" as V8HintSource,
        }))
    );
}

function buildStateHints(
    nodeId: string,
    edges: V8GraphEdge[],
    nodeById: Map<string, V8GraphNode>
): V8ScoredHint[] {
    const counter = new Map<string, number>();
    for (const edge of edges) {
        let neighborId: string | null = null;
        if (edge.src === nodeId) neighborId = edge.dst;
        else if (edge.dst === nodeId) neighborId = edge.src;
        if (!neighborId) continue;
        const neighbor = nodeById.get(neighborId);
        if (!neighbor) continue;
        if (!STATE_MEMORY_TYPES.has(neighbor.memoryType)) continue;
        counter.set(neighborId, (counter.get(neighborId) || 0) + Math.max(0.2, edge.confidence));
    }
    return toHints(
        Array.from(counter.entries()).map(([id, score]) => ({
            id,
            score,
            source: "history" as V8HintSource,
        }))
    );
}

function buildEdgeFamilyHints(input: {
    node: V8GraphNode;
    edges: V8GraphEdge[];
}): V8ScoredHint[] {
    const counter = new Map<string, { score: number; source: V8HintSource }>();
    for (const edge of input.edges) {
        if (edge.src !== input.node.id && edge.dst !== input.node.id) continue;
        const existing = counter.get(edge.type);
        const score = (existing?.score || 0) + Math.max(0.2, edge.confidence);
        counter.set(edge.type, { score, source: "history" });
    }

    const priors = EDGE_PRIOR_BY_TYPE[input.node.memoryType] || [
        "supports",
        "contradicts",
        "before",
        "after",
    ];
    for (const edgeType of priors) {
        const existing = counter.get(edgeType);
        if (existing) {
            existing.score += 0.75;
            counter.set(edgeType, existing);
        } else {
            counter.set(edgeType, { score: 0.75, source: "type_prior" });
        }
    }

    return toHints(
        Array.from(counter.entries()).map(([id, value]) => ({
            id,
            score: value.score,
            source: value.source,
        }))
    );
}

function buildGroupSummaries(bundles: V8RecallBundleProjection[]): V8GroupSummary[] {
    return bundles.map((bundle) => ({
        id: `gs_${shortHash(bundle.bundleId)}`,
        title: bundle.title,
        summaryText: bundle.summaryText,
        nodeIds: [...bundle.nodeIds],
        bundleIds: [bundle.bundleId],
        evidenceSpanIds: [...bundle.evidenceSpanIds],
        updatedAt: new Date().toISOString(),
    }));
}

function buildRelationSearchPlans(input: {
    cards: V8EntityScopeCard[];
    nodes: V8GraphNode[];
    bundlesByNodeId: Map<string, V8RecallBundleProjection[]>;
    allShardHints: V8ScoredHint[];
    compilePhase: "stream" | "final";
}): {
    relationSearchPlans: V8RelationSearchPlan[];
    narrativeShardSelections: V8NarrativeShardSelection[];
} {
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const cards = input.cards
        .slice()
        .sort((a, b) => cardPriority(b) - cardPriority(a) || a.id.localeCompare(b.id));
    const anchorLimit = input.compilePhase === "stream" ? 16 : 48;
    const selectedCards = cards.slice(0, anchorLimit);
    const lanes: V8SearchLane[] =
        input.compilePhase === "stream"
            ? ["focused", "broadened"]
            : ["focused", "broadened", "exploratory"];

    const plans: V8RelationSearchPlan[] = [];
    const shardSelections: V8NarrativeShardSelection[] = [];

    for (const card of selectedCards) {
        const node = nodeById.get(card.entityNodeId);
        if (!node) continue;
        const bundles = input.bundlesByNodeId.get(card.entityNodeId) || [];
        for (const lane of lanes) {
            const edgeFamilyHints = selectHintsByLane(card.edgeFamilyHints, lane, 8);
            if (edgeFamilyHints.length === 0) continue;
            const shardHints = selectShardHintsByLane(
                card.shardHints,
                input.allShardHints,
                lane
            );
            const planId = `rsp_${shortHash(`${card.id}|${lane}`)}`;
            const scope = input.compilePhase === "stream" ? "local_active" : "global_archive";
            plans.push({
                id: planId,
                anchorNodeIds: [card.entityNodeId],
                anchorLabels: [card.canonicalLabel, ...(card.aliases || [])]
                    .map((text) => text.trim())
                    .filter(Boolean)
                    .slice(0, 4),
                anchorKinds: [card.entityKind],
                edgeFamilyHints,
                recallMode: input.compilePhase === "stream" ? "profile" : "trajectory",
                searchScope: scope,
                searchMode: "hybrid",
                lane,
                queryTerms: buildQueryTerms(card, node),
                hintBundleIds: bundles.map((bundle) => bundle.bundleId).slice(0, 12),
                hintSpanIds: (node.bestEvidenceSpanIds || node.evidenceSpanIds || []).slice(0, 24),
                scopeCardIds: [card.id],
                createdAt: new Date().toISOString(),
            });

            shardSelections.push({
                id: `nss_${shortHash(planId)}`,
                planId,
                lane,
                selectedShardHints: shardHints,
                droppedShardIds: card.shardHints
                    .map((hint) => hint.id)
                    .filter((id) => !shardHints.some((selected) => selected.id === id))
                    .slice(0, 64),
                createdAt: new Date().toISOString(),
            });
        }
    }

    return {
        relationSearchPlans: plans,
        narrativeShardSelections: shardSelections,
    };
}

function buildRelationCandidateHitsAndJobs(input: {
    relationSearchPlans: V8RelationSearchPlan[];
    narrativeShardSelections: V8NarrativeShardSelection[];
    evidenceSpans: V8EvidenceSpan[];
    compilePhase: "stream" | "final";
}): {
    relationCandidateHits: V8RelationCandidateHit[];
    relationReviewJobs: V8RelationReviewJob[];
} {
    const selectionByPlanId = new Map(
        input.narrativeShardSelections.map((selection) => [selection.planId, selection])
    );
    const spansByShard = new Map<string, V8EvidenceSpan[]>();
    for (const span of input.evidenceSpans) {
        const shardId = normalizeShardId(span.narrativeRecordId);
        const list = spansByShard.get(shardId) || [];
        list.push(span);
        spansByShard.set(shardId, list);
    }

    const maxPlans = input.compilePhase === "stream" ? 24 : 72;
    const planRanked = input.relationSearchPlans
        .slice()
        .sort((a, b) => planPriority(b) - planPriority(a) || a.id.localeCompare(b.id))
        .slice(0, maxPlans);

    const relationCandidateHits: V8RelationCandidateHit[] = [];
    const relationReviewJobs: V8RelationReviewJob[] = [];
    const hitIdSet = new Set<string>();

    for (const plan of planRanked) {
        const selection = selectionByPlanId.get(plan.id);
        const allowedShardIds = (selection?.selectedShardHints || [])
            .map((hint) => hint.id)
            .filter(Boolean);
        if (allowedShardIds.length === 0) continue;

        const laneTopK = plan.lane === "focused" ? 6 : plan.lane === "broadened" ? 9 : 12;
        const candidates: Array<{ span: V8EvidenceSpan; score: number }> = [];
        const terms = tokenizeTerms(plan.queryTerms);
        const boostedSpanIds = new Set(plan.hintSpanIds || []);
        for (const shardId of allowedShardIds) {
            for (const span of spansByShard.get(shardId) || []) {
                const base = scoreSpanAgainstTerms(span.text, terms);
                if (base <= 0) continue;
                const score = boostedSpanIds.has(span.id) ? base + 0.08 : base;
                candidates.push({ span, score });
            }
        }
        candidates.sort((a, b) => b.score - a.score || a.span.id.localeCompare(b.span.id));
        const top = candidates.slice(0, laneTopK);
        if (top.length === 0) continue;

        const candidateHitIds: string[] = [];
        const evidenceSpanIds: string[] = [];
        for (const item of top) {
            const candidateEdgeType =
                plan.edgeFamilyHints[0]?.id || "supports";
            const hitId = `rch_${shortHash(`${plan.id}|${item.span.id}|${candidateEdgeType}`)}`;
            if (hitIdSet.has(hitId)) continue;
            hitIdSet.add(hitId);
            relationCandidateHits.push({
                id: hitId,
                planId: plan.id,
                candidateEdgeType,
                spanId: item.span.id,
                unitId: item.span.unitId,
                narrativeRef: item.span.narrativeRef,
                score: round3(item.score),
                spanText: item.span.text,
                createdAt: new Date().toISOString(),
            });
            candidateHitIds.push(hitId);
            evidenceSpanIds.push(item.span.id);
        }
        if (candidateHitIds.length === 0) continue;

        const jobId = `rrj_${shortHash(plan.id)}`;
        relationReviewJobs.push({
            id: jobId,
            planId: plan.id,
            anchorNodeIds: [...plan.anchorNodeIds],
            candidateEdgeTypes: plan.edgeFamilyHints.map((hint) => hint.id).slice(0, 5),
            candidateHitIds,
            evidenceSpanIds: uniqueList(evidenceSpanIds).slice(0, 40),
            bundleIds: [...(plan.hintBundleIds || [])].slice(0, 10),
            reviewQuestion: buildReviewQuestion(plan),
            modeHint: plan.recallMode,
            status: "pending",
            createdAt: new Date().toISOString(),
        });
    }

    return {
        relationCandidateHits,
        relationReviewJobs,
    };
}

function selectShardHintsByLane(
    cardHints: V8ScoredHint[],
    allShardHints: V8ScoredHint[],
    lane: V8SearchLane
): V8ScoredHint[] {
    if (cardHints.length === 0) {
        if (lane === "focused") return allShardHints.slice(0, 3);
        if (lane === "broadened") return allShardHints.slice(0, 6);
        return allShardHints.slice(0, 5).map((hint) => ({
            ...hint,
            source: "novelty" as V8HintSource,
        }));
    }
    if (lane === "focused") {
        return cardHints.slice(0, 4);
    }
    if (lane === "broadened") {
        return cardHints.slice(0, 8);
    }
    const primary = cardHints.slice(0, 3);
    const seen = new Set(primary.map((hint) => hint.id));
    const novelty = allShardHints
        .filter((hint) => !seen.has(hint.id))
        .slice(0, 5)
        .map((hint) => ({ ...hint, source: "novelty" as V8HintSource }));
    return [...primary, ...novelty];
}

function selectHintsByLane(
    hints: V8ScoredHint[],
    lane: V8SearchLane,
    maxCount: number
): V8ScoredHint[] {
    if (hints.length === 0) return [];
    if (lane === "focused") return hints.slice(0, Math.min(4, maxCount));
    if (lane === "broadened") return hints.slice(0, Math.min(8, maxCount));
    const selected = hints.slice(0, Math.min(6, maxCount));
    if (selected.length < maxCount) {
        const tail = hints
            .slice(Math.min(8, hints.length))
            .slice(0, Math.max(0, maxCount - selected.length))
            .map((hint) => ({ ...hint, source: "novelty" as V8HintSource }));
        selected.push(...tail);
    }
    return selected.slice(0, maxCount);
}

function buildQueryTerms(card: V8EntityScopeCard, node: V8GraphNode): string[] {
    const terms = new Set<string>();
    addTerm(terms, card.canonicalLabel);
    for (const alias of card.aliases || []) addTerm(terms, alias);
    for (const hint of card.edgeFamilyHints.slice(0, 5)) addTerm(terms, hint.id);
    for (const hint of card.stateHints.slice(0, 3)) addTerm(terms, hint.label || hint.id);
    for (const hint of card.topicHints.slice(0, 3)) addTerm(terms, hint.label || hint.id);
    addTerm(terms, node.memoryType);
    return Array.from(terms).slice(0, 24);
}

function addTerm(set: Set<string>, value: string): void {
    const normalized = (value || "").trim();
    if (!normalized) return;
    set.add(normalized);
}

function scoreSpanAgainstTerms(spanText: string, terms: string[]): number {
    if (terms.length === 0) return 0;
    const text = (spanText || "").toLowerCase();
    if (!text) return 0;
    let hit = 0;
    for (const term of terms) {
        if (text.includes(term)) hit += 1;
    }
    if (hit === 0) return 0;
    return hit / terms.length;
}

function tokenizeTerms(terms: string[]): string[] {
    const output: string[] = [];
    for (const raw of terms || []) {
        const normalized = (raw || "").trim().toLowerCase();
        if (!normalized) continue;
        if (normalized.length < 2) continue;
        output.push(normalized);
    }
    return uniqueList(output).slice(0, 24);
}

function indexBundlesByNode(
    bundles: V8RecallBundleProjection[]
): Map<string, V8RecallBundleProjection[]> {
    const map = new Map<string, V8RecallBundleProjection[]>();
    for (const bundle of bundles) {
        for (const nodeId of bundle.nodeIds || []) {
            const list = map.get(nodeId) || [];
            list.push(bundle);
            map.set(nodeId, list);
        }
    }
    return map;
}

function buildGlobalShardHints(spans: V8EvidenceSpan[]): V8ScoredHint[] {
    const counter = new Map<string, number>();
    for (const span of spans) {
        const shardId = normalizeShardId(span.narrativeRecordId);
        counter.set(shardId, (counter.get(shardId) || 0) + 1);
    }
    return toHints(
        Array.from(counter.entries()).map(([id, score]) => ({
            id,
            score,
            source: "history" as V8HintSource,
        }))
    );
}

function toHints(
    raw: Array<{
        id: string;
        score: number;
        source: V8HintSource;
        label?: string;
    }>
): V8ScoredHint[] {
    const merged = new Map<string, { score: number; source: V8HintSource; label?: string }>();
    for (const item of raw) {
        if (!item.id) continue;
        const nextScore = Number.isFinite(item.score) ? item.score : 0;
        const prev = merged.get(item.id);
        if (!prev) {
            merged.set(item.id, {
                score: nextScore,
                source: item.source,
                label: item.label,
            });
            continue;
        }
        const mergedScore = prev.score + nextScore;
        const nextSource = nextScore >= prev.score ? item.source : prev.source;
        merged.set(item.id, {
            score: mergedScore,
            source: nextSource,
            label: prev.label || item.label,
        });
    }
    const maxScore = Math.max(
        1,
        ...Array.from(merged.values()).map((item) => item.score)
    );
    return Array.from(merged.entries())
        .map(([id, item]) => ({
            id,
            score: round3(item.score / maxScore),
            source: item.source,
            label: item.label,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 32);
}

function cardPriority(card: V8EntityScopeCard): number {
    const shard = card.shardHints[0]?.score || 0;
    const edge = card.edgeFamilyHints[0]?.score || 0;
    const coanchor = card.coanchorHints[0]?.score || 0;
    return shard * 0.45 + edge * 0.4 + coanchor * 0.15;
}

function planPriority(plan: V8RelationSearchPlan): number {
    const edge = plan.edgeFamilyHints[0]?.score || 0;
    const scope = plan.searchScope === "global_archive" ? 1 : 0.7;
    const laneWeight =
        plan.lane === "focused" ? 1 : plan.lane === "broadened" ? 0.85 : 0.7;
    return edge * scope * laneWeight;
}

function compareTs(a: string | null, b: string | null): number {
    const aTs = a ? Date.parse(a) : NaN;
    const bTs = b ? Date.parse(b) : NaN;
    if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0;
    if (Number.isNaN(aTs)) return -1;
    if (Number.isNaN(bTs)) return 1;
    return aTs - bTs;
}

function toDayKey(ts: string | null): string | null {
    if (!ts) return null;
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeShardId(value: string): string {
    return (value || "unknown").trim() || "unknown";
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function buildReviewQuestion(plan: V8RelationSearchPlan): string {
    const anchor = plan.anchorLabels?.[0] || "anchor";
    const edgeList = plan.edgeFamilyHints
        .map((hint) => hint.id)
        .slice(0, 4)
        .join(", ");
    return `Verify whether direct evidence supports relations for ${anchor} under edge families: ${edgeList}.`;
}

function uniqueList<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}

function shortHash(text: string): string {
    return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function sortById<T extends { id: string }>(records: T[]): T[] {
    return records.slice().sort((a, b) => a.id.localeCompare(b.id));
}
