import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_PRICES_USD_PER_1M, newId, normalizeModel } from "@facility/core";
import { createDb } from "@facility/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import {
  authenticateVirtualKey,
  providerCredential,
  startKeyRevocationListener,
  virtualKeyFromHeaders,
} from "./auth.js";
import { modelFrom, prepareOpenAiBody, readJsonBody, sanitizedRequest } from "./body.js";
import { applicableBudgets, emitSoftBudgetIssues, hardBudgetBlock } from "./budgets.js";
import { readConfig } from "./config.js";
import { createEnvelopeStore } from "./envelope-store.js";
import { GatewayError, providerEnvelope, sendProviderError } from "./errors.js";
import { enqueueMetering, reserveHardBudgetsAndRecordPending } from "./metering.js";
import { claudeOAuthRequestProblem, providerRequestHeaders } from "./provider-auth.js";
import type {
  GatewayConfig,
  GatewayDeps,
  Provider,
  ProviderCredential,
  RequestRecord,
  Usage,
} from "./types.js";
import { emptyUsage, UsageTee, usageFromJson } from "./usage.js";

// `meteringSettled` lets a caller wait for usage writes that outlive the
// response they belong to: the shutdown hook, and tests that clean up rows a
// still-settling write would re-create.
declare module "fastify" {
  interface FastifyInstance {
    meteringSettled: () => Promise<void>;
  }
}

const allowedPaths = {
  anthropic: new Set(["/messages", "/messages/count_tokens"]),
  openai: new Set(["/chat/completions", "/responses"]),
} satisfies Record<Provider, Set<string>>;

export function createMeteringDrain() {
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    return work.finally(() => pending.delete(work));
  };
  const settled = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  return { track, settled };
}

export async function buildApp(
  config: GatewayConfig = readConfig(),
  deps: GatewayDeps = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => uuidv7(),
    bodyLimit: 20 * 1024 * 1024,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  const owned = deps.db ? null : createDb(config.databaseUrl);
  const db = deps.db ?? owned?.db;
  if (!db) throw new Error("gateway database unavailable");
  let revocationListener: { unlisten: () => Promise<void> } | null = null;
  if (owned) {
    // Evict revoked run keys the moment the api NOTIFYs, instead of waiting for
    // the cache TTL. Best-effort: if LISTEN can't be established the TTL backstop
    // still bounds a revoked key's lifetime, so a failure here must not crash boot.
    try {
      revocationListener = await startKeyRevocationListener(owned.client);
    } catch (err) {
      app.log.warn({ err }, "key-revocation listener unavailable; relying on cache TTL");
    }
  }
  const envelopeStore = deps.envelopeStore ?? createEnvelopeStore(config);
  const now = deps.now ?? (() => new Date());
  // Register the whole provider handler before its raw response can finish.
  // Registering only enqueueMetering in the handler's finally block is too late:
  // Fastify may start onClose after the socket finishes but before that block
  // resumes, observe an empty drain, and close Postgres ahead of the usage write.
  const meteringDrain = createMeteringDrain();
  app.decorate("meteringSettled", meteringDrain.settled);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) return sendProviderError(reply, error);
    // Don't leak internal error detail — log it, return a generic message.
    request.log.error({ err: error }, "unhandled gateway error");
    return reply
      .status(500)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }),
  );

  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await db.execute("select 1" as never);
      return { ok: true, db: "ok" as const };
    } catch {
      return reply.status(503).send({ ok: false, db: "down" as const });
    }
  };
  app.get("/health", readiness);
  app.get("/readyz", readiness);

  // Claude Code probes its configured ANTHROPIC_BASE_URL with HEAD before it
  // sends the first message. Keep that compatibility probe deliberately
  // unauthenticated and side-effect free: model requests below still require a
  // run-scoped virtual key and pass through the full budget/metering path.
  app.get("/anthropic", async () => ({ ok: true, provider: "anthropic" as const }));

  app.post("/anthropic/v1/*", (request, reply) =>
    meteringDrain.track(
      handleProvider(request, reply, "anthropic", config, db, envelopeStore, now),
    ),
  );
  app.post("/openai/v1/*", (request, reply) =>
    meteringDrain.track(handleProvider(request, reply, "openai", config, db, envelopeStore, now)),
  );

  app.addHook("onClose", async () => {
    await revocationListener?.unlisten().catch(() => undefined);
    await meteringDrain.settled();
    await owned?.client.end();
  });

  return app;
}

