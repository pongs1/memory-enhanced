import type {
  V8BenchmarkEvaluationPath,
  V8BenchmarkExecutedWorkflows,
} from "./benchmark-run-identity.js";

export interface V8WorkflowAttributionInput {
  evaluationPath: V8BenchmarkEvaluationPath;
  executedWorkflows: V8BenchmarkExecutedWorkflows;
}

export function evaluateWorkflowAttribution(input: V8WorkflowAttributionInput) {
  const required = requiredWorkflowsForPath(input.evaluationPath);
  const mismatch = required.some((field) => input.executedWorkflows[field] !== true);
  return {
    mismatch,
    failureCategory: mismatch ? "workflow_attribution_mismatch" : null,
    requiredWorkflows: required,
  };
}

function requiredWorkflowsForPath(
  path: V8BenchmarkEvaluationPath,
): Array<keyof V8BenchmarkExecutedWorkflows> {
  switch (path) {
    case "direct_text_baseline":
      return [];
    case "background_write_loop":
      return ["backgroundCompile"];
    case "compiled_memory_recall":
      return ["backgroundCompile", "compiledRecall"];
    case "front_search_escalation":
      return ["backgroundCompile", "compiledRecall", "frontSearchEscalation"];
    case "backend_relation_mining":
      return ["backgroundCompile", "backendRelationMining"];
    case "composed_system_eval":
      return ["backgroundCompile", "compiledRecall"];
  }
}
