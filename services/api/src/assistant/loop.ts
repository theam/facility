import Anthropic from "@anthropic-ai/sdk";
import { generateApiKey } from "@facility/core";
import {
  conversationMessages,
  conversations,
  type createDb,
  llmRequests,
  runs,
  virtualKeys,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { failRun, finishConversationTurn, revokeRunKeys } from "../sandbox/orchestrator.js";
import { appendRunEvents } from "../sandbox/state.js";
import type { AppConfig } from "../types.js";
import { assistantSystemPrompt } from "./prompt.js";
import { ASSISTANT_TOOLS } from "./tools.js";
import { registerAssistantTurn, releaseAssistantTurn } from "./turn-registry.js";

type Db = ReturnType<typeof createDb>["db"];

const MAX_TOKENS = 4096;
const HISTORY_LIMIT = 30;
const TOOL_RESULT_CAP = 40_000;
const DELTA_FLUSH_CHARS = 800;
const DELTA_FLUSH_MS = 400;

export type AssistantModelTurn = {
  content: Anthropic.Messages.ContentBlock[];
  stopReason: string | null;
};

/** Injectable for tests: the one seam that talks to the model. */
export type AssistantModelDriver = (input: {
  model: string;
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools: Anthropic.Messages.Tool[];
  maxTokens: number;
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
}) => Promise<AssistantModelTurn>;

export type AssistantTurnInput = {
  app: FastifyInstance;
  config: AppConfig;
  db: Db;
  runId: string;
  orgId: string;
  projectId: string;
  projectName: string;
  conversationId: string;
  agentModel: string;
  /** Forwarded verbatim into every tool call — the loop acts as this user. */
  userHeaders: { cookie?: string; authorization?: string };
  driver?: AssistantModelDriver;
};

// In-process abort registry: cancel can reach a local in-flight turn instantly;
// the DB terminal-status check between iterations is the cross-process backstop.
const turns = new Map<string, AbortController>();

export function abortAssistantTurn(runId: string) {
  turns.get(runId)?.abort();
}

function defaultDriver(config: AppConfig, apiKey: string): AssistantModelDriver {
  return async ({ model, system, messages, tools, maxTokens, signal, onTextDelta }) => {
    const client = new Anthropic({
      baseURL: `${config.gatewayUrl}/anthropic`,
      apiKey,
      maxRetries: 1,
    });
    const stream = client.messages.stream(
      { model, system, messages, tools, max_tokens: maxTokens },
      { signal },
    );
    stream.on("text", (delta) => onTextDelta(delta));
    const final = await stream.finalMessage();
    return { content: final.content, stopReason: final.stop_reason };
  };
}

/** Merge consecutive same-role turns — the Messages API requires alternation. */
function toModelHistory(
  rows: Array<{ role: string; body: string }>,
): Anthropic.Messages.MessageParam[] {
  const merged: Anthropic.Messages.MessageParam[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "agent") continue;
    const role = row.role === "agent" ? "assistant" : "user";
    const last = merged.at(-1);
    if (last && last.role === role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${row.body}`;
    } else {
      merged.push({ role, content: row.body });
    }
  }
  // The API rejects a leading assistant turn; drop it (compacted old thread).
  while (merged[0]?.role === "assistant") merged.shift();
  return merged;
}

function finalText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function toolSummary(name: string, payload: unknown): Record<string, unknown> {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (name === "consult_architect") return { runId: data.id ?? null };
  if (name === "intake_capture")
    return { artifactId: data.artifactId ?? null, runId: data.runId ?? null };
  if (name === "draft_task") return { taskId: data.id ?? null };
  if (name === "propose_issue_update") return { proposalId: data.id ?? null };
  return {};
}

export async function runAssistantTurn(input: AssistantTurnInput): Promise<void> {
  const { app, config, db, runId, orgId, projectId, conversationId } = input;
  const abort = new AbortController();
  turns.set(runId, abort);
  const turnToken = registerAssistantTurn(runId);
  const emit = (type: string, data: Record<string, unknown>) =>
    appendRunEvents(db, orgId, runId, [{ type, data }]);
  let virtualKeyId: string | undefined;
  try {
    // Per-turn gateway key: run-bound (metering attributes spend to this run)
    // and model-pinned. Its lifecycle is terminal revocation rather than a
    // wall clock, so a healthy tool loop cannot lose access mid-session.
    const key = await generateApiKey("fvk");
    await db.insert(virtualKeys).values({
      id: key.id,
      orgId,
      projectId,
      runId,
      name: `Assistant turn ${runId}`,
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      allowedModels: [input.agentModel],
    });
    virtualKeyId = key.id;
    await db
      .update(runs)
      .set({
        sandbox: { virtualKeyId: key.id, inline: true },
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)));
    await emit("turn", { phase: "started", conversationId });

    const inject = async (request: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    }) => {
      const response = await app.inject({
        method: request.method,
        url: request.path,
        query: request.query,
        ...(request.body === undefined ? {} : { payload: request.body as Record<string, unknown> }),
        headers: {
          ...(input.userHeaders.cookie ? { cookie: input.userHeaders.cookie } : {}),
          ...(input.userHeaders.authorization
            ? { authorization: input.userHeaders.authorization }
            : {}),
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": `facility-assistant/${runId}`,
          // In-process turn binding: lets proposal routes record the AGENT as
          // requester (see assistant/turn-registry.ts). Worthless off-process.
          "x-facility-assistant-run": runId,
          "x-facility-assistant-token": turnToken,
        },
      });
      let parsed: unknown;
      try {
        parsed = response.json();
      } catch {
        parsed = { raw: response.payload.slice(0, 2_000) };
      }
      return { statusCode: response.statusCode, payload: parsed };
    };

    // Ground the persona in charter/ACTIVE — through the user's own principal.
    const space = await inject({ method: "GET", path: `/v1/projects/${projectId}/kb/space` });
    const spaceData =
      space.statusCode === 200 && space.payload && typeof space.payload === "object"
        ? (space.payload as { charterMd?: string; activeMd?: string })
        : {};
    const me = await inject({ method: "GET", path: "/v1/me" });
    const meData =
      me.statusCode === 200 && me.payload && typeof me.payload === "object"
        ? (me.payload as { user?: { name?: string; email?: string } })
        : {};
    const system = assistantSystemPrompt({
      projectName: input.projectName,
      charterMd: spaceData.charterMd ?? "",
      activeMd: spaceData.activeMd ?? "",
      requester: meData.user ?? {},
    });

    const historyRows = await db
      .select({ role: conversationMessages.role, body: conversationMessages.body })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.orgId, orgId),
          eq(conversationMessages.conversationId, conversationId),
        ),
      )
      .orderBy(conversationMessages.seq);
    const messages = toModelHistory(historyRows.slice(-HISTORY_LIMIT));
    if (messages.length === 0) throw new Error("assistant_turn_empty_history");

    const tools: Anthropic.Messages.Tool[] = ASSISTANT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
    }));
    const driver = input.driver ?? defaultDriver(config, key.secret);

    // Coalesced streaming: durable run events are the transport, so batch
    // deltas — every flush is one Postgres row + one NOTIFY.
    let buffer = "";
    let lastFlush = Date.now();
    const flushDeltas = async (force = false) => {
      if (!buffer) return;
      if (!force && buffer.length < DELTA_FLUSH_CHARS && Date.now() - lastFlush < DELTA_FLUSH_MS) {
        return;
      }
      const text = buffer;
      buffer = "";
      lastFlush = Date.now();
      await emit("assistant_delta", { text });
    };

    let final: AssistantModelTurn = { content: [], stopReason: null };
    for (let iteration = 1; ; iteration++) {
      const current = await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1);
      if (current[0]?.status !== "running") throw new Error("assistant_turn_cancelled");
      await emit("status", {
        message: iteration === 1 ? "reading the project" : "reading tool results",
      });
      let pending = Promise.resolve();
      final = await driver({
        model: input.agentModel,
        system,
        messages,
        tools,
        maxTokens: MAX_TOKENS,
        signal: abort.signal,
        onTextDelta: (delta) => {
          buffer += delta;
          pending = pending.then(() => flushDeltas());
        },
      });
      await pending;
      await flushDeltas(true);
      messages.push({ role: "assistant", content: final.content });
      const toolUses = final.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
      );
      if (final.stopReason !== "tool_use" || toolUses.length === 0) break;
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const definition = ASSISTANT_TOOLS.find((tool) => tool.name === use.name);
        await emit("tool_call", { tool: use.name });
        const startedAt = Date.now();
        let resultContent: string;
        let isError = false;
        let summary: Record<string, unknown> = {};
        if (!definition) {
          resultContent = JSON.stringify({ error: "unknown_tool" });
          isError = true;
        } else {
          try {
            const request = definition.toRequest((use.input ?? {}) as Record<string, unknown>, {
              projectId,
            });
            const response = await inject(request);
            isError = response.statusCode >= 400;
            summary = isError ? {} : toolSummary(use.name, response.payload);
            const serialized = JSON.stringify(response.payload);
            resultContent =
              serialized.length > TOOL_RESULT_CAP
                ? `${serialized.slice(0, TOOL_RESULT_CAP)}…(truncated)`
                : serialized;
          } catch (error) {
            resultContent = JSON.stringify({
              error: error instanceof Error ? error.message : "tool_failed",
            });
            isError = true;
          }
        }
        await emit("tool_result", {
          tool: use.name,
          ok: !isError,
          ms: Date.now() - startedAt,
          ...summary,
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: resultContent,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: results });
    }

    const text = finalText(final.content) || "(no reply)";
    // Two shapes on purpose: `assistant` feeds finishConversationTurn's reply
    // reader; the `engine` mirror feeds GET /v1/runs/:id/result's distiller.
    await emit("assistant", { text });
    await emit("engine", {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
    const succeeded = await db
      .update(runs)
      .set({ status: "succeeded", endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ id: runs.id, trigger: runs.trigger });
    if (succeeded.length === 0) return; // cancelled mid-flight — cancel path owns cleanup
    await emit("result", { status: "succeeded" });
    const runRow = (
      await db
        .select()
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
        .limit(1)
    )[0];
    if (runRow) await finishConversationTurn(db, runRow, undefined);
    // First completed exchange names the session: replace the provisional
    // (truncated-question) title with a model-generated one. Never fatal.
    await maybeTitleConversation(db, driver, input, conversationId, text).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "assistant_turn_failed";
    await failRun(db, orgId, runId, message, "assistant_turn_failed").catch(() => undefined);
  } finally {
    turns.delete(runId);
    releaseAssistantTurn(runId);
    if (virtualKeyId) await revokeRunKeys(db, { virtualKeyId }).catch(() => undefined);
    await writeUsageReceipt(db, orgId, runId).catch(() => undefined);
  }
}

/**
 * After the FIRST completed exchange, replace the provisional title (the
 * truncated opening question, set by the ask route) with a short
 * model-generated one. One tiny call on
 * the same per-turn key; any failure leaves the provisional title in place.
 */
async function maybeTitleConversation(
  db: Db,
  driver: AssistantModelDriver,
  input: AssistantTurnInput,
  conversationId: string,
  reply: string,
) {
  const rows = await db
    .select({ role: conversationMessages.role, body: conversationMessages.body })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(conversationMessages.seq)
    .limit(3);
  // Only the first exchange (user + agent) names the session.
  if (rows.length > 2) return;
  const question = rows.find((row) => row.role === "user")?.body ?? "";
  if (!question.trim()) return;
  const turn = await driver({
    model: input.agentModel,
    system:
      "Name this conversation. Reply with ONLY a title of 3 to 6 plain words — no quotes, no trailing punctuation.",
    messages: [
      {
        role: "user",
        content: `Question: ${question.slice(0, 600)}\n\nAnswer excerpt: ${reply.slice(0, 400)}`,
      },
    ],
    tools: [],
    maxTokens: 32,
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
  });
  const title = finalText(turn.content)
    .replaceAll(/["'`]/g, "")
    .replace(/[.!?\s]+$/, "")
    .trim()
    .slice(0, 60);
  if (!title) return;
  await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(conversations.orgId, input.orgId), eq(conversations.id, conversationId)));
}