async function handleProvider(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: Provider,
  config: GatewayConfig,
  db: NonNullable<GatewayDeps["db"]>,
  envelopeStore: NonNullable<GatewayDeps["envelopeStore"]>,
  now: () => Date,
) {
  const suffix = providerSuffix(request, provider);
  if (!allowedPaths[provider].has(suffix)) {
    throw new GatewayError(404, "not_found", "Provider path not supported", provider);
  }
  const startedAt = Date.now();
  const requestId = newId("evt");
  const secret = virtualKeyFromHeaders(request.headers);
  if (!secret) {
    throw new GatewayError(401, "unauthorized", "Invalid virtual key", provider);
  }
  const key = await authenticateVirtualKey(db, secret);
  if (!key) {
    throw new GatewayError(401, "unauthorized", "Invalid virtual key", provider);
  }

  let parsed: { raw: Buffer; json: unknown };
  try {
    parsed = await readJsonBody(request.body);
  } catch {
    throw new GatewayError(
      400,
      "bad_request",
      "Request body must be valid JSON under 20MB",
      provider,
    );
  }
  const model = modelFrom(parsed.json);
  if (!model) {
    throw new GatewayError(400, "bad_request", "Request body must include model", provider);
  }
  const normalizedModel = normalizeModel(model);
  const priced = normalizedModel !== null;
  const zeroCostPolicy = isZeroCostVirtualKey(key, model);
  const budgets = await applicableBudgets(db, key, now());
  // Chat Completions accepts stream_options.include_usage; Responses does not.
  // Prepare once so the recorded and upstream bodies reuse the same transform.
  const prepared =
    provider === "openai"
      ? prepareOpenAiBody(parsed.json, {
          injectChatStreamUsage: suffix === "/chat/completions",
        })
      : null;
  const recordedBody = prepared ? prepared.recordedBody : parsed.json;
  const requestBody = sanitizedRequest(recordedBody, request.headers);

  if (!priced && !zeroCostPolicy) {
    const responseBody = providerEnvelope(
      provider,
      "model_not_priced",
      `Model ${model} is not priced for this virtual key. Configure pricing or use an explicit zero-cost BYO key.`,
    );
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced: false,
      status: "model_not_priced",
      statusCode: 402,
      startedAt,
      key,
      requestBody,
      responseBody,
      budgets,
      error: "model not priced",
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    return reply.status(402).send(responseBody);
  }

  const estimatedCents = estimatedCostCents(
    parsed.json,
    parsed.raw.length,
    normalizedModel,
    priced,
  );
  const hardBlock = estimatedCents > 0 ? hardBudgetBlock(budgets) : null;
  if (hardBlock) {
    const responseBody = providerEnvelope(
      provider,
      "budget_exceeded",
      `Budget ${hardBlock.id} is exhausted. Request an override in /inbox/budget_override.`,
    );
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "blocked_budget",
      statusCode: 402,
      startedAt,
      key,
      requestBody,
      responseBody,
      budgets,
      error: `hard budget ${hardBlock.id} exceeded`,
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    return reply.status(402).send(responseBody);
  }

  if (key.allowedModels?.length && !key.allowedModels.includes(model)) {
    const responseBody = providerEnvelope(
      provider,
      "blocked_policy",
      `Model ${model} is not allowed for this virtual key.`,
    );
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "blocked_policy",
      statusCode: 403,
      startedAt,
      key,
      requestBody,
      responseBody,
      budgets,
      error: "allowed_models violation",
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    return reply.status(403).send(responseBody);
  }

  const upstreamBody = prepared ? prepared.raw : parsed.raw;
  let credential: ProviderCredential;
  try {
    credential = await providerCredential(db, config, provider, key.orgId);
  } catch (error) {
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "error",
      statusCode: 502,
      startedAt,
      key,
      requestBody,
      responseBody: { error: error instanceof Error ? error.message : "provider unavailable" },
      budgets,
      providerMayHaveCharged: false,
      error: "upstream fetch failed",
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    throw new GatewayError(502, "provider_error", "Upstream provider request failed", provider);
  }

  const oauthProblem =
    credential.authMode === "oauth"
      ? provider === "anthropic"
        ? claudeOAuthRequestProblem(key, request.headers)
        : "OAuth credentials are unsupported for this provider"
      : null;
  if (oauthProblem) {
    const responseBody = providerEnvelope(
      provider,
      "blocked_policy",
      "This subscription credential is restricted to platform Claude Code runs.",
    );
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "blocked_policy",
      statusCode: 403,
      startedAt,
      key,
      requestBody,
      responseBody,
      budgets,
      providerMayHaveCharged: false,
      error: oauthProblem,
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    return reply.status(403).send(responseBody);
  }

  await emitSoftBudgetIssues(db, budgets, key);
  const pendingRecord = baseRecord({
    requestId,
    provider,
    model,
    priced,
    status: "ok",
    statusCode: 0,
    startedAt,
    key,
    requestBody,
    responseBody: null,
    budgets,
    estimatedCents,
    providerMayHaveCharged: true,
  });
  const reservation =
    estimatedCents > 0
      ? await reserveHardBudgetsAndRecordPending(db, budgets, key, estimatedCents, pendingRecord)
      : { ok: true as const, reservations: [] };
  if (!reservation.ok) {
    const responseBody = providerEnvelope(
      provider,
      "budget_exceeded",
      `Budget ${reservation.budget.id} would be exceeded by this request.`,
    );
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "blocked_budget",
      statusCode: 402,
      startedAt,
      key,
      requestBody,
      responseBody,
      budgets,
      error: `hard budget ${reservation.budget.id} exceeded`,
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    return reply.status(402).send(responseBody);
  }
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });

  const upstreamHeaders = providerRequestHeaders(
    provider,
    request.headers,
    credential,
    upstreamBody,
  );
  let upstream: Response;
  try {
    // credential.baseUrl is already the normalized, SSRF-validated URL produced by
    // validateProviderBaseUrl when the credential was opened (auth.ts), and the
    // credential cache bounds its trust window. Re-validating here would repeat a
    // DNS lookup on every proxied request for no real gain — fetch re-resolves DNS
    // independently anyway, so per-request validation can't close a rebinding TOCTOU;
    // redirect:"error" below is what actually blocks redirect-based SSRF.
    upstream = await fetch(upstreamUrl(credential.baseUrl, suffix, request.url), {
      method: "POST",
      headers: upstreamHeaders,
      body: upstreamBody,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status: "error",
      statusCode: 502,
      startedAt,
      key,
      requestBody,
      responseBody: { error: error instanceof Error ? error.message : "upstream fetch failed" },
      budgets,
      reservations: reservation.reservations,
      estimatedCents,
      providerMayHaveCharged: false,
      error: "upstream fetch failed",
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
    throw new GatewayError(502, "provider_error", "Upstream provider request failed", provider);
  }

  copyHeaders(upstream, reply);
  reply.status(upstream.status);
  const contentType = upstream.headers.get("content-type") ?? undefined;
  const tee = new UsageTee(provider);
  let responseBody: unknown = {};
  let usage: Usage = emptyUsage();
  let status: RequestRecord["status"] = upstream.ok ? "ok" : "error";
  let error: string | undefined = upstream.ok ? undefined : `upstream status ${upstream.status}`;

  try {
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), tee, reply.raw);
    } else {
      reply.raw.end();
    }
    responseBody = tee.responseBody(contentType);
    usage = mergeParsedUsage(tee.usage, usageFromJson(provider, responseBody));
  } catch (pipelineError) {
    status = "error";
    error = pipelineError instanceof Error ? pipelineError.message : "stream interrupted";
    responseBody = tee.responseBody(contentType);
    usage = tee.usage;
  } finally {
    const record = baseRecord({
      requestId,
      provider,
      model,
      priced,
      status,
      statusCode: upstream.status,
      startedAt,
      key,
      usage,
      requestBody,
      responseBody,
      budgets,
      reservations: reservation.reservations,
      estimatedCents,
      providerMayHaveCharged: true,
      error,
    });
    await enqueueMetering(db, envelopeStore, request.log, record, now());
  }
}

