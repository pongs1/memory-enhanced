import type { V8BenchmarkEvaluationPath } from "./benchmark-run-identity.js";

export interface V8BenchmarkFailureInput {
  correctnessVerdict: "correct" | "partial" | "wrong";
  groundingVerdict: "grounded" | "weak" | "missing";
  attributionMismatch: boolean;
  evaluationError: boolean;
  workflowStage: V8BenchmarkEvaluationPath;
}

export type V8BenchmarkFailureCategory =
  | "answer_wrong"
  | "answer_partial"
  | "grounding_missing"
  | "grounding_weak"
  | "write_loop_failure"
  | "compiled_recall_failure"
  | "search_escalation_failure"
  | "relation_mining_failure"
  | "workflow_attribution_mismatch"
  | "runner_or_eval_failure";

export function classifyBenchmarkFailure(
  input: V8BenchmarkFailureInput,
): V8BenchmarkFailureCategory {
  if (input.evaluationError) return "runner_or_eval_failure";
  if (input.attributionMismatch) return "workflow_attribution_mismatch";
  if (input.groundingVerdict === "missing") return "grounding_missing";
  if (input.groundingVerdict === "weak") return "grounding_weak";
  if (input.correctnessVerdict === "partial") return "answer_partial";
  if (input.correctnessVerdict === "wrong") {
    switch (input.workflowStage) {
      case "background_write_loop":
        return "write_loop_failure";
      case "compiled_memory_recall":
        return "compiled_recall_failure";
      case "front_search_escalation":
        return "search_escalation_failure";
      case "backend_relation_mining":
        return "relation_mining_failure";
      default:
        return "answer_wrong";
    }
  }
  return "answer_wrong";
}