/**
 * Inline runs have no sandbox receipt, but the gateway meters every model
 * call into llm_requests attributed to the run — aggregate that into the
 * standard receipt shape so cost/tokens surface everywhere sandbox runs do.
 * Metering lands asynchronously after each proxied response, so retry once.
 */
async function writeUsageReceipt(db: Db, orgId: string, runId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const totals = (
      await db
        .select({
          requests: sql<number>`count(*)::int`,
          costCents: sql<number>`coalesce(sum(${llmRequests.costCents}), 0)::float`,
          inputTokens: sql<number>`coalesce(sum(${llmRequests.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${llmRequests.outputTokens}), 0)::int`,
        })
        .from(llmRequests)
        .where(and(eq(llmRequests.orgId, orgId), eq(llmRequests.runId, runId)))
    )[0];
    if (totals && totals.requests > 0) {
      await db
        .update(runs)
        .set({
          receipt: {
            source: "llm_requests",
            usage: {
              // The receipt contract (RunSchema) wants integer cents plus the
              // metering source — fractional cents 500 the runs listing.
              cost_cents: Math.round(totals.costCents),
              cost_source: "gateway",
              input_tokens: totals.inputTokens,
              output_tokens: totals.outputTokens,
              requests: totals.requests,
            },
          },
          updatedAt: new Date(),
        })
        .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}
