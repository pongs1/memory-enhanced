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
  return path.join(workspace, ".memory", "graph_snapshots");
}

// Try to detect workspace from env or walk up
function detectWorkspace() {
  const env = process.env.WORKSPACE_DIR;
  if (env && fs.existsSync(env)) return env;
  // Walk up from CWD looking for .memory dir
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
    const manifest = JSON.parse(
      fs.existsSync(path.join(DATA_DIR, "manifest.json"))
        ? fs.readFileSync(path.join(DATA_DIR, "manifest.json"), "utf-8")
        : "{}"
    );
    const nodes = [
      ...parseJsonl(path.join(DATA_DIR, "nodes_episodic.jsonl")).map((n) => ({ ...n, layer: "episodic" })),
      ...parseJsonl(path.join(DATA_DIR, "nodes_semantic.jsonl")).map((n) => ({ ...n, layer: "semantic" })),
      ...parseJsonl(path.join(DATA_DIR, "nodes_procedural.jsonl")).map((n) => ({ ...n, layer: "procedural" })),
    ];
    const edges = [
      ...parseJsonl(path.join(DATA_DIR, "edges_associative.jsonl")).map((e) => ({ ...e, type: "associative" })),
      ...parseJsonl(path.join(DATA_DIR, "edges_structural.jsonl")).map((e) => ({ ...e, type: "structural" })),
      ...parseJsonl(path.join(DATA_DIR, "edges_supersession.jsonl")).map((e) => ({ ...e, type: "supersession" })),
    ];
    return serveJson(res, { manifest, nodes, edges, dataDir: DATA_DIR });
  }

  if (pathname === "/api/snapshots") {
    if (!fs.existsSync(SNAPSHOTS_DIR)) return serveJson(res, []);
    const rebuilds = fs.readdirSync(SNAPSHOTS_DIR).filter((d) =>
      fs.statSync(path.join(SNAPSHOTS_DIR, d)).isDirectory()
    );
    return serveJson(res, rebuilds);
  }

  if (pathname.startsWith("/api/diff/")) {
    const rebuild = pathname.replace("/api/diff/", "");
    const base = path.join(SNAPSHOTS_DIR, rebuild);
    const load = (sub) => {
      const dir = path.join(base, sub);
      if (!fs.existsSync(dir)) return { nodes: [], edges: [] };
      return {
        nodes: [
          ...parseJsonl(path.join(dir, "nodes_episodic.jsonl")).map((n) => ({ ...n, layer: "episodic" })),
          ...parseJsonl(path.join(dir, "nodes_semantic.jsonl")).map((n) => ({ ...n, layer: "semantic" })),
          ...parseJsonl(path.join(dir, "nodes_procedural.jsonl")).map((n) => ({ ...n, layer: "procedural" })),
        ],
        edges: [
          ...parseJsonl(path.join(dir, "edges_associative.jsonl")).map((e) => ({ ...e, type: "associative" })),
          ...parseJsonl(path.join(dir, "edges_structural.jsonl")).map((e) => ({ ...e, type: "structural" })),
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
