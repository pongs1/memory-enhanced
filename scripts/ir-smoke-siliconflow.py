#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent


ROOT = Path(__file__).resolve().parent.parent
TMP_DIR = ROOT / ".tmp" / "ir-smoke"
DEFAULT_MODEL = "Pro/zai-org/GLM-4.7"
DEFAULT_URL = "https://api.siliconflow.cn/v1/chat/completions"


SAMPLES = [
    {
        "id": "proxy_diagnosis_meso",
        "layer": "meso",
        "path": ".memory/raw/observations/assembled/session_e17be7df-0508-4081-8b09-164e587f0dfe_narrative.md",
        "line_start": 141,
        "line_end": 220,
        "speaker": "assistant",
        "timestamp": "2026-03-06 14:52",
        "source_category": "conversation",
        "unit_id": "sample_proxy_diagnosis_meso",
        "evidence_spans": [
            "问题出在 Telegram 媒体文件下载失败。",
            "curl 可以正常访问同一个 URL，但 Node.js 的 fetch() 失败。",
            "即使设置了 HTTP_PROXY 和 HTTPS_PROXY，Node.js 的 fetch 仍然失败。",
            "这说明根本原因更像是 Node.js 18+ 的 fetch 默认不读取代理环境变量。",
            "建议后续用 undici 或 node-fetch 的代理支持来修复。",
        ],
    },
    {
        "id": "telegram_channel_logs_meso",
        "layer": "meso",
        "path": ".memory/raw/observations/assembled/session_focus-clean-20260310-b_narrative.md",
        "line_start": 40,
        "line_end": 135,
        "speaker": "assistant",
        "timestamp": "2026-03-10 04:17",
        "source_category": "conversation",
        "unit_id": "sample_telegram_logs_meso",
        "evidence_spans": [
            "日志显示 Telegram 频道一直在重试连接。",
            "Telegram command sync failed: HttpError: Network request for 'setMyCommands' failed!",
            "日志显示 Telegram 频道一直在网络请求失败。",
            "发现了关键信息！日志显示有多次 Connection error 错误发生在 agent/embedded 子系统中。",
            "这是 heartbeat cron job 调用 LLM 时的连接错误，不是网关 WebSocket 断连。",
        ],
    },
    {
        "id": "plugin_status_meso",
        "layer": "meso",
        "path": ".memory/raw/observations/assembled/session_a3dacd1d-dc02-4c01-ac29-d56bfe8d3154_narrative.md",
        "line_start": 1,
        "line_end": 80,
        "speaker": "assistant",
        "timestamp": "2026-03-06 13:56",
        "source_category": "conversation",
        "unit_id": "sample_plugin_status_meso",
        "evidence_spans": [
            "Memory Enhanced 插件已经加载并正在运行。",
            "状态：loaded（已加载）",
            "有 3 条未整合的事件需要处理。",
            "知识库有 4 个领域文件，8 条条目。",
            ".memory/archive 目录缺失，但这不影响正常使用。",
        ],
    },
    {
        "id": "proxy_root_cause_micro",
        "layer": "micro",
        "path": ".memory/raw/observations/assembled/session_e17be7df-0508-4081-8b09-164e587f0dfe_narrative.md",
        "line_start": 309,
        "line_end": 318,
        "speaker": "assistant",
        "timestamp": "2026-03-06 14:53",
        "source_category": "conversation",
        "unit_id": "sample_proxy_root_cause_micro",
        "evidence_spans": [
            "问题出在 Node.js 18+ 的 fetch() 默认不支持 HTTP 代理环境变量。",
            "虽然系统设置了 HTTP_PROXY/HTTPS_PROXY，但 Node.js 的 fetch 会直接连接，不经过代理。",
            "导致在需要代理才能访问外网的环境下失败。",
        ],
    },
]


PROMPT_META = {
    "micro": {
        "relations": "after, before, better_than, causes, conditioned_on, conflicts_with, contradicts, evidenced_by, grounded_by, is_a, part_of, prevents, produces, requires, supports, uses, worse_than",
        "item_types": "entity, concept, method, event, attribute, metric, claim, evidence, context, discourse_unit",
        "hard_cap": 8,
        "extra": [
            "Extract only local, directly stated memory facts.",
            "Prefer concrete entity-action-object, attribute, comparison, condition, support, contradiction, or explicit user control signals.",
            "Do not abstract across multiple turns here.",
        ],
    },
    "meso": {
        "relations": "blocks, centered_on, constrains, driven_by, enables, escalates_to, evidenced_by, follows, hindered_by, improves, leads_to, motivates, organized_as, reframes, replaced_by, resolved_by, results_in, scoped_to, stabilizes, supported_by, triggers, validates",
        "item_types": "scene_block, situation_frame, objective_block, problem_block, strategy_block, procedure_block, interaction_block, decision_block, evidence_frame, shift_block, outcome_block, block_function",
        "hard_cap": 6,
        "extra": [
            "Extract mid-range structure from a coherent local block.",
            "Prefer decisions, goals, constraints, strategy shifts, problem/solution framing, evidence-backed state changes, and interaction structure.",
            "Do not repeat every micro fact; compress to the block-level relation that matters for later recall.",
        ],
    },
}


