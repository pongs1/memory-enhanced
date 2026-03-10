export interface V8NodeNames {
    zh: string;
    en: string;
}

interface DeriveNameOptions {
    explicitZh?: string;
    explicitEn?: string;
    explicitAliases?: string[];
}

function sanitizeText(text: string, maxChars = 120): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function takeLeadingClause(text: string, maxChars = 120): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return sanitizeText(matched, maxChars);
}

function extractZhCandidate(text: string): string {
    const clause = takeLeadingClause(text, 96);
    const zhChunks = clause.match(/[\u4e00-\u9fff]{2,}/g) || [];
    if (zhChunks.length === 0) {
        return "";
    }

    return sanitizeText(zhChunks.join(" "), 72);
}

function extractEnCandidate(text: string): string {
    const clause = takeLeadingClause(text, 120);
    const matches = clause.match(/[A-Za-z][A-Za-z0-9/_-]*(?:\s+[A-Za-z0-9/_-]+){0,7}/g) || [];
    const best = matches
        .map((item) => sanitizeText(item, 72))
        .find((item) => /[A-Za-z]/.test(item));
    return best || "";
}

function uniqueStrings(values: string[], maxItems = 8): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
        const normalized = sanitizeText(value, 96);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(normalized);
        if (output.length >= maxItems) {
            break;
        }
    }
    return output;
}

export function deriveBilingualNodeNames(
    primaryText: string,
    fallbacks: string[] = [],
    options: DeriveNameOptions = {}
): { names: V8NodeNames; aliases: string[] } {
    const candidates = uniqueStrings([
        options.explicitZh || "",
        options.explicitEn || "",
        primaryText,
        ...fallbacks,
    ], 16);

    const zh =
        sanitizeText(options.explicitZh || "", 72) ||
        candidates.map((item) => extractZhCandidate(item)).find(Boolean) ||
        sanitizeText(primaryText, 72);

    const en =
        sanitizeText(options.explicitEn || "", 72) ||
        candidates.map((item) => extractEnCandidate(item)).find(Boolean) ||
        sanitizeText(primaryText, 72);

    const aliases = uniqueStrings([
        zh,
        en,
        ...(options.explicitAliases || []),
        primaryText,
        ...fallbacks,
    ], 10);

    return {
        names: {
            zh,
            en,
        },
        aliases,
    };
}
