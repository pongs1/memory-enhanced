import type { RawSessionMessage } from "../architecture/narrative-normalizer.js";

export interface LoCoMoQuestionSubsetOptions {
  maxQuestions?: number;
}

export function renderLoCoMoTurn(turn: any): string {
  const parts = [String(turn?.text || "").trim()];
  if (turn?.query) parts.push(`Referenced search query: ${String(turn.query).trim()}.`);
  if (turn?.blip_caption) parts.push(`Image context: ${String(turn.blip_caption).trim()}.`);
  if (Array.isArray(turn?.img_url) && turn.img_url.length > 0) {
    parts.push(`Attached ${turn.img_url.length} image reference(s).`);
  }
  return parts.filter(Boolean).join(" ");
}

export function parseLoCoMoSessionTurns(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function renderLoCoMoNarrative(sample: any) {
  const conv = sample?.conversation || {};
  const lines: string[] = [];
  const turnMap: Array<Record<string, unknown>> = [];
  let charCursor = 0;
  const sessionCount = countSessionKeys(conv);

  for (let sessionIndex = 1; sessionIndex <= sessionCount; sessionIndex += 1) {
    const dateKey = `session_${sessionIndex}_date_time`;
    const sessionKey = `session_${sessionIndex}`;
    const dateText = String(conv[dateKey] || `session_${sessionIndex}`);
    const turns = parseLoCoMoSessionTurns(conv[sessionKey]);
    lines.push(`## Session ${sessionIndex}`);
    lines.push(`Time: ${dateText}`);
    lines.push("");

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      const header = `### ${turn.speaker}`;
      const body = renderLoCoMoTurn(turn);
      const chunk = `${header}\n${body}\n`;
      lines.push(header);
      lines.push(body);
      lines.push("");

      const start = charCursor + header.length + 1;
      const end = start + body.length;
      turnMap.push({
        dialogue_id: turn.dia_id || null,
        session_index: sessionIndex,
        turn_index: turnIndex + 1,
        speaker: turn.speaker || "unknown",
        char_start: start,
        char_end: end,
        text: body,
      });
      charCursor += chunk.length + 1;
    }
  }

  const markdown = `${lines.join("\n").trim()}\n`;
  return { markdown, turnMap };
}

export function buildLoCoMoSessionTrace(sample: any, sampleId: string): RawSessionMessage[] {
  const conv = sample?.conversation || {};
  const sessionCount = countSessionKeys(conv);
  const messages: RawSessionMessage[] = [];
  let msgIndex = 0;

    for (let sessionIndex = 1; sessionIndex <= sessionCount; sessionIndex += 1) {
    const sessionKey = `session_${sessionIndex}`;
    const dateText = String(conv[`session_${sessionIndex}_date_time`] || "");
    const turns = parseLoCoMoSessionTurns(conv[sessionKey]);
    const sessionTs = normalizeSessionTimestamp(dateText, sessionIndex);

    for (const turn of turns) {
      msgIndex += 1;
      const speakerName = String(turn?.speaker || "unknown").trim() || "unknown";
      messages.push({
        type: "message",
        id: `${sampleId}_m${msgIndex}`,
        parentId: "",
        timestamp: sessionTs,
        message: {
          role: speakerName,
          timestamp: sessionTs,
          content: [{ type: "text", text: renderLoCoMoTurn(turn) }],
        },
      });
    }
  }

  return messages;
}

export function selectLoCoMoQuestionSubset<T extends { category?: unknown; question?: unknown; question_id?: unknown }>(
  questions: T[],
  options: LoCoMoQuestionSubsetOptions = {},
): T[] {
  const maxQuestions = Math.max(1, Number(options.maxQuestions || questions.length || 1));
  if (questions.length <= maxQuestions) return questions.slice();

  const buckets = new Map<string, T[]>();
  for (const question of questions) {
    const key = String(question.category ?? "unknown");
    const list = buckets.get(key) || [];
    list.push(question);
    buckets.set(key, list);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) =>
      String(left.question_id || left.question || "").localeCompare(
        String(right.question_id || right.question || ""),
      ),
    );
  }

  const orderedKeys = Array.from(buckets.keys()).sort();
  const selected: T[] = [];
  while (selected.length < maxQuestions) {
    let advanced = false;
    for (const key of orderedKeys) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.length === 0) continue;
      selected.push(bucket.shift()!);
      advanced = true;
      if (selected.length >= maxQuestions) break;
    }
    if (!advanced) break;
  }
  return selected;
}

function normalizeSessionTimestamp(dateText: string, sessionIndex: number): string {
  const normalized = String(dateText || "").trim();
  if (!normalized) return `session_${Math.max(1, sessionIndex)}`;
  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const match = normalized.match(/^(\d{1,2}:\d{2}\s*[ap]m)\s+on\s+(\d{1,2}\s+[A-Za-z]+,\s*\d{4})$/i);
  if (match) {
    const timePart = match[1] || "";
    const datePart = match[2] || "";
    const reparsed = parseLoCoMoNaturalTimestamp(timePart, datePart);
    if (reparsed) return reparsed;
  }
  return normalized;
}

function parseLoCoMoNaturalTimestamp(timePart: string, datePart: string): string | null {
  const timeMatch = String(timePart).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  const dateMatch = String(datePart).trim().match(/^(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/);
  if (!timeMatch || !dateMatch) return null;
  let hour = Number.parseInt(timeMatch[1] || "0", 10);
  const minute = Number.parseInt(timeMatch[2] || "0", 10);
  const meridiem = String(timeMatch[3] || "").toLowerCase();
  const day = Number.parseInt(dateMatch[1] || "0", 10);
  const month = monthNameToIndex(dateMatch[2] || "");
  const year = Number.parseInt(dateMatch[3] || "0", 10);
  if (month === null) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return new Date(Date.UTC(year, month, day, hour, minute, 0)).toISOString();
}

function monthNameToIndex(value: string): number | null {
  const months = new Map<string, number>([
    ["january", 0],
    ["february", 1],
    ["march", 2],
    ["april", 3],
    ["may", 4],
    ["june", 5],
    ["july", 6],
    ["august", 7],
    ["september", 8],
    ["october", 9],
    ["november", 10],
    ["december", 11],
  ]);
  const key = String(value || "").trim().toLowerCase();
  return months.has(key) ? months.get(key)! : null;
}

function countSessionKeys(conv: Record<string, unknown>): number {
  return Object.keys(conv)
    .map((key) => key.match(/^session_(\d+)$/))
    .filter(Boolean)
    .reduce((max, match) => Math.max(max, Number((match as RegExpMatchArray)[1])), 0);
}
