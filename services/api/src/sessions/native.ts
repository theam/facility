import type { AgentManifest } from "@facility/agents";
import { costCents, normalizeModel } from "@facility/core";
import { z } from "zod";
import type { AgentTurnUsage } from "../turns/engines.js";

export const NativeSnapshot = z.object({
  records: z.array(z.record(z.string(), z.unknown())).max(200_000),
  hooks: z
    .array(
      z.object({
        state: z.enum(["working", "idle", "blocked"]),
        message: z.string(),
        at: z.string(),
      }),
    )
    .default([]),
  nativeSessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,160}$/)
    .nullable(),
  bytes: z.number().int().nonnegative(),
  exited: z.boolean(),
});
export type Snapshot = z.infer<typeof NativeSnapshot>;
export const emptyUsage = (): AgentTurnUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function hasNativeUsage(engine: string, records: Snapshot["records"]) {
  return records.some((record) => {
    const payload = object(record.payload);
    const usage =
      engine === "codex"
        ? object(object(payload.info).total_token_usage)
        : object(object(record.message).usage);
    const relevant =
      engine === "codex" ? payload.type === "token_count" : record.type === "assistant";
    return (
      relevant &&
      [usage.input_tokens, usage.output_tokens].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    );
  });
}

/** Native journals contain complete snapshots, including repeated usage records.
 * Count a Claude response once; Codex's total usage is already cumulative. */
export function nativeUsage(engine: string, records: Snapshot["records"]): AgentTurnUsage {
  let total = emptyUsage();
  const responses = new Map<string, AgentTurnUsage>();
  for (const [index, record] of records.entries()) {
    if (engine === "codex") {
      const payload = object(record.payload);
      if (payload.type !== "token_count") continue;
      const usage = object(object(payload.info).total_token_usage);
      const cached = count(usage.cached_input_tokens);
      total = {
        inputTokens: Math.max(0, count(usage.input_tokens) - cached),
        outputTokens: count(usage.output_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
    } else if (record.type === "assistant") {
      const message = object(record.message);
      const usage = object(message.usage);
      const key = String(message.id ?? record.uuid ?? index);
      const previous = responses.get(key) ?? emptyUsage();
      responses.set(key, {
        inputTokens: Math.max(previous.inputTokens, count(usage.input_tokens)),
        outputTokens: Math.max(previous.outputTokens, count(usage.output_tokens)),
        cacheReadTokens: Math.max(previous.cacheReadTokens, count(usage.cache_read_input_tokens)),
        cacheWriteTokens: Math.max(
          previous.cacheWriteTokens,
          count(usage.cache_creation_input_tokens),
        ),
      });
    }
  }
  for (const usage of responses.values())
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const)
      total[key] += usage[key];
  return total;
}

export function usageSince(total: AgentTurnUsage, baseline: AgentTurnUsage): AgentTurnUsage {
  const result = emptyUsage();
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    if (total[key] < baseline[key])
      throw new Error("Native usage counter regressed; session retained for reconciliation");
    result[key] = total[key] - baseline[key];
  }
  return result;
}

/** Price the actual model recorded by each response, including native /model changes. */
export function nativeCost(
  engine: string,
  records: Snapshot["records"],
  offset: number,
  baseline: AgentTurnUsage,
  defaultModel: string,
) {
  let total: number | null = 0;
  const models = new Set<string>();
  const add = (model: string, usage: AgentTurnUsage) => {
    if (!Object.values(usage).some((value) => value !== 0)) return;
    models.add(normalizeModel(model) ?? model);
    const cost = costCents({ model, ...usage });
    total = total === null || cost === null ? null : total + cost;
  };
  if (engine === "codex") {
    let previous = baseline;
    let model = defaultModel;
    for (const record of records.slice(offset)) {
      const payload = object(record.payload);
      if (record.type === "turn_context" && typeof payload.model === "string")
        model = payload.model;
      if (payload.type !== "token_count" || !hasNativeUsage(engine, [record])) continue;
      const current = nativeUsage(engine, [record]);
      add(model, usageSince(current, previous));
      previous = current;
    }
  } else {
    const responses = new Map<
      string,
      { model: string; all: Snapshot["records"]; before: Snapshot["records"] }
    >();
    for (const [index, record] of records.entries()) {
      if (record.type !== "assistant") continue;
      const message = object(record.message);
      const key = String(message.id ?? record.uuid ?? index);
      const response = responses.get(key) ?? {
        model: typeof message.model === "string" ? message.model : defaultModel,
        all: [],
        before: [],
      };
      response.all.push(record);
      if (index < offset) response.before.push(record);
      responses.set(key, response);
    }
    for (const response of responses.values())
      add(
        response.model,
        usageSince(nativeUsage(engine, response.all), nativeUsage(engine, response.before)),
      );
  }
  return { costCents: total, model: models.size > 1 ? "mixed" : ([...models][0] ?? defaultModel) };
}

