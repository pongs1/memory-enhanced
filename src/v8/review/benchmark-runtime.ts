export interface BenchmarkTextSignal {
  source: string;
  text: string;
  weight: number;
}

export interface BenchmarkAnswerChoiceInput {
  llmMemoryAnswer?: string | null;
  llmMemoryStatus?: string | null;
  llmSearchAnswer?: string | null;
  llmSearchStatus?: string | null;
  fallbackText?: string | null;
}

export interface BenchmarkHit {
  spanId?: string | null;
  score?: number | null;
  spanText?: string | null;
  rawText?: string | null;
}

export interface BenchmarkBundleCandidate {
  bundleId: string;
  title?: string | null;
  summaryText?: string | null;
  nodeLabels?: string[] | null;
  evidenceTexts?: string[] | null;
}

export interface BenchmarkAnswerSupportInput {
  answer?: string | null;
  hits?: BenchmarkHit[] | null;
}

const INSUFFICIENT_PATTERNS = [
  "insufficient evidence",
  "insufficient information",
  "not enough information",
  "does not contain information",
  "there is no information",
  "cannot determine",
  "cannot be determined",
];

export function buildBenchmarkQuerySignals(questionText: string): BenchmarkTextSignal[] {
  const text = String(questionText || "").trim();
  if (!text) return [];
  return [{ source: "question", text, weight: 1 }];
}

export function choosePreferredBenchmarkAnswer(
  input: BenchmarkAnswerChoiceInput,
): string {
  const memoryAnswer = String(input.llmMemoryAnswer || "").trim();
  const searchAnswer = String(input.llmSearchAnswer || "").trim();
  const fallbackText = String(input.fallbackText || "").trim();

  const memoryUsable = isUsableAnswer(memoryAnswer, input.llmMemoryStatus);
  const searchUsable = isUsableAnswer(searchAnswer, input.llmSearchStatus);

  if (memoryUsable && searchUsable) {
    return chooseMoreInformative(memoryAnswer, searchAnswer);
  }
  if (searchUsable) return searchAnswer;
  if (memoryUsable) return memoryAnswer;
  if (searchAnswer) return searchAnswer;
  if (memoryAnswer) return memoryAnswer;
  return fallbackText;
}

export function mergeBenchmarkHits(
  searchHits: BenchmarkHit[],
  seedHits: BenchmarkHit[],
  topK: number,
): BenchmarkHit[] {
  const merged: BenchmarkHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...(searchHits || []), ...(seedHits || [])]) {
    const spanId = String(hit?.spanId || "").trim();
    if (!spanId || seen.has(spanId)) continue;
    seen.add(spanId);
    merged.push(hit);
    if (merged.length >= topK) break;
  }
  return merged;
}

export function filterBenchmarkBundlesByQuestion(
  questionText: string,
  bundles: BenchmarkBundleCandidate[],
  maxBundles = 8,
): BenchmarkBundleCandidate[] {
  const questionTokens = tokenizeMeaningful(questionText);
  if (questionTokens.length === 0) return bundles.slice(0, maxBundles);

  return (bundles || [])
    .map((bundle) => ({
      bundle,
      score: bundleQuestionScore(bundle, questionTokens),
    }))
    .filter((entry) => entry.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxBundles)
    .map((entry) => entry.bundle);
}

export function buildSearchAnswerHits(input: {
  staticGuidedHits?: BenchmarkHit[];
  ignitionGuidedHits?: BenchmarkHit[];
  rawHits?: BenchmarkHit[];
  topK: number;
}): BenchmarkHit[] {
  return mergeBenchmarkHits(
    mergeBenchmarkHits(input.staticGuidedHits || [], input.ignitionGuidedHits || [], input.topK),
    input.rawHits || [],
    input.topK,
  );
}

export function scoreBenchmarkAnswerSupport(
  input: BenchmarkAnswerSupportInput,
): number {
  const answerTokens = tokenizeMeaningful(String(input.answer || ""));
  if (answerTokens.length === 0) return 0;
  const hitTokens = new Set(
    tokenizeMeaningful(
      (input.hits || [])
        .map((hit) => `${hit.spanText || ""} ${hit.rawText || ""}`)
        .join(" "),
    ),
  );
  if (hitTokens.size === 0) return 0;
  let matched = 0;
  for (const token of answerTokens) {
    if (hitTokens.has(token)) matched += 1;
  }
  return matched / answerTokens.length;
}

function isUsableAnswer(answer: string, status?: string | null): boolean {
  if (!answer) return false;
  if (status && !String(status).startsWith("completed")) return false;
  const normalized = answer.toLowerCase();
  return !INSUFFICIENT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function chooseMoreInformative(left: string, right: string): string {
  const leftScore = informationScore(left);
  const rightScore = informationScore(right);
  return rightScore > leftScore ? right : left;
}

function informationScore(text: string): number {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function bundleQuestionScore(
  bundle: BenchmarkBundleCandidate,
  questionTokens: string[],
): number {
  const text = [
    bundle.title || "",
    bundle.summaryText || "",
    ...(bundle.nodeLabels || []),
    ...(bundle.evidenceTexts || []).slice(0, 2),
  ]
    .filter(Boolean)
    .join(" ");
  const bundleTokens = new Set(tokenizeMeaningful(text));
  if (bundleTokens.size === 0) return 0;
  let matched = 0;
  for (const token of questionTokens) {
    if (bundleTokens.has(token)) matched += 1;
  }
  return matched / questionTokens.length;
}

function tokenizeMeaningful(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !STOP_TOKENS.has(item));
}

const STOP_TOKENS = new Set([
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "many",
  "much",
  "does",
  "did",
  "have",
  "has",
  "been",
  "with",
  "from",
  "that",
  "this",
  "about",
  "according",
]);
