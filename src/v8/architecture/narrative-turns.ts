export interface V8ParsedNarrativeTurnSpan {
    ordinal: number;
    headerStart: number;
    headerEnd: number;
    bodyStart: number;
    bodyEnd: number;
    role: string | null;
    timestamp: string | null;
}

export interface NarrativeLine {
    start: number;
    end: number;
    text: string;
}

export function splitNarrativeLinesWithOffsets(text: string): NarrativeLine[] {
    const lines: NarrativeLine[] = [];
    let start = 0;
    for (let idx = 0; idx < text.length; idx += 1) {
        if (text[idx] !== "\n") continue;
        lines.push({
            start,
            end: idx + 1,
            text: text.slice(start, idx + 1),
        });
        start = idx + 1;
    }
    if (start < text.length) {
        lines.push({
            start,
            end: text.length,
            text: text.slice(start),
        });
    }
    return lines;
}

export function isNarrativeTurnHeaderLine(trimmed: string): boolean {
    if (!/^###\s+.+$/.test(trimmed)) {
        return false;
    }
    if (/^###\s+(micro|meso|macro)\s+units$/i.test(trimmed)) {
        return false;
    }
    return /^###\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+.+:$/.test(trimmed);
}

export function parseNarrativeTurnHeader(value: string): {
    role: string | null;
    timestamp: string | null;
} {
    const trimmed = String(value || "").trim();
    const timestampFirst = trimmed.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+?):$/);
    if (timestampFirst) {
        return {
            role: (timestampFirst[2] || "").trim() || null,
            timestamp: (timestampFirst[1] || "").trim() || null,
        };
    }
    return { role: null, timestamp: null };
}

export function parseNarrativeTurnSpans(text: string): V8ParsedNarrativeTurnSpan[] {
    const lines = splitNarrativeLinesWithOffsets(text);
    const turns: V8ParsedNarrativeTurnSpan[] = [];
    for (const line of lines) {
        const trimmed = line.text.trim();
        if (!isNarrativeTurnHeaderLine(trimmed)) continue;
        const parsed = parseNarrativeTurnHeader(trimmed.slice(4));
        turns.push({
            ordinal: turns.length + 1,
            headerStart: line.start,
            headerEnd: line.end,
            bodyStart: line.end,
            bodyEnd: text.length,
            role: parsed.role,
            timestamp: parsed.timestamp,
        });
    }

    if (turns.length === 0) {
        return [
            {
                ordinal: 1,
                headerStart: 0,
                headerEnd: 0,
                bodyStart: 0,
                bodyEnd: text.length,
                role: null,
                timestamp: null,
            },
        ];
    }

    for (let idx = 0; idx < turns.length; idx += 1) {
        const next = turns[idx + 1];
        turns[idx]!.bodyEnd = next ? next.headerStart : text.length;
    }
    return turns;
}
