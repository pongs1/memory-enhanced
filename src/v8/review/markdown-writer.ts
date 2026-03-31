import fs from "node:fs";
import path from "node:path";

export interface V8BenchmarkReviewMarkdownInput {
  outputPath: string;
  runContext: {
    runId: string;
    dataset: string;
    evaluationPath: string;
  };
  scorecard: {
    sampleCount: number;
    correctness: Record<string, number>;
    grounding: Record<string, number>;
    workflowAttribution: { mismatchCount: number };
    latency: { medianMs: number };
    tokens: { prompt: number; completion: number };
  };
  failedSamples: Array<{
    sampleId: string;
    topFailures: Array<{
      questionId: string;
      verdict: string;
      question: string;
      expectedAnswer: string;
      producedAnswer: string;
      selectedUnitIds: string[];
      selectedUnitExcerpts: string[];
    }>;
  }>;
}

export function writeBenchmarkReviewMarkdown(
  input: V8BenchmarkReviewMarkdownInput,
): void {
  const lines: string[] = [];
  lines.push("# Benchmark Review");
  lines.push("");
  lines.push("## Run Context");
  lines.push("");
  lines.push(`- runId: ${input.runContext.runId}`);
  lines.push(`- dataset: ${input.runContext.dataset}`);
  lines.push(`- evaluationPath: ${input.runContext.evaluationPath}`);
  lines.push("");
  lines.push("## Workflow Scorecard");
  lines.push("");
  lines.push(`- sampleCount: ${input.scorecard.sampleCount}`);
  lines.push(`- correctness: ${JSON.stringify(input.scorecard.correctness)}`);
  lines.push(`- grounding: ${JSON.stringify(input.scorecard.grounding)}`);
  lines.push(
    `- workflowAttributionMismatchCount: ${input.scorecard.workflowAttribution.mismatchCount}`,
  );
  lines.push(`- latencyMedianMs: ${input.scorecard.latency.medianMs}`);
  lines.push(`- promptTokens: ${input.scorecard.tokens.prompt}`);
  lines.push(`- completionTokens: ${input.scorecard.tokens.completion}`);
  lines.push("");
  lines.push("## Failed Samples");
  lines.push("");
  for (const sample of input.failedSamples) {
    lines.push(`### ${sample.sampleId}`);
    lines.push("");
    for (const failure of sample.topFailures) {
      lines.push(`#### ${failure.questionId}`);
      lines.push(`- verdict: ${failure.verdict}`);
      lines.push(`- question: ${failure.question}`);
      lines.push(`- expectedAnswer: ${failure.expectedAnswer}`);
      lines.push(`- producedAnswer: ${failure.producedAnswer}`);
      lines.push(`- selectedUnitIds: ${failure.selectedUnitIds.join(", ")}`);
      lines.push("");
      for (const excerpt of failure.selectedUnitExcerpts) {
        lines.push(`> ${excerpt}`);
      }
      lines.push("");
    }
  }

  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${lines.join("\n").trim()}\n`, "utf8");
}
