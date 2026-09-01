import { open, verifyKey } from "@facility/core";
import { githubInstallations, insertAuditEvent, repos, runs, steerMessages } from "@facility/db";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  readSessionStateObject,
  writeSessionStateObject,
  writeTranscriptObject,
} from "../envelopes.js";
import { ApiError, notFound } from "../errors.js";
import {
  createGithubClientFactory,
  createGithubInstallationTokenFactory,
} from "../github/client.js";
import { collectGithubSecuritySweepEvidence } from "../github/security-sweep.js";
import {
  FinalizationInProgressError,
  finishRun,
  updateGithubRunProgress,
} from "../sandbox/orchestrator.js";
import {
  appendRunEvents,
  type RunSandboxState,
  readSandbox,
  resultFinalizationPending,
  terminalStatus,
} from "../sandbox/state.js";
import type { AppConfig } from "../types.js";

const Params = z.object({ runId: z.string() });
const GitCommitSha = z.string().regex(/^[0-9a-f]{40}$/i);
// Exactly what newId("evt") produces. An ack names rows to mutate, so this
// route takes only ids it could have issued: a list carrying anything else is
// refused whole, before any of it reaches a query.
const ACK_ID = /^evt_[0-9a-f]{32}$/;
// How many ids one request may name. A caller is expected to name ids from a
// batch this route served — STEER_BATCH caps a batch — but that is the caller's
// convention and nothing here checks it: what this route enforces is the id
// shape, this length, and the run and org the update runs under, so an id that
// never reached this caller is simply an id the update matches no row for. The
// bound has to stay at or above STEER_BATCH, which a steer-ack test pins,
// because an ack of a full batch past it is refused whole and the runner
// re-sends that same list on every later poll.
export const STEER_ACK_MAX = 32;
// The most rows one poll is answered with. Exported for the test that keeps it
// inside the bound above.
export const STEER_BATCH = 10;
// One ack parameter, or several, each holding a comma-separated list. The
// parameter absent stays undefined rather than becoming an empty list: presence
// is what tells this route which protocol the caller speaks, and a poll with
// nothing to acknowledge still carries the parameter, empty. Exported so the id
// rule can be tested as a rule: from outside the route every refusal is the same
// 400, which says nothing about which shapes the rule refuses.
export const SteerAck = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    // Joined before splitting so that a wholly empty parameter — and only that —
    // is the acknowledgment of nothing. An empty entry beside others survives
    // into the list and fails the id rule below, which refuses the request whole.
    const joined = Array.isArray(value) ? value.join(",") : value;
    return joined === "" ? [] : joined.split(",");
  })
  .refine(
    (ids) =>
      ids === undefined || (ids.length <= STEER_ACK_MAX && ids.every((id) => ACK_ID.test(id))),
    `ack takes up to ${STEER_ACK_MAX} comma-separated message ids`,
  );
// The cursor this route took before the ack. A request this route reads the
// cursor from marks rows delivered from the select that served them, so the
// cursor is held to the same id rule for the same reason: only an id this route
// could have issued reaches a query, and a list — which the cursor never was —
// is refused outright.
const SteerAfterId = z.string().regex(ACK_ID).optional();
const TRANSCRIPT_MAX_BYTES = 50 * 1024 * 1024;
const SESSION_STATE_MAX_BYTES = 200 * 1024 * 1024;
const EventBatch = z.array(
  z.object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
    ts: z.string().optional(),
  }),
);

type RunnerRequest = FastifyRequest & {
  runnerRun?: typeof runs.$inferSelect;
};