def build_prompt(sample: dict) -> str:
    layer = sample["layer"]
    meta = PROMPT_META[layer]
    text = read_excerpt(ROOT / sample["path"], sample["line_start"], sample["line_end"])
    spans = "\n".join(
        f"- (es_{sample['id']}_{idx + 1}) {span}"
        for idx, span in enumerate(sample["evidence_spans"])
    )
    lines = [
        "Please extract only evidence-backed relations from the batched units below.",
        "If nothing can be extracted, output `[]` only.",
        "",
        "Primary objective:",
        "- Capture high-value memory facts for future recall: decisions, constraints, goals, preference shifts, state changes, and stable entity relations.",
        "- Avoid noisy restatements and avoid splitting one fact into many near-duplicate items.",
        *[f"- {line}" for line in meta["extra"]],
        "",
        "Rules:",
        "- Use only the relations listed under Allowed relations.",
        "- Do not infer beyond the text; skip vague or speculative claims.",
        "- In noisy tool output, prefer the stable chain: observation -> diagnosis -> verification -> applied fix -> outcome.",
        "- Preserve the source language for subject/object labels unless translation is explicitly required by the text.",
        f"- Hard cap: output at most {meta['hard_cap']} items for this batch.",
        "- `evidence_span_ids` must come from the provided evidence spans.",
        f"- `unit_id` must be `{sample['unit_id']}`.",
        "- Output Markdown only. No JSON. No extra commentary.",
        "",
        "Qualifier guidance:",
        "- When useful, use qualifiers to mark epistemic and operational role instead of inventing extra relations.",
        "- Preferred qualifiers: epistemic_status=observed|hypothesized|verified|applied; operation_role=observation|diagnosis|verification|fix|outcome; durability=transient|durable.",
        "- Do not mark a diagnosis as verified or durable unless the evidence directly shows confirmation or successful application.",
        "",
        "Output format:",
        "### Item",
        "item_type: <type>",
        "subject: <text>",
        "predicate: <relation>",
        "object: <text>",
        "qualifiers: key=value; key=value (leave blank if none)",
        "origin_type: asserted|aggregated|inferred",
        "evidence_span_ids: es_xxx, es_yyy",
        f"unit_id: {sample['unit_id']}",
        "confidence: 0.0-1.0",
        "",
        f"Allowed relations ({layer}): {meta['relations']}",
        f"Allowed item_type ({layer}): {meta['item_types']}",
        "",
        "### Batch",
        f"Layer: {layer}",
        f"Unit IDs: {sample['unit_id']}",
        "",
        f"#### Unit {sample['unit_id']}",
        f"speaker: {sample['speaker']}",
        f"timestamp: {sample['timestamp']}",
        f"source_category: {sample['source_category']}",
        text.strip(),
        "evidence_spans:",
        spans,
    ]
    return "\n".join(lines)


def read_excerpt(path: Path, line_start: int, line_end: int) -> str:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    start = max(1, int(line_start))
    end = min(len(lines), int(line_end))
    return "\n".join(lines[start - 1 : end])


def call_model(prompt: str, api_key: str, model: str, api_url: str, max_tokens: int) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    env = {k: v for k, v in os.environ.items() if k.lower() not in {
        "http_proxy", "https_proxy", "all_proxy", "no_proxy"
    }}
    proc = subprocess.run(
        [
            "curl",
            "--connect-timeout",
            "15",
            "--max-time",
            "90",
            "-sS",
            "--request",
            "POST",
            "--url",
            api_url,
            "-H",
            "Content-Type: application/json",
            "-H",
            f"Authorization: Bearer {api_key}",
            "-d",
            json.dumps(body, ensure_ascii=False),
        ],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"curl failed ({proc.returncode})")
    return json.loads(proc.stdout)


def extract_content(resp: dict) -> str:
    return str(resp["choices"][0]["message"]["content"]).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", action="append", help="Sample id to run")
    parser.add_argument("--model", default=os.environ.get("SILICONFLOW_MODEL", DEFAULT_MODEL))
    parser.add_argument("--api-url", default=os.environ.get("SILICONFLOW_URL", DEFAULT_URL))
    parser.add_argument("--api-key", default=os.environ.get("SILICONFLOW_API_KEY", ""))
    parser.add_argument("--max-tokens", type=int, default=420)
    args = parser.parse_args()

    if not args.api_key:
        print("Missing --api-key or SILICONFLOW_API_KEY", file=sys.stderr)
        return 1

    selected = SAMPLES
    if args.sample:
        wanted = set(args.sample)
        selected = [sample for sample in SAMPLES if sample["id"] in wanted]

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    for sample in selected:
        prompt = build_prompt(sample)
        prompt_path = TMP_DIR / f"{sample['id']}.prompt.md"
        response_path = TMP_DIR / f"{sample['id']}.response.json"
        answer_path = TMP_DIR / f"{sample['id']}.answer.md"
        prompt_path.write_text(prompt, encoding="utf-8")
        try:
            resp = call_model(prompt, args.api_key, args.model, args.api_url, args.max_tokens)
            response_path.write_text(json.dumps(resp, ensure_ascii=False, indent=2), encoding="utf-8")
            content = extract_content(resp)
            answer_path.write_text(content + "\n", encoding="utf-8")
            summary.append({
                "sample": sample["id"],
                "layer": sample["layer"],
                "status": "ok",
                "answer_path": str(answer_path.relative_to(ROOT)),
            })
            print(f"[ok] {sample['id']} -> {answer_path.relative_to(ROOT)}")
        except Exception as exc:
            summary.append({
                "sample": sample["id"],
                "layer": sample["layer"],
                "status": "error",
                "error": str(exc),
            })
            print(f"[error] {sample['id']}: {exc}", file=sys.stderr)

    (TMP_DIR / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0 if all(item["status"] == "ok" for item in summary) else 2


if __name__ == "__main__":
    raise SystemExit(main())
