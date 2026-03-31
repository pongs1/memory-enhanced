import { buildBenchmarkScorecard } from "./benchmark-scorecard.js";

export interface V8BenchmarkSmokeAggregateInput {
  runId: string;
  dataset: string;
  evaluationPath: any;
  executedWorkflows: any;
  maxFailuresPerSample?: number;
  summaries: Array<{
    sample_id: string;
    results: Array<{
      question_id?: string;
      question?: string;
      answer?: string;
      proxy_answer?: string;
      selected_unit_ids?: string[];
      selected_unit_excerpts?: string[];
      correctness: { verdict: "correct" | "partial" | "wrong" };
      grounding: { verdict: "grounded" | "weak" | "missing" };
      attribution: { mismatch: boolean };
      failureCategory: string | null;
    }>;
  }>;
}

export function aggregateSmokeSummaries(input: V8BenchmarkSmokeAggregateInput) {
  const maxFailuresPerSample = Math.max(1, Number(input.maxFailuresPerSample || 3));
  const samples = input.summaries.flatMap((summary) =>
    summary.results.map((result) => ({
      ...result,
      sampleId: summary.sample_id,
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
    })),
  );

  const scorecard = buildBenchmarkScorecard({
    runId: input.runId,
    dataset: input.dataset,
    evaluationPath: input.evaluationPath,
    executedWorkflows: input.executedWorkflows,
    samples,
  });

  return {
    scorecard,
    failedSamples: input.summaries
      .map((summary) => ({
        sampleId: summary.sample_id,
        topFailures: summary.results
          .filter((result) => result.failureCategory !== null)
          .slice(0, maxFailuresPerSample)
          .map((result) => ({
            questionId: result.question_id || "",
            verdict: result.failureCategory,
            question: result.question || "",
            expectedAnswer: result.answer || "",
            producedAnswer: result.proxy_answer || "",
            selectedUnitIds: result.selected_unit_ids || [],
            selectedUnitExcerpts: result.selected_unit_excerpts || [],
          })),
      }))
      .filter((sample) => sample.topFailures.length > 0),
  };
}
