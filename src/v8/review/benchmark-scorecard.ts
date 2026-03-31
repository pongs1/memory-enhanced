import type {
  V8BenchmarkEvaluationPath,
  V8BenchmarkExecutedWorkflows,
} from "./benchmark-run-identity.js";

export interface V8BenchmarkSampleMetrics {
  correctness: { verdict: "correct" | "partial" | "wrong" };
  grounding: { verdict: "grounded" | "weak" | "missing" };
  attribution: { mismatch: boolean };
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface V8BenchmarkScorecardInput {
  runId: string;
  dataset: string;
  evaluationPath: V8BenchmarkEvaluationPath;
  executedWorkflows: V8BenchmarkExecutedWorkflows;
  samples: V8BenchmarkSampleMetrics[];
}

export function buildBenchmarkScorecard(input: V8BenchmarkScorecardInput) {
  const latencies = input.samples
    .map((sample) => Number(sample.latencyMs ?? NaN))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const medianMs =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]
        : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2;

  return {
    runId: input.runId,
    dataset: input.dataset,
    evaluationPath: input.evaluationPath,
    executedWorkflows: input.executedWorkflows,
    sampleCount: input.samples.length,
    correctness: countByVerdict(input.samples.map((sample) => sample.correctness.verdict)),
    grounding: countByVerdict(input.samples.map((sample) => sample.grounding.verdict)),
    workflowAttribution: {
      mismatchCount: input.samples.filter((sample) => sample.attribution.mismatch).length,
    },
    latency: {
      medianMs,
    },
    tokens: {
      prompt: input.samples.reduce((sum, sample) => sum + Number(sample.promptTokens || 0), 0),
      completion: input.samples.reduce(
        (sum, sample) => sum + Number(sample.completionTokens || 0),
        0,
      ),
    },
  };
}

function countByVerdict(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}
