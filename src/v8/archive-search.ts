import * as fs from "node:fs";
import { v8StorePaths } from "./paths_v8.js";
import type { V8EvidenceSpan } from "./types_v8.js";

type SearchMode = "hybrid" | "bm25" | "vector";

interface SpanDoc {
    span: V8EvidenceSpan;
    tokens: string[];
    tf: Map<string, number>;
    tfidf: Map<string, number>;
    norm: number;
}

interface SpanSearchIndex {
    mtime: number;
    avgDocLen: number;
    idf: Map<string, number>;
    docs: SpanDoc[];
    narrativeCache: Map<string, string>;
}

export interface SearchArchiveSpansOptions {
    workspace: string;
    query: string;
    topK?: number;
    mode?: SearchMode;
    bm25Weight?: number;
    vectorWeight?: number;
    windowChars?: number;
}

export interface SearchArchiveSpanResult {
    spanId: string;
    score: number;
    bm25Score: number;
    vectorScore: number;
    speaker: V8EvidenceSpan["speaker"];
    timestamp: string | null;
    narrativeRef: string;
    unitId: string;
    charStart: number;
    charEnd: number;
    spanText: string;
    rawText: string;
}

const DEFAULT_TOP_K = 8;
const DEFAULT_WINDOW_CHARS = 260;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const indexCache = new Map<string, SpanSearchIndex>();

export function searchArchiveSpans(
    options: SearchArchiveSpansOptions
): SearchArchiveSpanResult[] {
    const query = options.query.trim();
    if (!query) return [];
    const mode = options.mode || "hybrid";
    const topK = Math.max(1, Math.min(30, options.topK || DEFAULT_TOP_K));
    const windowChars = Math.max(80, Math.min(1200, options.windowChars || DEFAULT_WINDOW_CHARS));
    const bm25Weight = options.bm25Weight ?? 0.55;
    const vectorWeight = options.vectorWeight ?? 0.45;

    const index = loadOrBuildIndex(options.workspace);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || index.docs.length === 0) return [];

    const queryTf = buildTf(queryTokens);
    const queryTfidf = buildTfidf(queryTf, index.idf);
    const queryNorm = l2Norm(queryTfidf);

    const scored = index.docs.map((doc) => {
        const bm25Score = scoreBm25(doc, queryTf, index);
        const vectorScore = queryNorm > 0 ? scoreVector(doc, queryTfidf, queryNorm) : 0;
        let score = 0;
        if (mode === "bm25") {
            score = bm25Score;
        } else if (mode === "vector") {
            score = vectorScore;
        } else {
            score = bm25Weight * bm25Score + vectorWeight * vectorScore;
        }
        return { doc, score, bm25Score, vectorScore };
    });

    const positive = scored.filter((item) => item.score > 0);
    positive.sort((a, b) => b.score - a.score);

    return positive.slice(0, topK).map((item) => {
        const span = item.doc.span;
        const rawText = readRawSlice(index, span, windowChars);
        return {
            spanId: span.id,
            score: item.score,
            bm25Score: item.bm25Score,
            vectorScore: item.vectorScore,
            speaker: span.speaker,
            timestamp: span.timestamp,
            narrativeRef: span.narrativeRef,
            unitId: span.unitId,
            charStart: span.charStart,
            charEnd: span.charEnd,
            spanText: span.text,
            rawText,
        };
    });
}

