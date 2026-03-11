import {
    normalizeUserRequest,
    paths,
    readFileOr,
    summarizeUserRequestForTask,
    type MemoryEvent,
} from "../utils.js";
import type {
    CompileEventInput,
    CompileEventOutput,
    V8EdgeType,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8NodeRole,
} from "./types.js";
import { deriveBilingualNodeNames } from "./names.js";

const WORKFLOW_PATTERNS = [
    /\bworkflow\b/i,
    /\bsteps?\b/i,
    /\bprocess\b/i,
    /\binstall\b/i,
    /\bdeploy\b/i,
    /\brestore\b/i,
    /\breapply\b/i,
    /\bupdate\b/i,
    /\bpatch\b/i,
    /\bcheck\b/i,
    /\bverify\b/i,
    /流程/,
    /步骤/,
    /安装/,
    /部署/,
    /恢复/,
    /重试/,
    /检查/,
    /验证/,
    /查找/,
    /寻找/,
    /检索/,
    /搜索/,
];
const CONSTRAINT_PATTERNS = [
    /\bmust\b/i,
    /\bmust not\b/i,
    /\bdo not\b/i,
    /\bnever\b/i,
    /\bconstraint\b/i,
    /\bpolicy\b/i,
    /\bprefer(?:ence|red|s)?\b/i,
    /\bdecision\b/i,
    /必须/,
    /不要/,
    /不能/,
    /约束/,
    /规则/,
    /偏好/,
    /决定/,
];
const CHECKPOINT_PATTERNS = [
    /\bcheckpoint\b/i,
    /\bresume\b/i,
    /\bhandoff\b/i,
    /\bnext time\b/i,
    /\bcontinue from\b/i,
    /\bpaused at\b/i,
    /检查点/,
    /恢复点/,
    /交接/,
    /下次/,
    /继续从/,
    /暂停在/,
];
const CONDITION_PATTERNS = [
    /\bif\b/i,
    /\bwhen\b/i,
    /\bonly when\b/i,
    /\bunless\b/i,
    /\bunder\b/i,
    /如果/,
    /当/,
    /只有/,
    /除非/,
    /前提/,
    /条件/,
];
const EVIDENCE_PATTERNS = [
    /\berror\b/i,
    /\bbug\b/i,
    /\broot cause\b/i,
    /\blog\b/i,
    /\bstack\b/i,
    /\btrace\b/i,
    /\bfile\b/i,
    /\bpath\b/i,
    /错误/,
    /报错/,
    /根因/,
    /日志/,
    /文件/,
    /路径/,
];
const PROMPT_NOISE_PATTERNS = [
    /Memory Context \(Live\)/i,
    /End Memory Context/i,
    /Task Ledger/i,
    /Working Memory Rule/i,
    /Last User Request/i,
    /Latest User Request/i,
    /Project Goal/i,
    /Current time:/i,
    /HEARTBEAT_OK/i,
    /Read HEARTBEAT\.md if it exists/i,
    /Priority Shift/i,
    /Session Resume/i,
    /latest message is authoritative for this turn/i,
    /Obey NOW first/i,
    /PREVIOUS ACTIVE -> backlog/i,
    /Do not keep executing the previous active task/i,
    /Follow it strictly\. Do not infer or repeat old tasks/i,
];
const EN_STOP_WORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "there", "here", "then", "than", "when", "where",
    "what", "which", "into", "onto", "about", "just", "only", "also", "will", "would", "could", "should",
    "have", "has", "had", "was", "were", "are", "is", "be", "been", "being", "you", "your", "our", "their",
    "task", "goal", "active", "next", "deferred", "done", "request", "user", "assistant", "system",
]);
const ZH_NOISE_TOKENS = new Set([
    "任务栈", "任务", "目标", "活跃", "下一个", "待办", "延期", "已完成", "用户请求", "最新请求", "系统", "助手",
    "记忆上下文", "工作记忆", "心跳", "时间", "当前时间", "请继续", "继续",
]);
const GENERIC_ACTION_PHRASES = new Set([
    "总结", "继续", "回复", "只回复", "在线吗", "查找", "检索", "搜索", "分析", "处理", "测试", "排查", "重构",
    "summarize", "continue", "reply", "search", "find", "analyze", "process", "test", "debug", "refactor",
]);
const INTENT_ACTION_PATTERNS = [
    /查找/,
    /寻找/,
    /检索/,
    /搜索/,
    /找/,
    /总结/,
    /归纳/,
    /部署/,
    /修复/,
    /回滚/,
    /更新/,
    /测试/,
    /排查/,
    /重构/,
    /阅读/,
    /提取/,
    /分析/,
    /上网/,
    /网上/,
    /\bsearch\b/i,
    /\bfind\b/i,
    /\bsummar(?:ize|y)\b/i,
    /\bdeploy\b/i,
    /\bfix\b/i,
    /\bdebug\b/i,
    /\brefactor\b/i,
    /\bread\b/i,
];
const INTENT_DOMAIN_PATTERNS = [
    /字幕/,
    /积分/,
    /仓库/,
    /项目/,
    /系统/,
    /pdf/i,
    /日志/,
    /网关/,
    /部署/,
    /模型/,
    /图/,
    /记忆/,
    /\brepo\b/i,
    /\bpath\b/i,
    /\berror\b/i,
];
const OBJECT_ANCHOR_PATTERNS = [
    /字幕文件?/,
    /二重积分/,
    /张宇(?:基础)?三十讲(?:第[一二三四五六七八九十\d]+讲)?/,
    /部署手册|deployment guide/i,
    /网关断连|gateway disconnected/i,
    /可视化系统开发|可视化系统/,
    /focus/i,
    /stack/i,
    /图谱|图网|节点|记忆系统/,
    /仓库|repo/i,
    /模型|api|接口/i,
];
const DATA_ANCHOR_PATTERNS = [
    /[A-Za-z]:[\\/][^\s,，。；;]+/,
    /\/(?:mnt|home|var|etc|usr|opt|tmp|data|workspace|downloads)[^\s,，。；;]*/i,
    /[^\s,，。；;\n]{1,40}\.(?:pdf|md|json|jsonl|srt|log|ts|js|py)\b/i,
    /evt_\d{8}_\d+/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /第[一二三四五六七八九十\d]+讲/,
];
const LOCATION_ANCHOR_PATTERNS = [
    /下载目录/,
    /downloads/i,
    /workspace/i,
    /仓库/,
    /目录/,
    /路径/,
    /位置/,
    /D盘|C盘|E盘/,
    /\/mnt\/[a-z]/i,
];
const INTENT_NOISE_PATTERNS = [
    /latest message is authoritative/i,
    /obey now first/i,
    /previous active/i,
    /task ledger/i,
    /session resume/i,
    /working memory rule/i,
    /read heartbeat/i,
    /follow it strictly/i,
    /do not infer or repeat old tasks/i,
    /memory context/i,
];

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function detectLanguage(text: string): "zh" | "en" | "mixed" | "unknown" {
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;

    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > 0 && enCount > 0) return "mixed";
    return zhCount > 0 ? "zh" : "en";
}

