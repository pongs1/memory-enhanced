export interface V8NodeNames {
    zh: string;
    en: string;
}

interface DeriveNameOptions {
    explicitZh?: string;
    explicitEn?: string;
    explicitAliases?: string[];
}

const ZH_EN_HINTS: Array<{ pattern: RegExp; term: string }> = [
    { pattern: /可视化/, term: "visualization" },
    { pattern: /系统开发|系统设计/, term: "system development" },
    { pattern: /上网查找|网上查找|网络检索|搜索/, term: "web search" },
    { pattern: /二重积分/, term: "double integral" },
    { pattern: /积分/, term: "integral" },
    { pattern: /详细总结|不要省略|完整总结/, term: "detailed summary" },
    { pattern: /部署手册|部署/, term: "deployment" },
    { pattern: /排查|诊断/, term: "troubleshooting" },
    { pattern: /网关断连|网关/, term: "gateway issue" },
    { pattern: /字幕文件|字幕/, term: "subtitle files" },
    { pattern: /日志/, term: "logs" },
];

const WEAK_EN_NAMES = new Set([
    "auto-recorded",
    "semantic-candidate",
    "insight",
    "observation",
    "decision",
    "error",
    "event",
    "memory",
]);

function sanitizeText(text: string, maxChars = 120): string {
    return (text || "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\b(?:User|Asst|Assistant|System)\s*:?/gi, " ")
        .replace(/(?:用户|助手|系统)\s*：/g, " ")
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

function deriveEnFromZhHints(zh: string): string {
    const hits = ZH_EN_HINTS
        .filter((item) => item.pattern.test(zh))
        .map((item) => item.term);
    if (hits.length === 0) {
        return "";
    }
    return sanitizeText(Array.from(new Set(hits)).join(" "), 72);
}

function normalizeEnCandidate(value: string): string {
    const normalized = sanitizeText(value, 72);
    if (!normalized) return "";
    if (WEAK_EN_NAMES.has(normalized.toLowerCase())) {
        return "";
    }
    return normalized;
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
        normalizeEnCandidate(options.explicitEn || "") ||
        normalizeEnCandidate(candidates.map((item) => extractEnCandidate(item)).find(Boolean) || "") ||
        normalizeEnCandidate(deriveEnFromZhHints(zh)) ||
        normalizeEnCandidate(primaryText) ||
        "generic-memory";

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