function loadOrBuildIndex(workspace: string): SpanSearchIndex {
    const store = v8StorePaths(workspace);
    const mtime = readMtime(store.evidenceSpans);
    const cached = indexCache.get(store.evidenceSpans);
    if (cached && cached.mtime === mtime) return cached;

    const spans = loadJsonl<V8EvidenceSpan>(store.evidenceSpans);
    const docs: SpanDoc[] = [];
    const df = new Map<string, number>();
    let totalDocLen = 0;

    for (const span of spans) {
        const text = sanitizeText(span.text);
        if (!text) continue;
        const tokens = tokenize(text);
        if (tokens.length === 0) continue;
        const tf = buildTf(tokens);
        const unique = new Set(tokens);
        for (const token of unique) {
            df.set(token, (df.get(token) || 0) + 1);
        }
        totalDocLen += tokens.length;
        docs.push({
            span,
            tokens,
            tf,
            tfidf: new Map(),
            norm: 0,
        });
    }

    const N = Math.max(1, docs.length);
    const idf = new Map<string, number>();
    for (const [token, freq] of df.entries()) {
        const value = Math.log(1 + (N - freq + 0.5) / (freq + 0.5));
        idf.set(token, value);
    }

    for (const doc of docs) {
        const tfidf = buildTfidf(doc.tf, idf);
        doc.tfidf = tfidf;
        doc.norm = l2Norm(tfidf);
    }

    const index: SpanSearchIndex = {
        mtime,
        avgDocLen: docs.length > 0 ? totalDocLen / docs.length : 1,
        idf,
        docs,
        narrativeCache: new Map(),
    };
    indexCache.set(store.evidenceSpans, index);
    return index;
}

function scoreBm25(
    doc: SpanDoc,
    queryTf: Map<string, number>,
    index: SpanSearchIndex
): number {
    const dl = doc.tokens.length || 1;
    let score = 0;
    for (const token of queryTf.keys()) {
        const tf = doc.tf.get(token) || 0;
        if (tf === 0) continue;
        const idf = index.idf.get(token) || 0;
        const num = tf * (BM25_K1 + 1);
        const den = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / index.avgDocLen));
        score += idf * (num / den);
    }
    return score;
}

function scoreVector(
    doc: SpanDoc,
    queryTfidf: Map<string, number>,
    queryNorm: number
): number {
    if (doc.norm === 0 || queryNorm === 0) return 0;
    let dot = 0;
    for (const [token, weight] of queryTfidf.entries()) {
        const docWeight = doc.tfidf.get(token);
        if (!docWeight) continue;
        dot += weight * docWeight;
    }
    return dot / (queryNorm * doc.norm);
}

function buildTf(tokens: string[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const token of tokens) {
        map.set(token, (map.get(token) || 0) + 1);
    }
    return map;
}

function buildTfidf(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
    const map = new Map<string, number>();
    for (const [token, freq] of tf.entries()) {
        const w = (idf.get(token) || 0) * freq;
        if (w > 0) map.set(token, w);
    }
    return map;
}

function l2Norm(weights: Map<string, number>): number {
    let sum = 0;
    for (const value of weights.values()) {
        sum += value * value;
    }
    return Math.sqrt(sum);
}

function tokenize(text: string): string[] {
    const en = text.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
    const cjk = text.match(/[\u4e00-\u9fff]{1,}/g) || [];
    const grams: string[] = [];
    for (const chunk of cjk) {
        if (chunk.length <= 4) {
            grams.push(chunk);
            continue;
        }
        for (let i = 0; i < chunk.length - 1; i += 1) {
            grams.push(chunk.slice(i, i + 2));
        }
    }
    return [...en, ...grams];
}

function sanitizeText(text: string): string {
    return (text || "")
        .replace(/\s+/g, " ")
        .replace(/<!--[\\s\\S]*?-->/g, " ")
        .trim();
}

function readRawSlice(index: SpanSearchIndex, span: V8EvidenceSpan, windowChars: number): string {
    const ref = span.narrativeRef;
    const raw = readNarrative(index, ref);
    if (!raw) return span.text;
    const start = Math.max(0, span.charStart - Math.floor(windowChars / 3));
    const end = Math.min(raw.length, span.charEnd + Math.floor((windowChars * 2) / 3));
    return sanitizeText(raw.slice(start, end));
}

function readNarrative(index: SpanSearchIndex, ref: string): string {
    const cached = index.narrativeCache.get(ref);
    if (cached !== undefined) return cached;
    try {
        const raw = fs.readFileSync(ref, "utf-8");
        index.narrativeCache.set(ref, raw);
        return raw;
    } catch {
        index.narrativeCache.set(ref, "");
        return "";
    }
}

function loadJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function readMtime(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}
