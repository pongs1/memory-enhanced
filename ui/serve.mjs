/**
 * ui/serve.mjs  — Tiny zero-dep HTTP server for Memory Graph UI
 * Usage (from repo root):  node ui/serve.mjs [port]
 * WSL: node /mnt/d/E/memory_sys_design/memory-enhanced/ui/serve.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.argv[2] || 7842;

// Resolve graph data: prefer real workspace data, fall back to fixtures
function resolveDataDir(workspace) {
  const real = path.join(workspace, ".memory", "graph");
  if (fs.existsSync(real)) return real;
  return path.join(__dirname, "fixtures");
}

function resolveSnapshotsDir(workspace) {
  const real = path.join(workspace, ".memory", "graph", "snapshots");
  if (fs.existsSync(real)) return real;
  return path.join(workspace, ".memory", "graph_snapshots");
}

// Try to detect workspace: prefer known WSL path, then env, then walk up
function detectWorkspace() {
  const wslNeuro = "/home/pongs/.openclaw/workspace-neuro";
  if (fs.existsSync(wslNeuro)) return wslNeuro;
  const env = process.env.WORKSPACE_DIR;
  if (env && fs.existsSync(env)) return env;
  // Walk up from CWD
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, ".memory"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const WORKSPACE = detectWorkspace();
const DATA_DIR = resolveDataDir(WORKSPACE);
const SNAPSHOTS_DIR = resolveSnapshotsDir(WORKSPACE);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function serveJson(res, data) {
  cors(res);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API routes ──────────────────────────────────────────────

  if (pathname === "/api/graph") {
    const manifestPath = path.join(DATA_DIR, "manifest.json");
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
      : {};

    // Normalise nodes: real schema uses `kind` instead of `layer`,
    // `names.en` for display, and `hitCount/adoptCount/harmCount` as counts
    const normalizeNode = (n, layer) => ({
      id:         n.id,
      layer:      n.kind || layer,
      role:       n.role,
      summary:    n.names?.en || n.summary || n.text || n.id,
      sourceRef:  n.canonicalRef || n.sourceRef,
      hit:        n.hitCount   ?? n.hit   ?? 0,
      adopt:      n.adoptCount ?? n.adopt ?? 0,
      harm:       n.harmCount  ?? n.harm  ?? 0,
      importance: n.importance ?? 0.5,
      tags:       n.keywords   || n.tags  || [],
      bundleId:   n.bundleId,
      dayKey:     n.dayKey,
    });

    // Normalise edges: real schema uses `src`/`dst` instead of `source`/`target`
    const normalizeEdge = (e, type) => ({
      source: e.source || e.src,
      target: e.target || e.dst,
      weight: e.assocStrength ?? e.weight ?? 0.5,
      label:  e.type || type,
      type,
    });

    const nodes = [
      ...parseJsonl(path.join(DATA_DIR, "nodes_episodic.jsonl")).map(n => normalizeNode(n, "episodic")),
      ...parseJsonl(path.join(DATA_DIR, "nodes_semantic.jsonl")).map(n => normalizeNode(n, "semantic")),
      ...parseJsonl(path.join(DATA_DIR, "nodes_procedural.jsonl")).map(n => normalizeNode(n, "procedural")),
    ];
    const edges = [
      ...parseJsonl(path.join(DATA_DIR, "edges_associative.jsonl")).map(e => normalizeEdge(e, "associative")),
      ...parseJsonl(path.join(DATA_DIR, "edges_structural.jsonl")).map(e => normalizeEdge(e, "structural")),
      ...parseJsonl(path.join(DATA_DIR, "edges_supersession.jsonl")).map(e => normalizeEdge(e, "supersession")),
    ];
    return serveJson(res, { manifest, nodes, edges, dataDir: DATA_DIR });
  }

  if (pathname === "/api/snapshots") {
    const dirs = [];
    // Check both graph_snapshots/ and graph/snapshots/
    const snap1 = path.join(WORKSPACE, ".memory", "graph_snapshots");
    const snap2 = path.join(WORKSPACE, ".memory", "graph", "snapshots");
    for (const snapDir of [snap1, snap2]) {
      if (!fs.existsSync(snapDir)) continue;
      fs.readdirSync(snapDir)
        .filter(d => fs.statSync(path.join(snapDir, d)).isDirectory())
        .forEach(d => dirs.push(d));
    }
    return serveJson(res, [...new Set(dirs)].sort());
  }

  if (pathname.startsWith("/api/diff/")) {
    const rebuild = decodeURIComponent(pathname.replace("/api/diff/", ""));
    // Check both graph_snapshots/ and graph/snapshots/
    const snapBase1 = path.join(WORKSPACE, ".memory", "graph_snapshots", rebuild);
    const snapBase2 = path.join(WORKSPACE, ".memory", "graph", "snapshots", rebuild);
    const base = fs.existsSync(snapBase1) ? snapBase1 : snapBase2;

    const normalizeNode = (n, layer) => ({
      id: n.id, layer: n.kind || layer, summary: n.names?.en || n.summary || n.id,
    });
    const normalizeEdge = (e, type) => ({
      source: e.source || e.src, target: e.target || e.dst, type,
    });

    const load = (sub) => {
      const dir = path.join(base, sub);
      if (!fs.existsSync(dir)) return { nodes: [], edges: [] };
      return {
        nodes: [
          ...parseJsonl(path.join(dir, "nodes_episodic.jsonl")).map(n => normalizeNode(n, "episodic")),
          ...parseJsonl(path.join(dir, "nodes_semantic.jsonl")).map(n => normalizeNode(n, "semantic")),
          ...parseJsonl(path.join(dir, "nodes_procedural.jsonl")).map(n => normalizeNode(n, "procedural")),
        ],
        edges: [
          ...parseJsonl(path.join(dir, "edges_associative.jsonl")).map(e => normalizeEdge(e, "associative")),
          ...parseJsonl(path.join(dir, "edges_structural.jsonl")).map(e => normalizeEdge(e, "structural")),
        ],
      };
    };
    return serveJson(res, { pre: load("pre_rebuild"), post: load("post_rebuild") });
  }

  // ── Static files ─────────────────────────────────────────────

  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(__dirname, filePath);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    cors(res);
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  cors(res);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n  🧠 Memory Graph UI`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  Data Dir: ${DATA_DIR}`);
  console.log(`  Workspace: ${WORKSPACE}\n`);
});