function baseRecord(input: Omit<RequestRecord, "usage"> & { usage?: Usage }): RequestRecord {
  return { ...input, usage: input.usage ?? emptyUsage() };
}

function mergeParsedUsage(base: Usage, parsed: Partial<Usage>): Usage {
  return {
    inputTokens: parsed.inputTokens ?? base.inputTokens,
    outputTokens: parsed.outputTokens ?? base.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens ?? base.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens ?? base.cacheWriteTokens,
  };
}

function isZeroCostVirtualKey(key: { allowedModels: string[] | null }, model: string): boolean {
  const allowed = key.allowedModels;
  if (!allowed?.length || !allowed.includes(model)) return false;
  return allowed.every((allowedModel) => {
    const normalized = normalizeModel(allowedModel);
    return normalized === null || normalized === "custom";
  });
}

function estimatedCostCents(
  body: unknown,
  rawBytes: number,
  normalizedModel: keyof typeof MODEL_PRICES_USD_PER_1M | null,
  priced: boolean,
): number {
  if (!priced || !normalizedModel) return 0;
  const price = MODEL_PRICES_USD_PER_1M[normalizedModel];
  if (price.input <= 0 && price.output <= 0) return 0;
  const maxTokens = maxOutputTokens(body) ?? 4096;
  const inputTokens = inputTokensEstimate(body, rawBytes);
  const cacheReadTokens = declaredCacheReadTokens(body) ?? 0;
  const cacheWriteTokens = declaredCacheWriteTokens(body) ?? 0;
  const cents =
    ((inputTokens / 1_000_000) * price.input +
      (maxTokens / 1_000_000) * price.output +
      (cacheReadTokens / 1_000_000) * (price.cacheRead ?? 0) +
      (cacheWriteTokens / 1_000_000) * (price.cacheWrite ?? 0)) *
    100;
  return Math.round(cents * 1_000_000) / 1_000_000;
}

