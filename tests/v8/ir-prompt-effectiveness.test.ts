import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("ir prompt effectiveness aggregates scorecard and classifies failures", async () => {
  const mod = await import("../../src/v8/review/" + "ir-prompt-effectiveness.js");
  const result = mod.evaluateIrPromptEffectiveness({
    jobs: [
      {
        jobId: "job_micro_1",
        layer: "micro",
        narrativeRecordId: "narr_1",
        promptUnits: [{ ordinal: 1, text: "Tim is checking visas." }, { ordinal: 2, text: "He has not decided yet." }],
      },
      {
        jobId: "job_macro_1",
        layer: "macro",
        narrativeRecordId: "narr_1",
        promptUnits: [{ ordinal: 1, text: "A migration arc moves from planning to rollout." }],
      },
      {
        jobId: "job_meso_1",
        layer: "meso",
        narrativeRecordId: "narr_2",
        promptUnits: [{ ordinal: 4, text: "The team revises the plan." }, { ordinal: 5, text: "The team decides to ship." }],
      },
    ],
    completedRecords: [
      {
        _job_id: "job_micro_1",
        item_type: "entity",
        subject: "Tim",
        predicate: "uses",
        relation_family: "participation",
        object: "visa checker",
        evidence_start_turn: "1",
        evidence_end_turn: "1",
        evidence_start_anchor: "checking visas",
        evidence_end_anchor: "checking visas",
      },
      {
        _job_id: "job_macro_1",
        item_type: "entity",
        subject: "team",
        predicate: "uses",
        relation_family: "participation",
        object: "plan",
        evidence_start_turn: "1",
        evidence_end_turn: "1",
        evidence_start_anchor: "migration arc",
        evidence_end_anchor: "migration arc",
      },
    ],
    pendingRecords: [
      {
        _job_id: "job_micro_1",
        tension_role: "open",
        point_a: "visa decision",
        relation: "depends on",
        point_b: "checking progress",
        status: "pending",
        evidence_start_turn: "1",
        evidence_start_anchor: "Tim is checking",
      },
      {
        _job_id: "job_meso_1",
        tension_role: "open",
        point_a: "revised plan",
        relation: "remains open after",
        point_b: "plan revision",
        status: "pending",
        evidence_start_turn: "4",
        evidence_start_anchor: "revises the plan",
      },
    ],
    acceptedCompletedItems: 1,
  });

  assert.equal(result.scorecard.sampleCount, 2);
  assert.equal(result.scorecard.jobCount, 3);
  assert.equal(result.scorecard.outputCoverage.emptyJobs, 0);
  assert.equal(result.scorecard.outputCoverage.completedItems, 2);
  assert.equal(result.scorecard.outputCoverage.pendingItems, 2);
  assert.equal(result.scorecard.schemaValidity.acceptedCompletedItems, 1);
  assert.equal(result.scorecard.schemaValidity.rejectedCompletedItems, 1);
  assert.equal(result.scorecard.layerFit.crossLayerTypeViolations, 1);
  assert.equal(result.scorecard.layerFit.crossLayerPredicateViolations, 1);
  assert.equal(result.scorecard.workflowQuality.pendingTouchesWindowTailRate, 1);

  const macroJob = result.jobs.find((job: any) => job.jobId === "job_macro_1");
  assert.ok(macroJob);
  assert.match(macroJob.issueTags.join(","), /cross_layer_type/);
  assert.match(macroJob.issueTags.join(","), /cross_layer_relation_family/);

  const mesoJob = result.jobs.find((job: any) => job.jobId === "job_meso_1");
  assert.ok(mesoJob);
  assert.doesNotMatch(mesoJob.issueTags.join(","), /pending_not_on_tail/);
});

await run("ir prompt effectiveness accepts pending with start evidence but no end evidence", async () => {
  const mod = await import("../../src/v8/review/" + "ir-prompt-effectiveness.js");
  const result = mod.evaluateIrPromptEffectiveness({
    jobs: [
      {
        jobId: "job_micro_start_only",
        layer: "micro",
        narrativeRecordId: "narr_1",
        promptUnits: [{ ordinal: 7, text: "Budget matters too." }, { ordinal: 8, text: "The decision is still open until costs are clear." }],
      },
    ],
    completedRecords: [],
    pendingRecords: [
      {
        _job_id: "job_micro_start_only",
        tension_role: "open",
        point_a: "decision",
        relation: "remains open until",
        point_b: "costs are clear",
        status: "pending",
        evidence_start_turn: "8",
        evidence_start_anchor: "decision is still open until",
      },
    ],
    acceptedCompletedItems: 0,
  });

  const job = result.jobs[0];
  assert.ok(job);
  assert.equal(job.pendingWithRequiredFields, 1);
  assert.equal(job.pendingWithValidEvidence, 1);
  assert.equal(job.pendingTouchingTail, 1);
  assert.doesNotMatch(job.issueTags.join(","), /pending_missing_fields/);
  assert.doesNotMatch(job.issueTags.join(","), /pending_invalid_evidence/);
  assert.doesNotMatch(job.issueTags.join(","), /pending_not_on_tail/);
});

