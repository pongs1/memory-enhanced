export interface LoCoMoSmokeSelectionOptions {
  size?: number;
}

export interface LoCoMoSmokeMetrics {
  sessionCount: number;
  turnCount: number;
  narrativeChars: number;
  questionCount: number;
}

const MIN_SESSION_COUNT = 4;
const MIN_TURN_COUNT = 30;
const MIN_NARRATIVE_CHARS = 12000;

export function computeLoCoMoSmokeMetrics(sample: any): LoCoMoSmokeMetrics {
  const conversation = sample?.conversation || {};
  const sessionKeys = Object.keys(conversation)
    .map((key) => key.match(/^session_(\d+)$/))
    .filter(Boolean) as RegExpMatchArray[];
  const sessionCount = sessionKeys.reduce(
    (max, match) => Math.max(max, Number(match[1])),
    0,
  );

  let turnCount = 0;
  let narrativeChars = 0;
  for (let index = 1; index <= sessionCount; index += 1) {
    const turns = parseSessionTurns(conversation[`session_${index}`]);
    const dateText = String(conversation[`session_${index}_date_time`] || "");
    narrativeChars += `## Session ${index}\nTime: ${dateText}\n\n`.length;
    for (const turn of turns) {
      const body = renderLoCoMoTurn(turn);
      turnCount += 1;
      narrativeChars += `### ${String(turn?.speaker || "unknown")}\n${body}\n\n`.length;
    }
  }

  return {
    sessionCount,
    turnCount,
    narrativeChars,
    questionCount: Array.isArray(sample?.qa) ? sample.qa.length : 0,
  };
}

export function selectLoCoMoSmokeSamples<T extends Record<string, unknown>>(
  samples: T[],
  options: LoCoMoSmokeSelectionOptions = {},
): Array<T & { __smokeMetrics: LoCoMoSmokeMetrics }> {
  const size = Math.max(1, Number(options.size || 10));
  const withMetrics = samples
    .map((sample) => ({
      ...sample,
      __smokeMetrics: computeLoCoMoSmokeMetrics(sample),
    }))
    .filter((sample) => sample.__smokeMetrics.sessionCount >= MIN_SESSION_COUNT)
    .filter((sample) => sample.__smokeMetrics.turnCount >= MIN_TURN_COUNT)
    .filter((sample) => sample.__smokeMetrics.narrativeChars >= MIN_NARRATIVE_CHARS);

  withMetrics.sort((left, right) => {
    const chars = right.__smokeMetrics.narrativeChars - left.__smokeMetrics.narrativeChars;
    if (chars !== 0) return chars;
    const turns = right.__smokeMetrics.turnCount - left.__smokeMetrics.turnCount;
    if (turns !== 0) return turns;
    const sessions = right.__smokeMetrics.sessionCount - left.__smokeMetrics.sessionCount;
    if (sessions !== 0) return sessions;
    return String(left.sample_id || "").localeCompare(String(right.sample_id || ""));
  });

  return withMetrics.slice(0, size);
}

function parseSessionTurns(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderLoCoMoTurn(turn: any): string {
  const parts = [String(turn?.text || "").trim()];
  if (turn?.query) parts.push(`Referenced search query: ${String(turn.query).trim()}.`);
  if (turn?.blip_caption) parts.push(`Image context: ${String(turn.blip_caption).trim()}.`);
  if (Array.isArray(turn?.img_url) && turn.img_url.length > 0) {
    parts.push(`Attached ${turn.img_url.length} image reference(s).`);
  }
  return parts.filter(Boolean).join(" ");
}
