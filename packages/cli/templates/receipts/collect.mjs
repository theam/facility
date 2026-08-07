#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set([
  "architect",
  "builder",
  "review",
  "address_review",
  "ci_doctor",
  "security_sweep",
  "po",
  "learning",
  "canary",
  "custom",
]);
const PROVIDERS = new Set(["claude_code", "codex_cli", "byo"]);
const MAX_RECEIPT_CHECKS = 200;

export function collectReceipt(env = process.env, now = new Date()) {
  const provider = requiredChoice(env.FACILITY_RECEIPT_PROVIDER, PROVIDERS, "provider");
  const mode = requiredChoice(env.FACILITY_RECEIPT_MODE, MODES, "mode");
  const result = normalizeResult(env.FACILITY_RECEIPT_RESULT);
  const startedAt = validDate(env.FACILITY_RECEIPT_STARTED_AT) ?? now;
  const engine = parseEngineEvidence(env.FACILITY_RECEIPT_ENGINE_JSONL);
  const checkEvidence = parseChecks(env.FACILITY_RECEIPT_CHECKS_FILE);
  const target = githubTarget(env.GITHUB_EVENT_PATH);
  const git = gitActivity(env.FACILITY_RECEIPT_BASE_SHA, env.GITHUB_WORKSPACE);
  const actor = env.GITHUB_ACTOR;
  const receipt = {
    schema: "facility.run.v1",
    run_id: [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB].filter(Boolean).join(":"),
    provider,
    ...(env.FACILITY_RECEIPT_MODEL ? { model: env.FACILITY_RECEIPT_MODEL } : {}),
    mode,
    result,
    usage: {
      input_tokens: engine.usage.input_tokens,
      output_tokens: engine.usage.output_tokens,
      cache_read: engine.usage.cache_read,
      cache_write: engine.usage.cache_write,
      cost_cents: engine.usage.cost_cents,
      cost_source: engine.usage.cost_source,
    },
    activity: {
      turns: engine.activity.turns,
      shell_commands: engine.activity.shell_commands,
      file_changes: Math.max(engine.activity.file_changes, git.filesChanged),
      mcp_tool_calls: engine.activity.mcp_tool_calls,
      web_searches: engine.activity.web_searches,
      tool_calls: engine.activity.tool_calls,
      errors: engine.activity.errors + (result === "failed" ? 1 : 0),
    },
    github: {
      owner: env.GITHUB_REPOSITORY?.split("/")[0],
      repo: env.GITHUB_REPOSITORY?.split("/")[1],
      issue: target.issue,
      pr: target.pr,
      ...(actor ? { actor_sha256: sha256(actor) } : {}),
    },
    timing: {
      started_at: startedAt.toISOString(),
      ended_at: now.toISOString(),
      duration_ms: Math.max(0, now.getTime() - startedAt.getTime()),
    },
    events: { count: engine.eventCount, checks: checkEvidence.total },
    checks: checkEvidence.items,
    checks_truncated: checkEvidence.total > checkEvidence.items.length,
  };
  const integrity = {
    algorithm: "sha256",
    previous_sha256: null,
  };
  return {
    ...receipt,
    integrity: {
      ...integrity,
      payload_sha256: sha256(stableStringify({ ...receipt, integrity })),
    },
  };
}