export async function registerInternalRoutes(app: FastifyInstance, config: AppConfig) {
  const db = app.facilityDb;

  if (!app.hasContentTypeParser("application/x-ndjson")) {
    app.addContentTypeParser(
      "application/x-ndjson",
      { parseAs: "buffer", bodyLimit: TRANSCRIPT_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
  }
  if (!app.hasContentTypeParser("application/gzip")) {
    app.addContentTypeParser(
      "application/gzip",
      { parseAs: "buffer", bodyLimit: SESSION_STATE_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  async function authenticateRunner(
    request: FastifyRequest,
    // Whether a terminal run is still admitted while the finalization its
    // /result claim started has not been recorded complete. Only /result asks
    // for it: that is the request the runner replays after a lost response, and
    // the one finishRun knows how to resume. Every other route stays refused
    // the moment the run is terminal — an event or a steer poll has nothing
    // left to do for a run whose verdict is committed.
    resumesFinalization: boolean,
  ) {
    const { runId } = request.params as { runId: string };
    const token = bearer(request.headers.authorization);
    if (!token) throw new ApiError(401, "unauthorized", "Runner token required");
    const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!run) throw notFound("Run not found");
    const sandbox = readSandbox(run.sandbox);
    if (
      terminalStatus(run.status) &&
      !(resumesFinalization && resultFinalizationPending(sandbox))
    ) {
      throw new ApiError(409, "run_terminal", "Run is terminal");
    }
    if (!sandbox.runnerTokenHash || !(await verifyKey(token, sandbox.runnerTokenHash))) {
      throw new ApiError(401, "unauthorized", "Invalid runner token");
    }
    (request as RunnerRequest).runnerRun = run;
  }
  const authenticate = (request: FastifyRequest) => authenticateRunner(request, false);
  const authenticateResult = (request: FastifyRequest) => authenticateRunner(request, true);

  app.post(
    "/internal/runs/:runId/hello",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: { params: Params, response: { 200: z.record(z.string(), z.unknown()) } },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const sandbox = readSandbox(run.sandbox);
      if (!sandbox.bundle || !sandbox.sealedVirtualKey) {
        throw new ApiError(409, "not_ready", "Run bundle is not ready");
      }
      if (sandbox.virtualKeyRevealedAt) {
        throw new ApiError(409, "virtual_key_revealed", "Run credentials were already revealed");
      }
      const securitySweepEvidence = isSecuritySweepMode(run.mode)
        ? await securitySweepEvidenceForRun(run, sandbox)
        : null;
      const virtualKeyRevealedAt = new Date().toISOString();
      // Claim the transition to running only if the run is still active. A cancel
      // that lands between the auth snapshot and here must win — we must not
      // resurrect a terminal run, and (critically) must not hand its sandbox the
      // sealed credentials after it was told to stop.
      const [claimed] = await db
        .update(runs)
        .set({
          status: "running",
          startedAt: run.startedAt ?? new Date(),
          // launch() and /hello race on fast providers. Merge only the field
          // owned by this endpoint so a provider ref attached after the auth
          // snapshot cannot be erased by this one-shot credential claim.
          sandbox: sql`${runs.sandbox} || ${JSON.stringify({ virtualKeyRevealedAt })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(runs.id, run.id), eq(runs.status, "provisioning")))
        .returning({ id: runs.id });
      if (!claimed) {
        throw new ApiError(
          409,
          "run_credentials_already_released",
          "Run credentials are no longer available",
        );
      }
      await appendRunEvents(db, run.orgId, run.id, [{ type: "hello", data: {} }]);
      await updateGithubRunProgress(db, run.id, "running", {
        config,
        githubClientFactory: app.githubClientFactory,
      }).catch(() => undefined);
      return {
        // Sandbox-facing URL — the container reaches the API via this host, not
        // the operator's public URL (which may be localhost).
        bundleUrl: `${config.sandboxApiUrl.replace(/\/$/, "")}/internal/runs/${run.id}/bundle`,
        virtualKey: await open(sandbox.sealedVirtualKey, config.secretMasterKey),
        // Least-privilege platform key (KB + tasks, project-scoped) for a
        // harness agent to maintain the KB via the /v1 API. Revoked at run end.
        platformKey: sandbox.sealedPlatformKey
          ? await open(sandbox.sealedPlatformKey, config.secretMasterKey)
          : null,
        platformApiUrl: config.sandboxApiUrl.replace(/\/$/, ""),
        projectId: sandbox.projectId ?? run.projectId,
        // Short-lived clone credential for private repos. In production this is
        // a per-run GitHub App installation token; here it falls back to a
        // configured token for self-host / validation.
        repoToken: await repoTokenForRun(sandbox),
        // Released through the same one-shot authenticated handshake as the
        // virtual and clone keys, and only when this run has a dedicated
        // dependency-install phase. The sandbox task itself has no IAM access
        // to the registry secret.
        packageRegistryToken: sandbox.bundle.packageInstallCmd
          ? (config.packageRegistryToken ?? null)
          : null,
        securitySweepEvidence,
        gatewayUrls: sandbox.bundle.gatewayUrls,
      };
    },
  );

  app.get(
    "/internal/runs/:runId/bundle",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        response: { 200: z.record(z.string(), z.unknown()) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const bundle = readSandbox(run.sandbox).bundle;
      if (!bundle) throw notFound("Bundle not found");
      return bundle as unknown as Record<string, unknown>;
    },
  );

  app.post(
    "/internal/runs/:runId/workspace",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        body: z.object({ baseSha: GitCommitSha }),
        response: { 200: z.object({ baseSha: GitCommitSha }) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const baseSha = (request.body as { baseSha: string }).baseSha.toLowerCase();
      const [recorded] = await db
        .update(runs)
        .set({ workspaceBaseSha: baseSha, updatedAt: new Date() })
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id), isNull(runs.workspaceBaseSha)))
        .returning({ baseSha: runs.workspaceBaseSha });
      if (recorded?.baseSha) return { baseSha: recorded.baseSha };

      // Runner lifecycle requests may be replayed after a lost response. The
      // checkpoint is immutable: an exact replay succeeds, while a different
      // SHA cannot rewrite the provenance already bound to this run.
      const [current] = await db
        .select({ baseSha: runs.workspaceBaseSha })
        .from(runs)
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)))
        .limit(1);
      if (current?.baseSha === baseSha) return { baseSha };
      throw new ApiError(
        409,
        "workspace_base_mismatch",
        "Run workspace base commit was already recorded",
      );
    },
  );

  app.post(
    "/internal/runs/:runId/events",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        body: EventBatch,
        response: { 200: z.object({ count: z.number().int() }) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const events = await appendRunEvents(
        db,
        run.orgId,
        run.id,
        request.body as z.infer<typeof EventBatch>,
      );
      const sessionId = events
        .filter((event) => event.type === "session")
        .map((event) =>
          event.data && typeof event.data === "object" && !Array.isArray(event.data)
            ? (event.data as Record<string, unknown>).engine_session_id
            : undefined,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0 && value.length <= 255,
        );
      if (sessionId) {
        // Persist the provider session as soon as it is observed. A provider
        // lease can disappear before /result, but that must remain a resumable
        // interruption rather than erase the continuation handle.
        await db
          .update(runs)
          .set({ engineSessionId: sessionId.trim(), updatedAt: new Date() })
          .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id), isNull(runs.engineSessionId)));
      }
      if (events.some((event) => event.type === "agent_progress")) {
        await updateGithubRunProgress(db, run.id, "running", {
          config,
          githubClientFactory: app.githubClientFactory,
        }).catch(() => undefined);
      }
      return { count: events.length };
    },
  );

  app.get(
    "/internal/runs/:runId/steer",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        querystring: z.object({ ack: SteerAck, afterId: SteerAfterId }),
        response: { 200: z.array(z.record(z.string(), z.unknown())) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const { ack, afterId } = request.query as { ack?: string[]; afterId?: string };
      if (ack !== undefined && ack.length > 0) {
        // Delivery is recorded from the ack, not from the select that served the
        // batch: marking on the select loses a message whenever the response
        // drops on the wire — an operator's stop goes with it, and no error
        // surfaces anywhere. What the server enforces is exactly this much — a
        // row flips to delivered when a poll authenticated for its run names its
        // exact id inside that run's org. That the runner names an id only once
        // the message's durable action landed is the runner's half of the
        // contract: assumed here, not checked. Redelivery reaches that same
        // runner, because dispatch claims a run out of "queued" before launching
        // one sandbox for it, and /resume starts a new run id whose steer rows
        // are separate. Exact ids also spare a row that became visible only
        // after this ack was earned: ids come from per-process uuidv7 counters,
        // so two API tasks can commit one run's messages in an order that
        // disagrees with their id order, and a range ack would mark such a row
        // delivered without ever serving it.
        await db
          .update(steerMessages)
          .set({ deliveredAt: new Date() })
          .where(
            and(
              eq(steerMessages.orgId, run.orgId),
              eq(steerMessages.runId, run.id),
              // A delivery is written once. The runner re-sends an ack whose
              // response it never saw, and that replay names rows this statement
              // already marked: without this clause the replay would move their
              // timestamps, with it the update matches nothing at all. Applying
              // the same request twice therefore leaves the same rows in the same
              // state, which is what lets the runner retry an ambiguous poll.
              isNull(steerMessages.deliveredAt),
              inArray(steerMessages.id, ack),
            ),
          );
      }
      // Transitional, and deletable once no sandbox launched before this change
      // shipped can still be polling. A run keeps the runner image dispatch
      // launched its sandbox with, so during the deploy that ships this route
      // every run already in flight speaks the protocol this branch replaced: it
      // polls, applies what comes back, and starts the next poll with no delay of
      // its own, relying on the response to have retired the rows it just
      // applied. Its cursor cannot identify it — it has none until a batch gives
      // it one, so its first poll carries no parameter at all and looks exactly
      // like a poll acknowledging nothing. The ack parameter can: a runner built
      // after this change sends it on every poll, empty when it has nothing to
      // name, and one built before this change sends it at no point in its life.
      // So a request carrying no ack parameter gets the previous semantics for
      // that request — rows above the cursor when one came with it, marked
      // delivered by the select that served them — and a request carrying the
      // parameter, empty or not, is a runner that retires its own rows by id and
      // takes the path above, cursor beside it or not.
      const legacyPoll = ack === undefined;
      const cursor = legacyPoll ? afterId : undefined;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const messages = await db
          .select()
          .from(steerMessages)
          // Served under the same org scope the ack mutates: a row this run's
          // org cannot acknowledge is a row it must not be handed either, or the
          // channel wedges on a message that returns on every poll. No writer
          // makes such a row today: there are four — steer and interrupt over
          // /v1, and the two matching agent tools — and each resolves the run
          // inside the caller's org before stamping the row with that same org.
          // So this predicate is defence against a mis-scoped writer rather than
          // a hazard anything currently produces.
          .where(
            and(
              eq(steerMessages.orgId, run.orgId),
              eq(steerMessages.runId, run.id),
              isNull(steerMessages.deliveredAt),
              // Where the pre-ack route's id comparison lives now: on the
              // compatibility path and nowhere else, so what an ack poll is
              // served still depends on delivery alone.
              ...(cursor ? [gt(steerMessages.id, cursor)] : []),
            ),
          )
          // Send order, which is the order the agent must read them in. An ack
          // poll filters on deliveredAt alone, so the ordering no longer has to
          // double as a delivery filter. createdAt comes from now(), which rows
          // committed by a single transaction share exactly; id breaks that tie
          // so a batch at the limit below is deterministic.
          .orderBy(asc(steerMessages.createdAt), asc(steerMessages.id))
          .limit(STEER_BATCH);
        if (messages.length > 0) {
          if (legacyPoll) {
            // The compatibility path's mark-on-select, scoped exactly like the
            // ack update above, and run whether or not a cursor came with the
            // request: the first poll of a runner that predates the ack has no
            // cursor yet, and it needs its rows retired as much as any later one.
            // Such a poll has no way of its own to say what it handled, so this
            // response is the only thing that can retire these rows for it.
            await db
              .update(steerMessages)
              .set({ deliveredAt: new Date() })
              .where(
                and(
                  eq(steerMessages.orgId, run.orgId),
                  eq(steerMessages.runId, run.id),
                  isNull(steerMessages.deliveredAt),
                  inArray(
                    steerMessages.id,
                    messages.map((message) => message.id),
                  ),
                ),
              );
          }
          return messages;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return [];
    },
  );

  app.post(
    "/internal/runs/:runId/push-token",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        response: { 200: z.object({ token: z.string() }) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const sandbox = readSandbox(run.sandbox);
      const repoRef = await repoForRun(run, sandbox);
      if (!repoRef?.installationId) {
        throw new ApiError(409, "no_installation", "Run repository has no GitHub installation");
      }
      const installation = (
        await db
          .select()
          .from(githubInstallations)
          .where(eq(githubInstallations.id, repoRef.installationId))
          .limit(1)
      )[0];
      if (!installation) {
        throw new ApiError(409, "no_installation", "Run repository has no GitHub installation");
      }
      const tokenFactory =
        app.githubInstallationTokenFactory ?? createGithubInstallationTokenFactory(config);
      const token = await tokenFactory({
        installationId: installation.installationId,
        owner: repoRef.owner,
        repo: repoRef.name,
        permissions: { contents: "write" },
      });
      await insertAuditEvent(db, {
        orgId: run.orgId,
        projectId: run.projectId,
        actor: { type: "agent", id: run.id },
        action: "run.push_token_issued",
        target: { type: "run", id: run.id },
        payload: { repoId: repoRef.id },
      });
      return { token };
    },
  );

  app.post(
    "/internal/runs/:runId/transcript",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        response: { 200: z.object({ uri: z.string() }) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(400, "invalid_transcript", "Transcript body must be ndjson bytes");
      }
      if (request.body.length > TRANSCRIPT_MAX_BYTES) {
        throw new ApiError(413, "payload_too_large", "Transcript exceeds 50 MB");
      }
      const uri = await writeTranscriptObject({
        config,
        orgId: run.orgId,
        runId: run.id,
        body: request.body,
      });
      await db
        .update(runs)
        .set({ transcriptUri: uri, updatedAt: new Date() })
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
      return { uri };
    },
  );

  app.post(
    "/internal/runs/:runId/session-state",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: {
        params: Params,
        response: { 200: z.object({ uri: z.string() }) },
      },
    },
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(400, "invalid_session_state", "Session state body must be gzip bytes");
      }
      if (request.body.length > SESSION_STATE_MAX_BYTES) {
        throw new ApiError(413, "payload_too_large", "Session state exceeds 200 MB");
      }
      const uri = await writeSessionStateObject({
        config,
        orgId: run.orgId,
        runId: run.id,
        body: request.body,
      });
      await db
        .update(runs)
        .set({ sessionStateUri: uri, updatedAt: new Date() })
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
      return { uri };
    },
  );

  app.get(
    "/internal/runs/:runId/session-state",
    {
      config: { public: true },
      preHandler: authenticate,
      schema: { params: Params },
    },
    async (request, reply) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const sandbox = readSandbox(run.sandbox);
      const resume = sandbox.bundle?.resume;
      if (!resume?.sessionStateFrom) throw notFound("Session state not found");
      const parent = (
        await db
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.orgId, run.orgId),
              eq(runs.projectId, run.projectId),
              run.agentDefId ? eq(runs.agentDefId, run.agentDefId) : isNull(runs.agentDefId),
              eq(runs.id, resume.sessionStateFrom),
            ),
          )
          .limit(1)
      )[0];
      if (!parent) throw notFound("Session state not found");
      const body = await readSessionStateObject(config, parent.sessionStateUri, parent.orgId);
      return reply.type("application/gzip").send(body);
    },
  );

  app.post(
    "/internal/runs/:runId/result",
    {
      config: { public: true },
      preHandler: authenticateResult,
      schema: {
        params: Params,
        body: z.object({
          status: z.enum(["succeeded", "failed", "canceled"]),
          receipt: z.record(z.string(), z.unknown()).optional(),
          error: z.string().optional(),
          git: z
            .object({
              branch: z.string().optional(),
              headSha: z.string().optional(),
              baseSha: GitCommitSha.optional(),
              changed: z.boolean(),
              pushError: z.string().optional(),
              pullRequestTitle: z.string().optional(),
              pullRequestBody: z.string().optional(),
            })
            .optional(),
          engineSessionId: z.string().optional(),
          securityReport: z.unknown().optional(),
        }),
        response: { 200: z.record(z.string(), z.unknown()) },
      },
    },
    async (request, reply) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const body = request.body as {
        status: "succeeded" | "failed" | "canceled";
        receipt?: Record<string, unknown>;
        error?: string;
        git?: {
          branch?: string;
          headSha?: string;
          baseSha?: string;
          changed: boolean;
          pushError?: string;
          pullRequestTitle?: string;
          pullRequestBody?: string;
        };
        engineSessionId?: string;
        securityReport?: unknown;
      };
      try {
        return (await finishRun(db, run, body, {
          config,
          githubClientFactory: app.githubClientFactory,
          enqueue: app.enqueue,
        })) as unknown as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof FinalizationInProgressError)) throw error;
        // A replay while another attempt holds the finalization: the runner
        // retries a 503 on this endpoint and honors the wait, and the code is
        // exposed so the reply says what is being waited on rather than
        // masking it as an internal error.
        reply.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
        throw new ApiError(
          503,
          "finalization_in_progress",
          "Run finalization is in progress; retry after the lease expires",
          undefined,
          true,
        );
      }
    },
  );

  // The global clone token is a dev / single-tenant convenience. In a
  // production-serious deployment (no internal test session, !facilityInsecureDev) it would
  // let any tenant clone an arbitrary repo they named with a shared token, so it
  // is refused there — a repo needs a real GitHub App installation instead. This
  // mirrors the doctor's production posture and the gateway's dev-key fallback.
  const cloneTokenFallback = (): string | null =>
    config.facilityInsecureDev ? (config.githubCloneToken ?? null) : null;

  async function repoTokenForRun(sandbox: RunSandboxState): Promise<string | null> {
    const repo = sandbox.bundle?.repo;
    if (!repo?.installationTokenRef || !repo.cloneUrl) return cloneTokenFallback();
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repo.installationTokenRef))
        .limit(1)
    )[0];
    if (!installation) return cloneTokenFallback();
    const parsed = parseGithubCloneUrl(repo.cloneUrl);
    if (!parsed) return cloneTokenFallback();
    const tokenFactory =
      app.githubInstallationTokenFactory ??
      (config.githubAppId && config.githubAppPrivateKey
        ? createGithubInstallationTokenFactory(config)
        : null);
    if (!tokenFactory) return cloneTokenFallback();
    return tokenFactory({
      installationId: installation.installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      permissions: { contents: "read" },
    });
  }

  async function repoForRun(run: typeof runs.$inferSelect, sandbox: RunSandboxState) {
    const parsed = sandbox.bundle?.repo?.cloneUrl
      ? parseGithubCloneUrl(sandbox.bundle.repo.cloneUrl)
      : null;
    if (!parsed) return null;
    return (
      await db
        .select()
        .from(repos)
        .where(
          and(
            eq(repos.orgId, run.orgId),
            eq(repos.projectId, run.projectId),
            eq(repos.owner, parsed.owner),
            eq(repos.name, parsed.repo),
          ),
        )
        .limit(1)
    )[0];
  }

  async function securitySweepEvidenceForRun(
    run: typeof runs.$inferSelect,
    sandbox: RunSandboxState,
  ) {
    const repo = await repoForRun(run, sandbox);
    if (!repo?.installationId) {
      throw new ApiError(
        409,
        "security_sweep_repo_unavailable",
        "Security sweep repository installation is unavailable",
      );
    }
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.id, repo.installationId),
            eq(githubInstallations.orgId, run.orgId),
            isNull(githubInstallations.suspendedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!installation) {
      throw new ApiError(
        409,
        "security_sweep_installation_unavailable",
        "Security sweep GitHub installation is unavailable",
      );
    }
    const factory =
      app.githubClientFactory ??
      (config.githubAppId && config.githubAppPrivateKey ? createGithubClientFactory(config) : null);
    if (!factory) {
      throw new ApiError(
        409,
        "security_sweep_github_unavailable",
        "Security sweep GitHub client is unavailable",
      );
    }
    const ref = sandbox.bundle?.repo.branch;
    if (!ref) {
      throw new ApiError(
        409,
        "security_sweep_ref_unavailable",
        "Security sweep repository ref is unavailable",
      );
    }
    return collectGithubSecuritySweepEvidence({
      octokit: await factory(installation.installationId),
      runId: run.id,
      owner: repo.owner,
      repo: repo.name,
      ref,
    });
  }
}

function bearer(value: string | undefined) {
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

function parseGithubCloneUrl(value: string): { owner: string; repo: string } | null {
  const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

function isSecuritySweepMode(mode: string) {
  return ["security", "security_sweep"].includes(mode.replace(/^codex-/, "").replace(/-/g, "_"));
}
