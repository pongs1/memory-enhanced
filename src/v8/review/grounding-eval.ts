export interface V8GroundingEvalInput {
  answer: string;
  selectedUnitIds: string[];
  selectedUnitExcerpts: string[];
  supportingSourceRefs: string[];
  supportingMemoryItems: Array<{ id: string; evidenceSpans?: unknown[] | null }>;
}

export function evaluateGrounding(input: V8GroundingEvalInput) {
  if (
    input.selectedUnitIds.length === 0 ||
    input.supportingSourceRefs.length === 0 ||
    input.supportingMemoryItems.length === 0 ||
    input.supportingMemoryItems.every((item) => !Array.isArray(item.evidenceSpans) || item.evidenceSpans.length === 0)
  ) {
    return {
      verdict: "missing" as const,
      coverageScore: 0,
    };
  }

  const answerTokens = tokenize(input.answer);
  const supportTokens = new Set(tokenize(input.selectedUnitExcerpts.join(" ")));
  const shared = answerTokens.filter((token) => supportTokens.has(token));
  const coverageScore = answerTokens.length === 0 ? 0 : shared.length / answerTokens.length;

  if (coverageScore >= 0.8) {
    return { verdict: "grounded" as const, coverageScore };
  }
  if (coverageScore > 0) {
    return { verdict: "weak" as const, coverageScore };
  }
  return { verdict: "missing" as const, coverageScore };
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}
