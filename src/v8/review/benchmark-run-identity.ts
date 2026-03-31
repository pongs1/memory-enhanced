export type V8BenchmarkEvaluationPath =
  | "direct_text_baseline"
  | "background_write_loop"
  | "compiled_memory_recall"
  | "front_search_escalation"
  | "backend_relation_mining"
  | "composed_system_eval";

export interface V8BenchmarkExecutedWorkflows {
  backgroundCompile: boolean;
  compiledRecall: boolean;
  frontSearchEscalation: boolean;
  backendRelationMining: boolean;
}

export interface V8BenchmarkRunIdentityInput {
  benchmark: string;
  sampleId: string;
  evaluationPath?: V8BenchmarkEvaluationPath | null;
  executedWorkflows?: Partial<V8BenchmarkExecutedWorkflows> | null;
}

export interface V8BenchmarkRunIdentity {
  benchmark: string;
  sampleId: string;
  evaluationPath: V8BenchmarkEvaluationPath;
  executedWorkflows: V8BenchmarkExecutedWorkflows;
}

const DEFAULT_EXECUTED_WORKFLOWS: V8BenchmarkExecutedWorkflows = {
  backgroundCompile: false,
  compiledRecall: false,
  frontSearchEscalation: false,
  backendRelationMining: false,
};

export function validateBenchmarkRunIdentity(
  input: V8BenchmarkRunIdentityInput,
): V8BenchmarkRunIdentity {
  const evaluationPath = input.evaluationPath;
  if (!evaluationPath) {
    throw new Error("evaluationPath is required for every benchmark run.");
  }

  return {
    benchmark: String(input.benchmark || "").trim(),
    sampleId: String(input.sampleId || "").trim(),
    evaluationPath,
    executedWorkflows: {
      ...DEFAULT_EXECUTED_WORKFLOWS,
      ...(input.executedWorkflows || {}),
    },
  };
}