export function writeReceipt(receipt, env = process.env) {
  if (!verifyReceipt(receipt)) throw new Error("refusing to publish an invalid Facility receipt");
  const output = resolve(
    env.FACILITY_RECEIPT_OUTPUT ??
      join(env.RUNNER_TEMP ?? ".facility-receipts", "facility-run.json"),
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (env.GITHUB_OUTPUT) {
    writeFileSync(
      env.GITHUB_OUTPUT,
      `path=${output}\nsha256=${receipt.integrity.payload_sha256}\n`,
      { flag: "a" },
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        "### Facility agent receipt",
        "",
        `- Mode: \`${receipt.mode}\``,
        `- Result: \`${receipt.result}\``,
        `- Receipt SHA-256: \`${receipt.integrity.payload_sha256}\``,
        "- Integrity: SHA-256 (verify the separate GitHub Actions attestation when enabled)",
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
  return output;
}

export function verifyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== "facility.run.v1") return false;
  const { integrity, ...content } = receipt;
  const digestable = {
    ...content,
    integrity: {
      algorithm: integrity?.algorithm,
      previous_sha256: integrity?.previous_sha256 ?? null,
      ...(integrity?.attestation ? { attestation: integrity.attestation } : {}),
    },
  };
  return (
    integrity?.algorithm === "sha256" &&
    typeof integrity.payload_sha256 === "string" &&
    integrity.payload_sha256 === sha256(stableStringify(digestable))
  );
}

function parseEngineEvidence(path) {
  const evidence = {
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read: 0,
      cache_write: 0,
      cost_cents: null,
      cost_source: "unavailable",
    },
    activity: {
      turns: 0,
      shell_commands: 0,
      file_changes: 0,
      mcp_tool_calls: 0,
      web_searches: 0,
      tool_calls: 0,
      errors: 0,
    },
    eventCount: 0,
  };
  if (!path || !existsSync(path)) return evidence;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    evidence.eventCount += 1;
    const type = String(event.type ?? event.event ?? "");
    const itemType = String(event.item?.type ?? event.name ?? "");
    if (type === "turn.completed" || type === "assistant" || type === "assistant_message") {
      evidence.activity.turns += 1;
    }
    if (type === "error" || type === "turn.failed" || itemType === "error") {
      evidence.activity.errors += 1;
    }
    if (itemType === "command_execution") evidence.activity.shell_commands += 1;
    if (itemType === "file_change") evidence.activity.file_changes += 1;
    if (itemType === "mcp_tool_call") evidence.activity.mcp_tool_calls += 1;
    if (itemType === "web_search") evidence.activity.web_searches += 1;
    if (itemType) evidence.activity.tool_calls += 1;
    mergeUsage(evidence.usage, event.usage ?? event.response?.usage ?? event.item?.usage);
  }
  return evidence;
}

function mergeUsage(usage, value) {
  if (!value || typeof value !== "object") return;
  usage.input_tokens = integer(value.input_tokens ?? value.inputTokens, usage.input_tokens);
  usage.output_tokens = integer(value.output_tokens ?? value.outputTokens, usage.output_tokens);
  usage.cache_read = integer(value.cache_read ?? value.cached_input_tokens, usage.cache_read);
  usage.cache_write = integer(value.cache_write, usage.cache_write);
  const cents =
    value.cost_cents ??
    (typeof value.cost_usd === "number" ? Math.round(value.cost_usd * 100) : undefined);
  if (typeof cents === "number" && Number.isFinite(cents) && cents >= 0) {
    usage.cost_cents = Math.round(cents);
    usage.cost_source = "engine";
  }
}

function parseChecks(path) {
  if (!path || !existsSync(path)) return { items: [], total: 0 };
  const checks = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      const status = ["passed", "failed", "skipped", "unknown"].includes(value.status)
        ? value.status
        : "unknown";
      checks.push({
        name: String(value.name ?? value.command ?? "unnamed check"),
        status,
        source: value.self_reported === false ? "platform" : "agent",
        ...(Number.isInteger(value.exit_code) ? { exit_code: value.exit_code } : {}),
      });
    } catch {}
  }
  return { items: checks.slice(0, MAX_RECEIPT_CHECKS), total: checks.length };
}

function gitActivity(baseSha, worktree) {
  if (!baseSha || !worktree) return { filesChanged: 0 };
  try {
    const files = execFileSync(
      "git",
      ["-C", worktree, "diff", "--name-only", `${baseSha}...HEAD`],
      { encoding: "utf8" },
    );
    return { filesChanged: files.split(/\r?\n/).filter(Boolean).length };
  } catch {
    return { filesChanged: 0 };
  }
}

function githubTarget(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const event = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isInteger(event.pull_request?.number)) return { pr: event.pull_request.number };
    if (Number.isInteger(event.issue?.number)) {
      return event.issue.pull_request ? { pr: event.issue.number } : { issue: event.issue.number };
    }
  } catch {}
  return {};
}

function normalizeResult(value) {
  if (value === "success" || value === "succeeded") return "succeeded";
  if (value === "cancelled" || value === "canceled") return "canceled";
  if (value === "skipped") return "skipped";
  return "failed";
}

function requiredChoice(value, choices, name) {
  if (!value || !choices.has(value))
    throw new Error(`FACILITY_RECEIPT_${name.toUpperCase()} is invalid`);
  return value;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function integer(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const receipt = collectReceipt();
  const output = writeReceipt(receipt);
  console.log(`Facility agent receipt written to ${output}`);
}