function maxOutputTokens(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return null;
}

function inputTokensEstimate(body: unknown, rawBytes: number): number {
  const declared = declaredInputTokens(body);
  if (declared !== null) return declared;
  return Math.max(1, Math.ceil(rawBytes / 4));
}

function declaredInputTokens(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  for (const key of ["input_tokens", "prompt_tokens", "estimated_input_tokens"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  const usage = row.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const value = (usage as Record<string, unknown>).input_tokens;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return null;
}

function declaredCacheReadTokens(body: unknown): number | null {
  return declaredTokenCount(body, [
    "cache_read_tokens",
    "cache_read_input_tokens",
    "estimated_cache_read_tokens",
  ]);
}

function declaredCacheWriteTokens(body: unknown): number | null {
  return declaredTokenCount(body, [
    "cache_write_tokens",
    "cache_creation_input_tokens",
    "estimated_cache_write_tokens",
  ]);
}

function declaredTokenCount(body: unknown, keys: string[]): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  const usage = row.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    for (const key of keys) {
      const value = (usage as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.ceil(value);
    }
  }
  return null;
}

function providerSuffix(request: FastifyRequest, provider: Provider): string {
  const prefix = provider === "anthropic" ? "/anthropic/v1" : "/openai/v1";
  const path = request.url.split("?")[0] ?? request.url;
  return path.slice(prefix.length);
}

function upstreamUrl(baseUrl: string, suffix: string, originalUrl: string): string {
  const query = originalUrl.includes("?") ? `?${originalUrl.split("?").slice(1).join("?")}` : "";
  return `${baseUrl.replace(/\/$/, "")}${suffix}${query}`;
}

function copyHeaders(upstream: Response, reply: FastifyReply) {
  for (const [name, value] of upstream.headers) {
    if (["connection", "content-length", "keep-alive", "transfer-encoding"].includes(name)) {
      continue;
    }
    reply.header(name, value);
  }
}