export function messagesForNativeResume<T extends { metadata: unknown }>(
  messages: T[],
  nativeSessionId?: string,
) {
  return nativeSessionId
    ? messages.filter((message) => object(message.metadata).nativeSessionId !== nativeSessionId)
    : messages;
}

export function nativeMessage(engine: string, record: Snapshot["records"][number]) {
  const message = engine === "codex" ? object(record.payload) : object(record.message);
  if (engine === "codex" && (record.type !== "response_item" || message.type !== "message"))
    return null;
  const role = String(message.role ?? record.type);
  if (!["user", "assistant"].includes(role) || record.isSidechain) return null;
  const content = message.content;
  const body =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((item) => object(item))
            .filter((item) => ["text", "input_text", "output_text"].includes(String(item.type)))
            .map((item) => String(item.text ?? ""))
            .join("\n")
        : "";
  return body.trim() ? { role, body: body.slice(0, 200_000) } : null;
}

/** Journal prompts and attention markers survive missing hook payloads.
 * Hooks augment this without relying on terminal parsing. */
export function nativeAgentState(engine: string, snapshot: Snapshot) {
  let signal: Snapshot["hooks"][number] | undefined;
  for (const record of snapshot.records) {
    const payload = object(record.payload);
    const message = nativeMessage(engine, record);
    const at = typeof record.timestamp === "string" ? record.timestamp : "";
    const attention =
      message?.role === "assistant"
        ? /<facility-needs-attention>([\s\S]*?)<\/facility-needs-attention>/
            .exec(message.body)?.[1]
            ?.trim()
        : undefined;
    if (
      message?.role === "user" ||
      (record.type === "event_msg" && payload.type === "task_started")
    )
      // Claude's prompt hook owns working; old journal prompts must not mark a resumed TUI busy.
      signal = engine === "codex" ? { state: "working", message: "", at } : undefined;
    else if (attention) signal = { state: "blocked", message: attention, at };
    else if (
      record.type === "event_msg" &&
      ["task_complete", "turn_aborted"].includes(String(payload.type))
    )
      signal = {
        state: signal?.state === "blocked" ? "blocked" : "idle",
        message: signal?.state === "blocked" ? signal.message : "",
        at,
      };
  }
  const hook = snapshot.hooks.at(-1);
  if (hook?.state === "idle" && signal?.state === "blocked") return signal;
  return hook && (!signal || (Date.parse(hook.at) || 0) >= (Date.parse(signal.at) || 0))
    ? hook
    : signal;
}

export function interactiveArguments(
  manifest: AgentManifest,
  nativeSessionId?: string,
  instructionsPath?: string,
) {
  const instructions = instructionsPath
    ? `Read ${instructionsPath} before acting or answering. It contains the Facility agent manifest, story context and shared conversation. Follow those instructions throughout this session.`
    : manifest.prompt;
  if (manifest.engine === "claude_code") {
    const hooks = Object.fromEntries(
      ["UserPromptSubmit", "Stop", "Notification"].map((name) => [
        name,
        [{ hooks: [{ type: "command", command: "facility-session-hook", timeout: 3 }] }],
      ]),
    );
    return [
      "--model",
      manifest.model,
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      instructions,
      "--settings",
      JSON.stringify({ hooks }),
      ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
    ];
  }
  return [
    ...(nativeSessionId ? ["resume", nativeSessionId] : []),
    "--model",
    manifest.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'notify=["facility-session-hook"]',
    "-c",
    `developer_instructions=${JSON.stringify(instructions)}`,
    ...(manifest.options.reasoning_effort
      ? ["-c", `model_reasoning_effort=${JSON.stringify(manifest.options.reasoning_effort)}`]
      : []),
  ];
}
