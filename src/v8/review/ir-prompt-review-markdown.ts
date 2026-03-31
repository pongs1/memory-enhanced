import fs from "node:fs";
import path from "node:path";
import type {
  V8IrPromptEffectivenessScorecard,
  V8IrPromptJobMetrics,
} from "./ir-prompt-effectiveness.js";

export interface V8IrPromptReviewMarkdownInput {
  outputPath: string;
  runContext: {
    runId: string;
    dataset: string;
    sampleCount: number;
    jobCount: number;
  };
  scorecard: V8IrPromptEffectivenessScorecard;
  failedSamples: Array<{
    sampleId: string;
    layers: Array<{
      layer: string;
      jobs: V8IrPromptJobMetrics[];
    }>;
  }>;
}

export function writeIrPromptReviewMarkdown(input: V8IrPromptReviewMarkdownInput): void {
  const lines: string[] = [];
  lines.push("# IR Prompt Review");
  lines.push("");
  lines.push("## Run Context");
  lines.push("");
  lines.push(`- runId: ${input.runContext.runId}`);
  lines.push(`- dataset: ${input.runContext.dataset}`);
  lines.push(`- sampleCount: ${input.runContext.sampleCount}`);
  lines.push(`- jobCount: ${input.runContext.jobCount}`);
  lines.push("");
  lines.push("## Scorecard");
  lines.push("");
  lines.push(`- layerBreakdown: ${JSON.stringify(input.scorecard.layerBreakdown)}`);
  lines.push(`- outputCoverage: ${JSON.stringify(input.scorecard.outputCoverage)}`);
  lines.push(`- schemaValidity: ${JSON.stringify(input.scorecard.schemaValidity)}`);
  lines.push(`- layerFit: ${JSON.stringify(input.scorecard.layerFit)}`);
  lines.push(`- workflowQuality: ${JSON.stringify(input.scorecard.workflowQuality)}`);
  lines.push(`- headline: ${JSON.stringify(input.scorecard.headline)}`);
  lines.push("");
  lines.push("## Failed Samples");
  lines.push("");

  for (const sample of input.failedSamples) {
    lines.push(`### ${sample.sampleId}`);
    lines.push("");
    for (const layer of sample.layers) {
      lines.push(`#### layer: ${layer.layer}`);
      lines.push("");
      for (const job of layer.jobs) {
        lines.push(`##### ${job.jobId}`);
        lines.push(`- issueTags: ${job.issueTags.join(", ")}`);
        lines.push(
          `- turnRange: ${job.turnRange ? `${job.turnRange.start}-${job.turnRange.end}` : "unknown"}`,
        );
        lines.push(`- completedCount: ${job.completedCount}`);
        lines.push(`- pendingCount: ${job.pendingCount}`);
        lines.push(`- completedWithValidEvidence: ${job.completedWithValidEvidence}`);
        lines.push(`- pendingTouchingTail: ${job.pendingTouchingTail}`);
        if (job.windowExcerpt) {
          lines.push("");
          lines.push(`> ${job.windowExcerpt}`);
        }
        lines.push("");
      }
    }
  }

  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${lines.join("\n").trim()}\n`, "utf8");
}