await run("ir prompt effectiveness does not penalize optional micro pending windows", async () => {
  const mod = await import("../../src/v8/review/" + "ir-prompt-effectiveness.js");
  const result = mod.evaluateIrPromptEffectiveness({
    jobs: [
      {
        jobId: "job_micro_optional_pending",
        layer: "micro",
        narrativeRecordId: "narr_1",
        promptUnits: [
          { ordinal: 25, text: "If all three checks look reasonable, I will book Osaka for lodging and keep Kyoto for day visits." },
          { ordinal: 29, text: "I can collect all those numbers tonight and commit tomorrow morning." },
          { ordinal: 31, text: "I also realized I care about whether the neighborhood around the hotel feels walkable after dark." },
          { ordinal: 32, text: "That favors Kyoto for atmosphere, but Osaka may still win on convenience and price." },
        ],
      },
    ],
    completedRecords: [],
    pendingRecords: [
      {
        _job_id: "job_micro_optional_pending",
        tension_role: "open",
        point_a: "I",
        relation: "commit",
        point_b: "tomorrow morning",
        status: "pending",
      },
    ],
    acceptedCompletedItems: 0,
  });

  const job = result.jobs[0];
  assert.ok(job);
  assert.doesNotMatch(job.issueTags.join(","), /pending_missing_fields/);
  assert.doesNotMatch(job.issueTags.join(","), /pending_invalid_evidence/);
  assert.doesNotMatch(job.issueTags.join(","), /pending_not_on_tail/);
});

await run("ir prompt effectiveness still penalizes malformed pending for expected micro pending windows", async () => {
  const mod = await import("../../src/v8/review/" + "ir-prompt-effectiveness.js");
  const result = mod.evaluateIrPromptEffectiveness({
    jobs: [
      {
        jobId: "job_micro_expected_pending",
        layer: "micro",
        narrativeRecordId: "narr_1",
        promptUnits: [
          { ordinal: 7, text: "Budget matters too, and I have not checked hotel prices yet." },
          { ordinal: 8, text: "Then the decision is still open until hotel and train costs are clear." },
        ],
      },
    ],
    completedRecords: [],
    pendingRecords: [
      {
        _job_id: "job_micro_expected_pending",
        tension_role: "open",
        point_a: "decision",
        relation: "is still open until",
        point_b: "costs are clear",
        status: "pending",
      },
    ],
    acceptedCompletedItems: 0,
  });

  const job = result.jobs[0];
  assert.ok(job);
  assert.match(job.issueTags.join(","), /pending_missing_fields/);
  assert.match(job.issueTags.join(","), /pending_not_on_tail/);
});

await run("ir prompt review markdown writer emits scorecard and failed jobs", async () => {
  const mod = await import("../../src/v8/review/" + "ir-prompt-review-markdown.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-prompt-review-"));
  const outputPath = path.join(dir, "ir_prompt_review.md");

  mod.writeIrPromptReviewMarkdown({
    outputPath,
    runContext: {
      runId: "run_1",
      dataset: "locomo",
      sampleCount: 1,
      jobCount: 2,
    },
    scorecard: {
      sampleCount: 1,
      jobCount: 2,
      layerBreakdown: { micro: 1, meso: 1, macro: 0 },
      outputCoverage: {
        jobsWithCompleted: 1,
        jobsWithPending: 1,
        jobsWithAnyOutput: 2,
        emptyJobs: 0,
        completedItems: 1,
        pendingItems: 1,
      },
      schemaValidity: {
        completedWithRequiredFields: 1,
        completedWithValidEvidence: 1,
        pendingWithRequiredFields: 1,
        pendingWithValidEvidence: 1,
        acceptedCompletedItems: 1,
        rejectedCompletedItems: 0,
      },
      layerFit: {
        typeAllowedRate: 1,
        predicateAllowedRate: 1,
        crossLayerTypeViolations: 0,
        crossLayerPredicateViolations: 0,
      },
      workflowQuality: {
        tailPendingRate: 0.5,
        pendingTouchesWindowTailRate: 1,
        completedOutOfWindowEvidenceCount: 0,
        unresolvedReferenceCount: 0,
        overDenseJobs: 0,
        underDenseJobs: 0,
      },
      headline: {
        coverageHealth: 1,
        schemaHealth: 1,
        handoffHealth: 0.75,
      },
    },
    failedSamples: [
      {
        sampleId: "sample_1",
        layers: [
          {
            layer: "micro",
            jobs: [
              {
                jobId: "job_micro_1",
                layer: "micro",
                narrativeRecordId: "narr_1",
                turnRange: { start: 1, end: 2 },
                completedCount: 0,
                pendingCount: 0,
                completedWithRequiredFields: 0,
                completedWithValidEvidence: 0,
                pendingWithRequiredFields: 0,
                pendingWithValidEvidence: 0,
                pendingTouchingTail: 0,
                typeViolations: 0,
                predicateViolations: 0,
                unresolvedReferenceCount: 0,
                issueTags: ["empty_output", "pending_not_on_tail"],
                windowExcerpt: "Tim is checking visas.",
              },
            ],
          },
        ],
      },
    ],
  });

  const markdown = fs.readFileSync(outputPath, "utf8");
  assert.match(markdown, /^# IR Prompt Review$/m);
  assert.match(markdown, /^## Run Context$/m);
  assert.match(markdown, /^## Scorecard$/m);
  assert.match(markdown, /^## Failed Samples$/m);
  assert.match(markdown, /#### layer: micro/);
  assert.match(markdown, /##### job_micro_1/);
  assert.match(markdown, /issueTags: empty_output, pending_not_on_tail/);

  fs.rmSync(dir, { recursive: true, force: true });
});
