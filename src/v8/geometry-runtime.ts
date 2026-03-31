import type {
    V8EdgeRuntimePolicyEntry,
    V8GraphEdge,
    V8PropagationDimension,
} from "./types_v8.js";

export interface V8DimensionWeights {
    H: number;
    V_up: number;
    V_down: number;
    T_forward: number;
    T_backward: number;
    O_up: number;
    O_down: number;
}

export const DEFAULT_V8_DIMENSION_WEIGHTS: V8DimensionWeights = {
    H: 1.0,
    V_up: 0.45,
    V_down: 0.25,
    T_forward: 1.1,
    T_backward: 0.5,
    O_up: 0.7,
    O_down: 0.55,
};

export function dimensionWeight(
    dimension: V8PropagationDimension,
    weights: V8DimensionWeights = DEFAULT_V8_DIMENSION_WEIGHTS
): number {
    if (dimension === "gate") return 1.0;
    if (dimension === "none") return 0.0;
    return weights[dimension];
}

export function familyWeight(edge: V8GraphEdge): number {
    const type = edge.type;
    if (
        type === "causes" ||
        type === "caused_by" ||
        type === "enables" ||
        type === "prevents" ||
        type === "requires" ||
        type === "conditioned_on" ||
        type === "culminates_in" ||
        type === "leads_to" ||
        type === "produces_shift"
    ) {
        return 1.3;
    }

    if (
        type === "triggered_by" ||
        type === "responds_to" ||
        type === "constrained_by" ||
        type === "attempts_to_resolve" ||
        type === "escalates" ||
        type === "mitigates" ||
        type === "reframes" ||
        type === "revises" ||
        type === "transitions_to_phase" ||
        type === "interrupted_by" ||
        type === "resumes_after" ||
        type === "culminates_at" ||
        type === "resolved_by"
    ) {
        return 1.2;
    }

    if (type === "state_changed_by_event") {
        return 1.2;
    }

    if (type === "state_invalidated_under_regime" || type === "state_reactivated_under_regime") {
        return 1.1;
    }

    if (type === "correction_propagates_to_line") {
        return 1.3;
    }

    if (type === "state_supersedes_state") {
        return 1.0;
    }

    if (
        type === "performs" ||
        type === "acts_on" ||
        type === "uses" ||
        type === "produces" ||
        type === "targets"
    ) {
        return 1.0;
    }

    if (
        type === "is_a" ||
        type === "instance_of" ||
        type === "part_of" ||
        type === "has_part" ||
        type === "belongs_to" ||
        type === "equivalent_to"
    ) {
        return 0.7;
    }

    if (
        type === "elaborates" ||
        type === "summarizes" ||
        type === "contrasts" ||
        type === "explains" ||
        type === "concludes" ||
        type === "recommends" ||
        type === "precedes_block" ||
        type === "branches_to" ||
        type === "merges_into" ||
        type === "parallels" ||
        type === "contrasts_with_block" ||
        type === "echoes" ||
        type === "sets_up" ||
        type === "mirrors_locally"
    ) {
        return 0.55;
    }

    if (
        type === "competes_with" ||
        type === "reinforces" ||
        type === "undermines" ||
        type === "mirrors" ||
        type === "recurs_as" ||
        type === "foreshadows" ||
        type === "pays_off" ||
        type === "recontextualizes" ||
        type === "opens_arc" ||
        type === "closes_arc"
    ) {
        return 1.1;
    }

    return 1.0;
}

export function scopeGate(
    edge: V8GraphEdge,
    matchesScope: boolean,
    floor = 0.15
): number {
    const dimension = edge.forwardDimension ?? "H";
    if (dimension !== "gate") {
        return 1.0;
    }
    return matchesScope ? 1.0 : floor;
}

export function trajectoryAffinity(
    candidateDimension: V8PropagationDimension,
    recentTrajectory: V8PropagationDimension[]
): number {
    const last = recentTrajectory[recentTrajectory.length - 1];
    const secondLast = recentTrajectory[recentTrajectory.length - 2];

    if (last === "H" && candidateDimension.startsWith("T")) return 1.3;
    if (last === "V_up" && candidateDimension === "O_up") return 1.3;
    if (last === "O_down" && candidateDimension === "H") return 1.2;
    if (last === "T_forward" && candidateDimension === "gate") return 1.2;
    if (last === "H" && candidateDimension === "V_up") return 1.1;

    if (last === "H" && secondLast === "H" && candidateDimension === "H") return 0.7;
    if (last === "V_up" && secondLast === "V_up" && candidateDimension === "V_up") return 0.4;
    if (last?.startsWith("T") && secondLast?.startsWith("T") && candidateDimension.startsWith("T")) {
        return 0.6;
    }

    return 1.0;
}

export function edgeDirectionDimension(
    edge: V8GraphEdge,
    direction: "forward" | "reverse"
): V8PropagationDimension {
    return direction === "forward"
        ? (edge.forwardDimension ?? "H")
        : (edge.reverseDimension ?? "H");
}

export function policyDirectionForDimension(
    dimension: V8PropagationDimension
): V8EdgeRuntimePolicyEntry["direction"] {
    if (dimension === "V_up" || dimension === "O_up" || dimension === "T_forward") return "up";
    if (dimension === "V_down" || dimension === "O_down" || dimension === "T_backward") return "down";
    if (dimension === "gate" || dimension === "none") return "none";
    return "bidirectional";
}