function sanitizeMemoryText(text: string, maxChars = 320): string {
    const cleaned = (text || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^[-*]\s*(?:Goal|Updated|Active|Next|Deferred|Done Recently|Last User Request|Latest User Request)\s*:.*$/gim, " ")
        .replace(/^\|.+\|$/gm, " ")
        .replace(/^[\u2500-\u257f┌┐└┘├┤│─]+.*$/gm, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\b(?:User|Asst|Assistant|System)\s*:/gi, " ")
        .replace(/(?:用户|助手|系统)\s*：/g, " ")
        .replace(/\b(?:HEARTBEAT_OK|Read HEARTBEAT\.md if it exists)\b/gi, " ")
        .replace(/\s+/g, " ");
    const withoutNoise = PROMPT_NOISE_PATTERNS.reduce(
        (acc, pattern) => acc.replace(pattern, " "),
        cleaned
    );
    return withoutNoise.trim().slice(0, maxChars);
}

function extractDailyLogFragmentByEventId(markdown: string, eventId: string): string {
    const normalized = (markdown || "").replace(/\r/g, "").trim();
    if (!normalized) return "";
    const marker = `ID: ${eventId}`;
    const sections = normalized
        .split(/\n(?=###\s)/)
        .map((section) => section.trim())
        .filter(Boolean);
    const matched = sections.find((section) => section.includes(marker));
    return matched || "";
}

function stripDailyLogScaffolding(text: string, eventId: string): string {
    if (!text) return "";
    const idPattern = new RegExp(`^.*\\bID:\\s*${eventId}\\b.*$`, "im");
    return sanitizeMemoryText(
        text
            .replace(/^###\s.*$/im, " ")
            .replace(idPattern, " "),
        4000
    );
}

function extractLedgerHints(rawText: string): string[] {
    const raw = rawText || "";
    const candidates = [
        raw.match(/(?:^|\n)\s*-\s*Last User Request\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Active\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Goal\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*NOW\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Now\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Immediate\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*最新用户请求\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*活跃\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*目标\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*现在\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*当前\s*[:：]\s*([^\n]+)/i)?.[1] || "",
    ];
    return candidates
        .map((item) => sanitizeMemoryText(normalizeUserRequest(item, 260), 260))
        .filter(Boolean);
}

function extractExplicitUserTaskFromLedger(rawText: string): string {
    const raw = rawText || "";
    const prioritized = [
        raw.match(/(?:^|\n)\s*-\s*NOW\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Now\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*现在\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*当前\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Last User Request\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Latest User Request\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*最新用户请求\s*[:：]\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*Active\s*:\s*([^\n]+)/i)?.[1] || "",
        raw.match(/(?:^|\n)\s*-\s*活跃\s*[:：]\s*([^\n]+)/i)?.[1] || "",
    ]
        .map((item) => sanitizeMemoryText(normalizeUserRequest(item, 280), 280))
        .filter(Boolean);

    const highSignal = prioritized.find((item) => {
        if (isNoisyIntent(item)) return false;
        if (INTENT_NOISE_PATTERNS.some((pattern) => pattern.test(item))) return false;
        return /(?:查找|寻找|检索|搜索|找|总结|部署|修复|回滚|更新|测试|排查|重构|阅读|提取|分析|上网|网上|不要|不能|必须|search|find|summar)/i.test(item);
    });
    return highSignal || prioritized.find((item) => !isNoisyIntent(item)) || "";
}

function isNoisyIntent(value: string): boolean {
    const text = sanitizeMemoryText(value, 260).toLowerCase();
    if (!text) return true;
    if (PROMPT_NOISE_PATTERNS.some((pattern) => pattern.test(text))) return true;
    if (/(read heartbeat|heartbeat_ok|session resume|task ledger|working memory|existing active task|workspace context|follow it strictly|do not infer|prior chat|old tasks|latest message is authoritative|obey now first|previous active)/i.test(text)) return true;
    if (/^(在线吗|继续|ok|好的|收到)$/i.test(text)) return true;
    return false;
}

function scoreIntentCandidate(value: string): number {
    const text = sanitizeMemoryText(normalizeUserRequest(value, 320), 320);
    if (!text) return -999;
    let score = 0;
    const length = text.length;
    if (length >= 8 && length <= 120) score += 1.2;
    else if (length <= 180) score += 0.4;
    else score -= 1.6;

    const hasAction = INTENT_ACTION_PATTERNS.some((pattern) => pattern.test(text));
    const hasConstraint = /(?:不要|不能|必须|must|must not|do not|never)/i.test(text);
    if (hasAction) score += 1.8;
    if (INTENT_DOMAIN_PATTERNS.some((pattern) => pattern.test(text))) score += 1.1;
    if (PROMPT_NOISE_PATTERNS.some((pattern) => pattern.test(text))) score -= 4.2;
    if (INTENT_NOISE_PATTERNS.some((pattern) => pattern.test(text))) score -= 4.2;
    if (/^(read heartbeat|heartbeat_ok)$/i.test(text)) score -= 6;
    if (!hasAction && !hasConstraint && length <= 16) score -= 0.9;

    const structuralMarkers = (text.match(/(?:##|[-*]\s|:\s|\|)/g) || []).length;
    score -= Math.min(2.8, structuralMarkers * 0.45);

    if (/^(?:请|去|到|先|再|然后|改为|改成|停止|不要|不能)/.test(text)) {
        score += 0.4;
    }
    return score;
}

function resolvePrimaryIntent(rawCandidates: string[]): string {
    const normalized = rawCandidates
        .map((item) => sanitizeMemoryText(normalizeUserRequest(item, 320), 320))
        .filter(Boolean);
    if (normalized.length === 0) return "";

    const scored = normalized
        .map((text, index) => ({
            text,
            score: scoreIntentCandidate(text),
            index,
        }))
        .sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            if (a.index !== b.index) return a.index - b.index;
            return a.text.length - b.text.length;
        });

    if (scored[0] && scored[0].score > -0.6) {
        return scored[0].text;
    }
    const highSignal = normalized.find((item) => !isNoisyIntent(item));
    return highSignal || normalized[0] || "";
}

function takeLeadingClause(text: string, maxChars = 96): string {
    const matched = text.match(/^(.+?)(?:[。！？.!?\n]|$)/u)?.[1]?.trim() || text;
    return matched.slice(0, maxChars).trim();
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function buildBundleTitle(
    event: MemoryEvent,
    normalizedContent: string,
    preferredRequest = ""
): string {
    const fromTask =
        summarizeUserRequestForTask(preferredRequest || event.content, 96) ||
        normalizeUserRequest(preferredRequest || event.content, 96);
    const fromClause = takeLeadingClause(normalizedContent, 96);
    const title = fromTask || fromClause || `${event.type} ${event.id}`;
    return title.slice(0, 96);
}

function extractConversationSlices(content: string): {
    userText: string;
    assistantText: string;
} {
    const raw = content || "";
    const userMatches = [...raw.matchAll(/(?:^|\n)\s*(?:User|用户)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:User|用户|Asst|Assistant|助手)\s*[:：]|$)/gi)];
    const assistantMatches = [...raw.matchAll(/(?:^|\n)\s*(?:Asst|Assistant|助手)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:User|用户|Asst|Assistant|助手)\s*[:：]|$)/gi)];
    const userText = userMatches[userMatches.length - 1]?.[1] || "";
    const assistantText = assistantMatches[assistantMatches.length - 1]?.[1] || "";
    return {
        userText: sanitizeMemoryText(userText, 420),
        assistantText: sanitizeMemoryText(assistantText, 420),
    };
}

function normalizePhrase(value: string, maxChars = 48): string {
    return sanitizeMemoryText(
        value
            .replace(/^[`"'“”‘’《》\[\](){}]+/, "")
            .replace(/[`"'“”‘’《》\[\](){}]+$/, ""),
        maxChars
    );
}

function collectRegexMatches(text: string, pattern: RegExp, maxMatches = 8): string[] {
    if (!text || maxMatches <= 0) return [];
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    const out: string[] = [];
    let match: RegExpExecArray | null = null;

    while ((match = globalPattern.exec(text)) !== null) {
        const value = match[0];
        if (value) out.push(value);
        if (out.length >= maxMatches) break;
        if (match.index === globalPattern.lastIndex) {
            globalPattern.lastIndex++;
        }
    }

    return out;
}

function isNoisyPhrase(value: string): boolean {
    if (!value) return true;
    if (value.length < 2) return true;
    if (/^[\d\s._-]+$/.test(value)) return true;
    if (PROMPT_NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
    if (INTENT_NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
    if (ZH_NOISE_TOKENS.has(value)) return true;
    if (GENERIC_ACTION_PHRASES.has(value.toLowerCase())) return true;
    const lower = value.toLowerCase();
    if (EN_STOP_WORDS.has(lower)) return true;
    if (/[#|*]{2,}|^>\s*/.test(value)) return true;
    if (/[┌┐└┘│]/.test(value)) return true;
    return false;
}

function scorePhrase(value: string, sourceText: string, indexHint: number, typeHint: string): number {
    if (!value) return -999;
    const lowerValue = value.toLowerCase();
    const lowerSource = sourceText.toLowerCase();
    const rawFreq = lowerSource.split(lowerValue).length - 1;
    const freq = rawFreq > 0 ? rawFreq : 1;
    const position = lowerSource.indexOf(lowerValue);
    const positionBoost = position >= 0 ? clamp01(1 - position / Math.max(1, lowerSource.length)) : 0.3;
    const cjkLengthPenalty = /[\u4e00-\u9fff]/.test(value) && value.length > 14 ? 0.7 : 1;
    const longPenalty = value.length > 28 ? 0.6 : 1;
    const typeBoost =
        typeHint === "path" ? 1.35 :
            typeHint === "quoted" ? 1.2 :
                typeHint === "action" ? 1.15 :
                    typeHint === "semantic" ? 1.25 :
                        typeHint === "object" ? 1.32 :
                            typeHint === "data" ? 1.34 :
                                typeHint === "location" ? 1.3 :
                    typeHint === "segment" ? 1.05 : 1.0;
    const domainBoost = /(pdf|srt|json|markdown|repo|github|deploy|patch|openclaw|focus|graph|rebuild|rollback|error|log|二重积分|字幕|部署|回滚|重构|检索|总结|路径|下载目录|workspace|第[一二三四五六七八九十\d]+讲)/i.test(value)
        ? 1.2
        : 1.0;
    const orderPenalty = 1 - Math.min(0.45, indexHint * 0.06);
    return freq * 1.5 * positionBoost * typeBoost * domainBoost * cjkLengthPenalty * longPenalty * orderPenalty;
}

function rerankPhraseScoresWithTextRank(
    cleanedText: string,
    merged: Map<string, { phrase: string; score: number }>
): Array<{ phrase: string; score: number }> {
    const entries = [...merged.entries()];
    if (entries.length <= 1) {
        return entries.map(([, value]) => value);
    }

    const keys = entries.map(([key]) => key);
    const keyIndex = new Map(keys.map((key, index) => [key, index]));
    const contexts = cleanedText
        .split(/[，,。；;、\n]/)
        .map((part) => sanitizeMemoryText(part, 180).toLowerCase())
        .filter(Boolean);

    const graph = Array.from({ length: keys.length }, () => Array(keys.length).fill(0));
    for (const context of contexts) {
        const present = keys.filter((key) => context.includes(key));
        if (present.length < 2) continue;
        for (let i = 0; i < present.length; i++) {
            for (let j = i + 1; j < present.length; j++) {
                const a = keyIndex.get(present[i]);
                const b = keyIndex.get(present[j]);
                if (a === undefined || b === undefined) continue;
                graph[a][b] += 1;
                graph[b][a] += 1;
            }
        }
    }

    const outWeight = graph.map((row) => row.reduce((sum, value) => sum + value, 0));
    let rank = Array(keys.length).fill(1);
    const damping = 0.85;
    const iterations = 18;
    for (let step = 0; step < iterations; step++) {
        const next = Array(keys.length).fill(1 - damping);
        for (let i = 0; i < keys.length; i++) {
            let influence = 0;
            for (let j = 0; j < keys.length; j++) {
                const wji = graph[j][i];
                if (wji <= 0) continue;
                const out = outWeight[j] || 1;
                influence += rank[j] * (wji / out);
            }
            next[i] += damping * influence;
        }
        rank = next;
    }

    const maxRank = Math.max(1e-6, ...rank);
    const avgBase = Math.max(
        1e-6,
        entries.reduce((sum, [, value]) => sum + value.score, 0) / entries.length
    );

    const reranked = entries.map(([key, value], index) => {
        const rankNorm = rank[index] / maxRank;
        return {
            phrase: value.phrase,
            score: value.score + rankNorm * avgBase * 0.6,
        };
    });

    return reranked.sort((a, b) => b.score - a.score);
}

function decomposeTaskPhrases(text: string): string[] {
    const cleaned = sanitizeMemoryText(normalizeUserRequest(text, 480), 480)
        .replace(/[“”"'`]/g, " ")
        .replace(/\s+/g, " ");
    if (!cleaned) return [];

    const chunks = cleaned
        .replace(/(?:并且|并|然后|同时|以及|而且|并行)/g, "，")
        .split(/[，,。；;、\n]/)
        .map((part) =>
            normalizePhrase(
                part
                    .replace(/^(?:请|去|到|先|再|然后|继续|改为|改成|停止(?:刚才的?)?|算了|先别|先不要)\s*/g, "")
                    .replace(/\s+/g, " "),
                80
            )
        )
        .filter(Boolean);

    const picked: string[] = [];
    const push = (value: string) => {
        const phrase = normalizePhrase(value, 48);
        if (!phrase || isNoisyPhrase(phrase)) return;
        picked.push(phrase);
    };

    for (const chunk of chunks) {
        if (/(?:上网|网上|网络|web).*(?:查找|检索|搜索|查|找)|(?:查找|检索|搜索).*(?:网页|网络|互联网|web)/i.test(chunk)) {
            push("上网查找");
        } else if (/(?:查找|寻找|检索|搜索)/.test(chunk)) {
            push("查找");
        }

        if (/(?:详细|完整|不要省略|详尽|全面).*(?:总结|归纳)|(?:总结|归纳).*(?:详细|完整|不要省略|详尽|全面)/.test(chunk)) {
            push("详细总结");
        } else if (/(?:总结|归纳|复盘)/.test(chunk)) {
            push("总结");
        }

        const zhNamedMatches = [
            ...(chunk.match(/张宇(?:基础)?三十讲(?:第[一二三四五六七八九十\d]+讲)?/g) || []),
            ...(chunk.match(/二重积分(?:技巧)?/g) || []),
            ...(chunk.match(/(?:可视化系统开发|可视化系统|系统开发)/g) || []),
            ...(chunk.match(/(?:部署手册|部署指南|deployment guide)/gi) || []),
            ...(chunk.match(/(?:网关断连|gateway disconnected|gateway)/gi) || []),
            ...(chunk.match(/(?:字幕文件|字幕)/g) || []),
            ...(chunk.match(/(?:日志|仓库|项目|模型|图谱|图网|记忆系统)/g) || []),
        ];
        for (const match of zhNamedMatches) {
            push(match);
        }

        const genericMatches =
            chunk.match(/[\u4e00-\u9fff]{2,18}(?:系统开发|系统|项目|课程|教程|讲|积分|字幕文件|字幕|日志|路径|仓库|接口|模型|图谱|工作流)/g) ||
            [];
        for (const match of genericMatches) {
            push(match);
        }

        if (chunk.length >= 3 && chunk.length <= 16 && !/[#:|]/.test(chunk)) {
            push(chunk);
        }
    }

    const deduped: string[] = [];
    for (const phrase of picked) {
        if (deduped.some((item) => item === phrase || item.includes(phrase) || phrase.includes(item))) {
            continue;
        }
        deduped.push(phrase);
        if (deduped.length >= 12) break;
    }
    return deduped;
}

type SemanticAnchors = {
    actions: string[];
    objects: string[];
    data: string[];
    locations: string[];
};

function extractSemanticAnchors(text: string): SemanticAnchors {
    const cleaned = sanitizeMemoryText(normalizeUserRequest(text, 1200), 1200);
    const actions = decomposeTaskPhrases(cleaned).filter((phrase) =>
        /(?:查找|寻找|检索|搜索|上网查找|总结|部署|修复|回滚|更新|测试|排查|重构|阅读|提取|分析)/.test(phrase)
    );

    const collect = (patterns: RegExp[], maxItems = 8): string[] => {
        const out: string[] = [];
        for (const pattern of patterns) {
            const matches = collectRegexMatches(cleaned, pattern, maxItems);
            for (const raw of matches) {
                const phrase = normalizePhrase(raw, 64);
                if (!phrase || isNoisyPhrase(phrase)) continue;
                out.push(phrase);
                if (out.length >= maxItems) break;
            }
            if (out.length >= maxItems) break;
        }
        const deduped: string[] = [];
        for (const item of out) {
            if (deduped.some((value) => value === item || value.includes(item) || item.includes(value))) continue;
            deduped.push(item);
            if (deduped.length >= maxItems) break;
        }
        return deduped;
    };

    const objects = collect(OBJECT_ANCHOR_PATTERNS, 8);
    const data = collect(DATA_ANCHOR_PATTERNS, 8);
    const locations = collect(LOCATION_ANCHOR_PATTERNS, 6);

    return {
        actions,
        objects,
        data,
        locations,
    };
}

function extractCorePhrases(text: string, maxItems = 8): string[] {
    const cleaned = sanitizeMemoryText(normalizeUserRequest(text, 1200), 1200);
    if (!cleaned) return [];

    const candidates: Array<{ phrase: string; type: string; score: number }> = [];
    const pushCandidate = (raw: string, type: string, indexHint: number) => {
        const phrase = normalizePhrase(raw, 60);
        if (isNoisyPhrase(phrase)) return;
        const score = scorePhrase(phrase, cleaned, indexHint, type);
        if (score <= 0) return;
        candidates.push({ phrase, type, score });
    };

    let idx = 0;
    for (const match of cleaned.matchAll(/[“"《](.{2,50}?)[”"》]/g)) {
        pushCandidate(match[1], "quoted", idx++);
    }
    for (const match of cleaned.matchAll(/(?:[A-Za-z]:[\\/][^\s,，。；;]+|\/(?:mnt|home|var|etc|usr|opt|tmp|data|workspace|downloads)[^\s,，。；;]+)/gi)) {
        pushCandidate(match[0], "path", idx++);
    }
    for (const match of cleaned.matchAll(/(?:查找|寻找|检索|搜索|总结|部署|修复|回滚|更新|测试|排查|重构|阅读|提取|分析|学习|复盘)(?:[^，。；;\n]{0,12})/g)) {
        pushCandidate(match[0], "action", idx++);
    }
    for (const match of cleaned.matchAll(/[^\s，。；;\n]{1,20}(?:文件|目录|路径|仓库|项目|系统|模块|日志|字幕|积分|教程|数据库|接口|模型|图谱)/g)) {
        pushCandidate(match[0], "segment", idx++);
    }
    for (const match of cleaned.matchAll(/(?:search|find|summarize|deploy|fix|rollback|update|test|debug|refactor|read|extract|analy[sz]e)\s+[a-z0-9/_-]+(?:\s+[a-z0-9/_-]+){0,2}/ig)) {
        pushCandidate(match[0], "action", idx++);
    }
    const anchors = extractSemanticAnchors(cleaned);
    for (const phrase of decomposeTaskPhrases(cleaned)) {
        pushCandidate(phrase, "semantic", idx++);
    }
    for (const phrase of anchors.objects) {
        pushCandidate(phrase, "object", idx++);
    }
    for (const phrase of anchors.data) {
        pushCandidate(phrase, "data", idx++);
    }
    for (const phrase of anchors.locations) {
        pushCandidate(phrase, "location", idx++);
    }

    const segments = cleaned
        .split(/[，,。；;、\n]/)
        .map((item) => sanitizeMemoryText(item, 60))
        .filter((item) => item.length >= 2);
    for (const segment of segments) {
        if (/[\u4e00-\u9fff]/.test(segment) && segment.length <= 16) {
            pushCandidate(segment, "segment", idx++);
        } else if (/\b[a-z]{3,}\b/i.test(segment) && segment.split(/\s+/).length <= 5) {
            pushCandidate(segment, "segment", idx++);
        }
    }

    const merged = new Map<string, { phrase: string; score: number }>();
    for (const item of candidates) {
        const key = item.phrase.toLowerCase();
        const current = merged.get(key);
        if (!current || item.score > current.score) {
            merged.set(key, { phrase: item.phrase, score: item.score });
        }
    }
    const ranked = rerankPhraseScoresWithTextRank(cleaned, merged);
    const selected: string[] = [];
    for (const item of ranked) {
        const phrase = item.phrase;
        if (selected.some((existing) => existing.includes(phrase) || phrase.includes(existing))) {
            continue;
        }
        selected.push(phrase);
        if (selected.length >= maxItems) break;
    }
    return selected;
}

function extractAssistantEvidence(text: string): string {
    if (!text) return "";
    const cleaned = sanitizeMemoryText(text, 1200);
    if (!cleaned) return "";
    const signals = [
        ...(cleaned.match(/(?:[A-Za-z]:[\\/][^\s,，。；;`]+|\/(?:mnt|home|var|etc|usr|opt|tmp|data|workspace|downloads)[^\s,，。；;`]+)/gi) || []),
        ...(cleaned.match(/(?:error|invalid|not found|timeout|failed|disconnected|报错|失败|不可用|断连|超时|根因|路径)[^，。；;\n]{0,40}/gi) || []),
        ...(cleaned.match(/[^\s,，。；;\n]{1,40}\.(?:pdf|md|json|jsonl|srt|log|ts|js|py)\b/gi) || []),
    ]
        .map((item) => normalizePhrase(item, 80))
        .filter((item) => !isNoisyPhrase(item));

    const deduped = [...new Set(signals)];
    if (deduped.length > 0) {
        return sanitizeMemoryText(deduped.slice(0, 4).join(" ; "), 220);
    }
    const fallback = sanitizeMemoryText(takeLeadingClause(cleaned, 220), 220);
    return isNoisyIntent(fallback) ? "" : fallback;
}

function isLowSignalAutoRecordedEvent(
    event: MemoryEvent,
    userIntentText: string,
    assistantEvidenceText: string,
    sourceText: string
): boolean {
    const tagSet = new Set((event.tags || []).map((tag) => tag.toLowerCase()));
    if (!tagSet.has("auto-recorded")) return false;

    const signalText = `${userIntentText} ${assistantEvidenceText}`;
    const hasStrongSignal = /(?:[A-Za-z]:[\\/]|\/(?:mnt|home|var|etc|usr|opt|tmp|data|workspace|downloads)\/|error|failed|invalid|timeout|报错|失败|不可用|断连|路径|部署|修复|回滚|测试|重构|二重积分|字幕|仓库|repo|github)/i.test(signalText);
    const hasInjectedNoise =
        PROMPT_NOISE_PATTERNS.some((pattern) => pattern.test(sourceText)) ||
        /\b(?:Goal|Active|Next|Deferred|Last User Request|Latest User Request)\b/i.test(sourceText) ||
        /(?:任务栈|焦点栈|工作记忆|记忆上下文)/.test(sourceText);

    return !hasStrongSignal && (hasInjectedNoise || sanitizeMemoryText(userIntentText, 240).length < 18);
}

function pickRolePhrase(
    role: V8NodeRole,
    phrases: string[],
    fallback: string
): string {
    const filtered = phrases
        .map((phrase) => normalizePhrase(phrase, 80))
        .filter((phrase) =>
            phrase &&
            !isNoisyPhrase(phrase) &&
            !INTENT_NOISE_PATTERNS.some((pattern) => pattern.test(phrase)) &&
            !/[#|]{2,}/.test(phrase)
        );
    const joined = filtered.join(" | ");
    if (!joined) return fallback;

    const roleMatchers: Record<V8NodeRole, RegExp[]> = {
        topic: [/系统|项目|课程|主题|积分|pdf|仓库|字幕|网关|日志|workflow|topic/i],
        workflow: [/查找|检索|搜索|上网|网上|网络|web|查|部署|排查|修复|构建|编译|运行|search|deploy|fix|check/i],
        constraint: [/不要|不能|必须|约束|仅|只|must|must not|do not|never/i],
        condition: [/如果|当|前提|条件|unless|if|when|only when/i],
        evidence: [/错误|报错|日志|路径|文件|证据|error|log|path|file|trace/i],
        checkpoint: [/总结|进度|检查点|恢复|交接|完成|summary|checkpoint|resume|handoff/i],
    };

    const matches = filtered.filter((phrase) =>
        roleMatchers[role].some((pattern) => pattern.test(phrase))
    );
    if (matches.length === 0) {
        return fallback;
    }

    const scoreTopicPhrase = (value: string): number => {
        const phrase = normalizePhrase(value, 64);
        if (!phrase || isNoisyPhrase(phrase)) return -999;
        let score = 0;
        if (phrase.length >= 4 && phrase.length <= 14) score += 2.4;
        else if (phrase.length <= 20) score += 1.2;
        else score -= 1.4;
        if (/(?:张宇|二重积分|字幕|部署|网关|可视化|记忆|图网|图谱|仓库|日志|系统|项目|pdf|workflow|repo)/i.test(phrase)) {
            score += 2.2;
        }
        if (/^(?:去|到|改为|改成|不要|停止|只回复|继续|先|再)/.test(phrase)) {
            score -= 2.1;
        }
        if (/[#:|]/.test(phrase)) score -= 1.6;
        return score;
    };

    if (role === "checkpoint") {
        return [...matches].sort((a, b) => a.length - b.length)[0];
    }
    if (role === "topic") {
        return [...matches].sort((a, b) => scoreTopicPhrase(b) - scoreTopicPhrase(a) || a.length - b.length)[0];
    }

    return [...matches].sort((a, b) => a.length - b.length)[0];
}

function extractKeywords(
    text: string,
    tags: string[],
    associations: string[],
    maxItems = 12
): string[] {
    const anchors = extractSemanticAnchors(text);
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const raw = [
        ...tags,
        ...anchors.actions,
        ...englishWords,
        ...cjkChunks,
        ...associations,
        ...anchors.objects,
        ...anchors.data,
        ...anchors.locations,
    ];
    const seen = new Set<string>();
    const keywords: string[] = [];

    for (const item of raw) {
        const normalized = sanitizeMemoryText(item, 48).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        keywords.push(normalized);
        if (keywords.length >= maxItems) break;
    }

    return keywords;
}

function deriveDayKey(event: MemoryEvent): string | null {
    if (event.timestamp && /^\d{4}-\d{2}-\d{2}/.test(event.timestamp)) {
        return event.timestamp.slice(0, 10);
    }
    const idMatch = event.id.match(/^evt_(\d{4})(\d{2})(\d{2})_/);
    if (!idMatch) {
        return null;
    }
    return `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}`;
}

function resolveEventSourceText(workspace: string, event: MemoryEvent): string {
    const dayKey = deriveDayKey(event);
    if (!dayKey) {
        return event.content || "";
    }
    const dailyLogPath = paths(workspace).dailyLog(dayKey);
    const dailyLogContent = readFileOr(dailyLogPath);
    const dailyLogFragment = extractDailyLogFragmentByEventId(dailyLogContent, event.id);
    const cleaned = stripDailyLogScaffolding(dailyLogFragment, event.id);
    return cleaned || dailyLogFragment || event.content || "";
}

function deriveEpisodeKey(
    event: MemoryEvent,
    title: string,
    dayKey: string | null
): string | null {
    const tagSeed = event.tags.find((tag) => tag.trim()) || "";
    const seed = tagSeed || title || event.type || event.id;
    const slug = slugify(seed);
    if (!slug) {
        return dayKey ? `${dayKey}-event` : null;
    }
    return dayKey ? `${dayKey}-${slug}` : slug;
}

function createBundleId(eventId: string): string {
    return `mb_${eventId}`;
}

function createNodeId(eventId: string, role: V8NodeRole): string {
    return `mn_${eventId}_${role}`;
}

function createEdgeId(
    eventId: string,
    srcRole: V8NodeRole,
    dstRole: V8NodeRole,
    type: V8EdgeType
): string {
    return `me_${eventId}_${srcRole}_${type}_${dstRole}`;
}

function shouldAddRole(
    role: V8NodeRole,
    event: MemoryEvent,
    normalizedContent: string
): boolean {
    const text = `${event.type} ${normalizedContent} ${event.tags.join(" ")}`;
    const tagSet = new Set((event.tags || []).map((tag) => tag.toLowerCase()));
    const isAutoRecorded = tagSet.has("auto-recorded");
    switch (role) {
        case "topic":
            return true;
        case "workflow":
            return event.type === "decision" ||
                event.type === "correction" ||
                WORKFLOW_PATTERNS.some((pattern) => pattern.test(text));
        case "constraint":
            return event.type === "decision" ||
                event.type === "preference" ||
                CONSTRAINT_PATTERNS.some((pattern) => pattern.test(text));
        case "condition":
            if (isAutoRecorded) {
                return /(?:如果|当|前提|条件|unless|only when)/i.test(text);
            }
            return CONDITION_PATTERNS.some((pattern) => pattern.test(text));
        case "evidence":
            return event.type === "error" ||
                event.type === "observation" ||
                event.associations.length > 0 ||
                EVIDENCE_PATTERNS.some((pattern) => pattern.test(text));
        case "checkpoint":
            if (isAutoRecorded) {
                return CHECKPOINT_PATTERNS.some((pattern) => pattern.test(text));
            }
            return event.type === "insight" ||
                CHECKPOINT_PATTERNS.some((pattern) => pattern.test(text));
    }
}

function buildRoleText(
    role: V8NodeRole,
    event: MemoryEvent,
    title: string,
    normalizedContent: string,
    userIntentText: string,
    assistantEvidenceText: string,
    intentPhrases: string[]
): string {
    const userFallback = sanitizeMemoryText(userIntentText || normalizedContent, 180) || title;
    const semanticAnchorsUser = extractSemanticAnchors(userFallback);
    const semanticAnchorsAll = extractSemanticAnchors(
        `${userFallback} ${assistantEvidenceText || ""} ${normalizedContent || ""}`
    );
    const compressWorkflowText = (value: string): string => {
        const text = normalizePhrase(value, 120);
        if (!text) return "";
        if (/(?:查找|寻找|检索|搜索|找).*(?:字幕)/.test(text) || /字幕/.test(text)) return "查找字幕文件";
        if (/二重积分/.test(text) && /(?:总结|归纳|复盘)/.test(text)) return "详细总结二重积分";
        if (/(?:部署|安装).*(?:手册|指南)/.test(text)) return "按部署手册安装";
        if (/(?:排查|诊断|修复).*(?:网关|gateway)/i.test(text)) return "排查网关断连";
        if (/(?:查找|寻找|检索|搜索|上网查找)/.test(text)) return "上网查找";
        return normalizePhrase(
            text
                .replace(/^(?:请|去|到|先|再|然后|继续|改为|改成|停止(?:刚才的?)?|算了|先别|先不要)\s*/g, "")
                .replace(/^的+/, "")
                .replace(/[。！？]$/g, ""),
            40
        );
    };
    switch (role) {
        case "topic": {
            const normalizeTopic = (value: string): string =>
                normalizePhrase(
                    value
                        .replace(/张宇(?:基础)?三十讲第[一二三四五六七八九十\d]+讲/g, "张宇基础三十讲")
                        .replace(/^(?:去|到|请)?(?:网上?|上网|网络)?(?:查找|检索|搜索|查)?/g, "")
                        .replace(/^的+/, "")
                        .replace(/(?:并(?:详细)?总结.*|不要省略.*)$/g, ""),
                    64
                );
            const scoreCandidate = (value: string): number => {
                const phrase = normalizeTopic(value);
                if (!phrase || isNoisyPhrase(phrase)) return -999;
                let score = 0;
                if (phrase.length >= 4 && phrase.length <= 14) score += 2.4;
                else if (phrase.length <= 20) score += 1.1;
                else score -= 1.4;
                if (/(?:张宇|二重积分|字幕|部署|网关|可视化|记忆|图网|图谱|仓库|日志|系统|项目|pdf|workflow|repo)/i.test(phrase)) {
                    score += 2.3;
                }
                if (/^(?:去|到|改为|改成|不要|停止|只回复|继续|先|再)/.test(phrase)) score -= 2.2;
                if (/[#:|]/.test(phrase)) score -= 1.8;
                return score;
            };
            const nonCommand = intentPhrases.filter((phrase) =>
                !/^(停止|不要|改为|改成|只回复|回复|继续|先)/.test(phrase) &&
                !/^\d+(?:[./-]|$)/.test(phrase) &&
                !/\.(?:srt|pdf|md|json|jsonl|log|ts|js|py)\b/i.test(phrase)
            );
            const anchorTopic = [
                ...semanticAnchorsUser.objects,
                ...semanticAnchorsUser.locations,
            ]
                .map((item) => normalizeTopic(item))
                .find(Boolean);
            if (anchorTopic) {
                return anchorTopic;
            }
            const scoped = nonCommand.filter((phrase) =>
                /(?:文件|目录|路径|仓库|项目|系统|课程|字幕|积分|pdf|日志|网关|部署|数据库|接口|模型|graph|repo)/i.test(phrase)
            );
            if (scoped.length > 0) {
                return normalizeTopic(
                    [...scoped].sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.length - b.length)[0]
                );
            }
            if (nonCommand.length > 0) {
                return normalizeTopic(
                    [...nonCommand].sort((a, b) => scoreCandidate(b) - scoreCandidate(a) || a.length - b.length)[0]
                );
            }
            return pickRolePhrase("topic", intentPhrases, title);
        }
        case "workflow": {
            const actionAnchor = semanticAnchorsUser.actions.find((item) =>
                !/^(?:不要|不能|别|停止)/.test(item)
            );
            if (actionAnchor) {
                const fromAnchor = compressWorkflowText(actionAnchor);
                if (fromAnchor) return fromAnchor;
            }
            const workflowShort = pickRolePhrase("workflow", intentPhrases, "");
            const compressedWorkflow = compressWorkflowText(workflowShort);
            if (compressedWorkflow && !/^(?:不要|不能|别|停止)/.test(compressedWorkflow)) {
                return compressedWorkflow;
            }
            const decomposed = decomposeTaskPhrases(userFallback).find((phrase) =>
                /(?:查找|寻找|检索|搜索|上网查找|总结|部署|修复|回滚|更新|测试|排查|重构|阅读|提取|分析)/.test(phrase) &&
                !/^(?:不要|不能|别|停止)/.test(phrase)
            );
            if (decomposed) {
                return compressWorkflowText(decomposed);
            }
            return compressWorkflowText(takeLeadingClause(userFallback, 88) || title);
        }
        case "constraint":
            return pickRolePhrase("constraint", intentPhrases, normalizeUserRequest(userFallback, 180) || title);
        case "condition":
            return pickRolePhrase("condition", intentPhrases, "");
        case "evidence":
            {
                const structuredDataAnchors = semanticAnchorsAll.data.filter((item) =>
                    /[\\/]/.test(item) ||
                    /\.(?:pdf|md|json|jsonl|srt|log|ts|js|py)\b/i.test(item) ||
                    /^evt_\d{8}_\d+$/i.test(item) ||
                    /^\d{4}-\d{2}-\d{2}$/.test(item)
                );
                const anchorEvidence = [
                    ...semanticAnchorsAll.locations,
                    ...structuredDataAnchors,
                ];
                if (anchorEvidence.length > 0) {
                    return sanitizeMemoryText(
                        anchorEvidence.slice(0, 5).join(" ; "),
                        220
                    ) || pickRolePhrase("evidence", intentPhrases, userFallback);
                }
                const objectEvidence = semanticAnchorsAll.objects.filter((item) =>
                    /(?:文件|目录|路径|仓库|项目|系统|字幕|积分|pdf|日志|网关|部署|数据库|接口|模型|graph|repo)/i.test(item)
                );
                if (objectEvidence.length > 0) {
                    return sanitizeMemoryText(
                        objectEvidence.slice(0, 3).join(" ; "),
                        220
                    ) || pickRolePhrase("evidence", intentPhrases, userFallback);
                }
            }
            return sanitizeMemoryText(
                assistantEvidenceText ||
                [...semanticAnchorsAll.data, ...semanticAnchorsAll.locations].join(" ; ") ||
                normalizedContent,
                220
            ) || pickRolePhrase("evidence", intentPhrases, userFallback);
        case "checkpoint":
            return pickRolePhrase("checkpoint", intentPhrases, "");
    }
}

function buildNode(
    event: MemoryEvent,
    bundle: V8MemoryBundle,
    role: V8NodeRole,
    text: string,
    sourceSeedText: string,
    language: V8MemoryNode["language"],
    dayKey: string | null,
    episodeKey: string | null
): V8MemoryNode {
    const importance = clamp01(event.importance);
    const baseConfidenceByRole: Record<V8NodeRole, number> = {
        topic: 0.68,
        workflow: 0.76,
        constraint: 0.8,
        condition: 0.62,
        evidence: 0.74,
        checkpoint: 0.78,
    };
    const normalizedText = sanitizeMemoryText(text, role === "evidence" ? 220 : 180);
    const deriveRoleEnglishHint = (nodeRole: V8NodeRole, nodeText: string): string => {
        const value = sanitizeMemoryText(nodeText, 160);
        if (!value) return "";
        if (/字幕/.test(value)) return nodeRole === "workflow" ? "find subtitles" : "subtitle files";
        if (/二重积分/.test(value)) return /总结|归纳|复盘/.test(value) ? "double integral summary" : "double integral";
        if (/可视化/.test(value)) return "visualization";
        if (/部署/.test(value)) return "deployment";
        if (/网关/.test(value)) return "gateway troubleshooting";
        if (/(?:查找|寻找|检索|搜索|上网查找)/.test(value)) return "web search";
        if (/^(?:不要|不能|别|must|do not|never)/i.test(value)) return "constraint";
        if (/日志|报错|错误|路径|文件/.test(value)) return "evidence";
        return "";
    };
    const explicitZhByRole =
        role === "constraint"
            ? normalizePhrase(normalizedText, 48)
            : role === "workflow"
                ? normalizePhrase(normalizedText, 48)
                : role === "topic"
                    ? normalizePhrase(
                        normalizedText
                            .replace(/^(?:memory|mem)\s+/i, "")
                            .replace(/\bmemory\b/ig, "")
                            .replace(/^(?:记忆|记忆系统)\s*/i, "")
                            .replace(/^的+/, ""),
                        48
                    )
                    : "";
    const bilingual = deriveBilingualNodeNames(normalizedText, [
        bundle.title,
        sanitizeMemoryText(sourceSeedText || event.content, 220),
        ...event.tags.filter((tag) => !/^(auto-recorded|semantic-candidate)$/i.test(tag)),
        ...event.associations,
    ], {
        explicitZh: explicitZhByRole,
        explicitEn: deriveRoleEnglishHint(role, normalizedText),
    });

    return {
        id: createNodeId(event.id, role),
        bundleId: bundle.bundleId,
        kind: bundle.kind,
        role,
        names: bilingual.names,
        aliases: bilingual.aliases,
        text: normalizedText,
        summary: takeLeadingClause(normalizedText, 96) || normalizedText,
        keywords: extractKeywords(
            `${event.type} ${normalizedText}`,
            event.tags,
            event.associations
        ),
        language,
        sourceRef: event.id,
        canonicalRef: bundle.canonicalRef,
        confidence: clamp01(Math.max(baseConfidenceByRole[role], importance)),
        importance,
        hitCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        harmCount: 0,
        lastUsedAt: null,
        lastVerifiedAt: event.timestamp || null,
        cooldownUntil: null,
        dayKey,
        episodeKey,
    };
}

function buildEdge(
    event: MemoryEvent,
    srcRole: V8NodeRole,
    dstRole: V8NodeRole,
    type: V8EdgeType,
    srcId: string,
    dstId: string
): V8MemoryEdge {
    const importance = clamp01(event.importance);
    return {
        id: createEdgeId(event.id, srcRole, dstRole, type),
        type,
        src: srcId,
        dst: dstId,
        assocStrength: clamp01(0.55 + importance * 0.3),
        utility: clamp01(0.55 + importance * 0.25),
        trust: clamp01(0.6 + importance * 0.2),
        freshness: 0.9,
        contextFit: 0.75,
        evidenceCount: Math.max(1, event.associations.length),
        activationCount: 0,
        adoptCount: 0,
        rejectCount: 0,
        lastUpdatedAt: event.timestamp,
        lastVerifiedAt: event.timestamp || null,
    };
}

export function compileEventToBundle(
    input: CompileEventInput
): CompileEventOutput {
    const { event, workspace } = input;
    const sourceText = resolveEventSourceText(workspace, event);
    const sourceConversation = extractConversationSlices(sourceText);
    const eventConversation = extractConversationSlices(event.content || "");
    const conversationUserText = eventConversation.userText || sourceConversation.userText;
    const conversationAssistantText = eventConversation.assistantText || sourceConversation.assistantText;
    const ledgerRaw = `${event.content}\n${sourceText}`;
    const ledgerHints = extractLedgerHints(ledgerRaw);
    const explicitLedgerTask = extractExplicitUserTaskFromLedger(ledgerRaw);
    const tagSet = new Set((event.tags || []).map((tag) => tag.toLowerCase()));
    const isAutoRecordedSemantic =
        tagSet.has("auto-recorded") && tagSet.has("semantic-candidate");
    const intentCandidates = isAutoRecordedSemantic && ledgerHints.length > 0
        ? [
            ...ledgerHints,
            conversationUserText,
            sourceText,
            event.content,
        ]
        : [
            conversationUserText,
            ...ledgerHints,
            sourceText,
            event.content,
        ];
    const userIntentText = resolvePrimaryIntent([
        ...intentCandidates,
    ]);
    const finalUserIntentText = isAutoRecordedSemantic && explicitLedgerTask
        ? explicitLedgerTask
        : userIntentText;
    const assistantEvidenceText = extractAssistantEvidence(
        conversationAssistantText || sourceText
    );
    const normalizedContent = sanitizeMemoryText(
        `${finalUserIntentText} ${assistantEvidenceText}`.trim(),
        320
    );
    const intentPhrases = extractCorePhrases(finalUserIntentText, 10);
    const title = buildBundleTitle(
        event,
        finalUserIntentText || normalizedContent,
        finalUserIntentText
    );
    const dayKey = deriveDayKey(event);
    const summaryRef = dayKey ? `memory/${dayKey}.md` : "memory";
    const canonicalRef = dayKey ? `${summaryRef}#${event.id}` : `event#${event.id}`;
    const episodeKey = deriveEpisodeKey(event, title, dayKey);
    const language = detectLanguage(`${title} ${normalizedContent}`);
    const bundleId = createBundleId(event.id);
    const now = event.timestamp;

    const bundle: V8MemoryBundle = {
        bundleId,
        sourceType: "event",
        sourceRef: event.id,
        kind: "episodic",
        title,
        nodeIds: [],
        canonicalRef,
        summaryRef,
        dayKey,
        episodeKey,
        encodingContext: event.encoding_context ?? null,
        createdAt: now,
        updatedAt: now,
    };

    const lowSignalAutoRecorded = isLowSignalAutoRecordedEvent(
        event,
        finalUserIntentText,
        assistantEvidenceText,
        sourceText
    );

    const roles: V8NodeRole[] = ["topic"];
    const orderedOptionalRoles: V8NodeRole[] = lowSignalAutoRecorded
        ? ["evidence"]
        : [
        "workflow",
        "constraint",
        "condition",
        "evidence",
        "checkpoint",
    ];

    for (const role of orderedOptionalRoles) {
        if (shouldAddRole(role, event, normalizedContent)) {
            roles.push(role);
        }
    }

    if (roles.length === 1 && !lowSignalAutoRecorded) {
        roles.push("evidence");
    } else if (
        roles.length === 1 &&
        lowSignalAutoRecorded &&
        assistantEvidenceText &&
        assistantEvidenceText !== finalUserIntentText
    ) {
        roles.push("evidence");
    }

    const uniqueRoles = Array.from(new Set(roles)).slice(0, lowSignalAutoRecorded ? 3 : 6);
    const roleTexts = new Map<V8NodeRole, string>();
    for (const role of uniqueRoles) {
        const drafted = buildRoleText(
            role,
            event,
            title,
            normalizedContent,
            finalUserIntentText,
            assistantEvidenceText,
            intentPhrases
        );
        const normalized = sanitizeMemoryText(drafted, role === "evidence" ? 220 : 180);
        if (!normalized) continue;
        roleTexts.set(role, normalized);
    }
    const fallbackTopic = sanitizeMemoryText(finalUserIntentText || title, 180) || title;
    const topicCandidates = extractCorePhrases(finalUserIntentText || fallbackTopic, 6);
    const topicFromCandidates = topicCandidates.find(
        (item) =>
            !/^(只回复|回复|在线吗|继续|ok|好的|收到)/i.test(item) &&
            !isNoisyPhrase(item) &&
            !INTENT_NOISE_PATTERNS.some((pattern) => pattern.test(item))
    ) || "";
    const initialTopic = roleTexts.get("topic") || fallbackTopic;
    const topicText = /^(只回复|回复|在线吗|继续|ok|好的|收到)/i.test(initialTopic)
        ? (topicFromCandidates || fallbackTopic)
        : initialTopic;
    const cleanedTopicText = normalizePhrase(
        topicText
            .replace(/^(?:memory|mem)\s+/i, "")
            .replace(/\bmemory\b/ig, "")
            .replace(/^(?:记忆|记忆系统)\s*/i, "")
            .replace(/^的+/, ""),
        180
    );
    roleTexts.set("topic", cleanedTopicText || topicText);
    const workflowText = roleTexts.get("workflow") || "";
    const evidenceText = roleTexts.get("evidence") || "";
    if (workflowText && evidenceText) {
        const normalizeDedupeKey = (value: string) =>
            normalizePhrase(value, 200)
                .toLowerCase()
                .replace(/[\s,，。.!?;；:：、'"`“”‘’()\[\]{}\-_/\\]+/g, "");
        const workflowKey = normalizeDedupeKey(workflowText);
        const evidenceKey = normalizeDedupeKey(evidenceText);
        if (
            workflowKey &&
            evidenceKey &&
            (workflowKey.includes(evidenceKey) || evidenceKey.includes(workflowKey))
        ) {
            roleTexts.delete("evidence");
        }
    }

    const filteredRoles: V8NodeRole[] = [];
    const seenRoleText = new Set<string>();
    for (const role of uniqueRoles) {
        const text = roleTexts.get(role);
        if (!text) continue;
        if (role !== "topic" && text === topicText) continue;
        if (/^(只回复|回复|在线吗|继续|ok|好的|收到)/i.test(text)) continue;
        if (role === "checkpoint" && /^(继续|总结|resume|continue|停止|不要|改为|改成)/i.test(text)) continue;
        const normalized = normalizePhrase(text, 180).toLowerCase();
        const dedupeKey = normalized.replace(/[\s,，。.!?;；:：、'"`“”‘’()\[\]{}\-_/\\]+/g, "");
        if (dedupeKey && seenRoleText.has(dedupeKey)) continue;
        if (dedupeKey) seenRoleText.add(dedupeKey);
        filteredRoles.push(role);
    }

    const draftedNodes = filteredRoles.map((role) =>
        buildNode(
            event,
            bundle,
            role,
            roleTexts.get(role) || fallbackTopic,
            sourceText,
            language,
            dayKey,
            episodeKey
        )
    );
    const nodes: V8MemoryNode[] = [];
    const seenNodeName = new Set<string>();
    for (const node of draftedNodes) {
        const dedupeName = node.names.zh || node.names.en || "";
        const dedupeKey = normalizePhrase(dedupeName, 200)
            .toLowerCase()
            .replace(/[\s,，。.!?;；:：、'"`“”‘’()\[\]{}\-_/\\]+/g, "");
        if (dedupeKey && seenNodeName.has(dedupeKey)) continue;
        if (dedupeKey) seenNodeName.add(dedupeKey);
        nodes.push(node);
    }
    bundle.nodeIds = nodes.map((node) => node.id);

    const nodeByRole = new Map(nodes.map((node) => [node.role, node]));
    const edges: V8MemoryEdge[] = [];
    const topicNode = nodeByRole.get("topic");

    if (topicNode) {
        for (const node of nodes) {
            if (node.role === "topic") continue;
            edges.push(
                buildEdge(
                    event,
                    "topic",
                    node.role,
                    "same_topic",
                    topicNode.id,
                    node.id
                )
            );
        }
    }

    const workflowNode = nodeByRole.get("workflow");
    const constraintNode = nodeByRole.get("constraint");
    const conditionNode = nodeByRole.get("condition");
    const checkpointNode = nodeByRole.get("checkpoint");

    if (workflowNode && constraintNode) {
        edges.push(
            buildEdge(
                event,
                "workflow",
                "constraint",
                "constraint",
                workflowNode.id,
                constraintNode.id
            )
        );
    }

    if (conditionNode && workflowNode) {
        edges.push(
            buildEdge(
                event,
                "condition",
                "workflow",
                "valid_when",
                conditionNode.id,
                workflowNode.id
            )
        );
    }

    if (workflowNode && checkpointNode) {
        edges.push(
            buildEdge(
                event,
                "workflow",
                "checkpoint",
                "workflow_next",
                workflowNode.id,
                checkpointNode.id
            )
        );
    }

    return { bundle, nodes, edges };
}
