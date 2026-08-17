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
import { finishRun, updateGithubRunProgress } from "../sandbox/orchestrator.js";
import {
  appendRunEvents,
  type RunSandboxState,
  readSandbox,
  terminalStatus,
} from "../sandbox/state.js";
import type { AppConfig } from "../types.js";

const Params = z.object({ runId: z.string() });
// Exactly what newId("evt") produces. An ack names rows to mutate, so this
// route takes only ids it could have issued: a list carrying anything else is
// refused whole, before any of it reaches a query.
const ACK_ID = /^evt_[0-9a-f]{32}$/;
// An ack can only name ids from a batch this route served, and STEER_BATCH caps
// a batch. The bound stays above that so it remains a sanity limit on the query
// rather than something a change to the batch size silently invalidates.
export const STEER_ACK_MAX = 32;
const STEER_BATCH = 10;
// One ack parameter, or several, each holding a comma-separated list. Exported
// so the id rule can be tested as a rule: from outside the route every refusal
// is the same 400, which says nothing about which shapes the rule refuses.
export const SteerAck = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    value === undefined
      ? []
      : (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(",")),
  )
  .refine(
    (ids) => ids.length <= STEER_ACK_MAX && ids.every((id) => ACK_ID.test(id)),
    `ack takes up to ${STEER_ACK_MAX} comma-separated message ids`,
  );
// The cursor this route took before the ack. A request carrying it marks rows
// delivered, so it is held to the same id rule for the same reason: only an id
// this route could have issued reaches a query, and a list — which the cursor
// never was — is refused outright.
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

  async function authenticate(request: FastifyRequest) {
    const { runId } = request.params as { runId: string };
    const token = bearer(request.headers.authorization);
    if (!token) throw new ApiError(401, "unauthorized", "Runner token required");
    const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
    if (!run) throw notFound("Run not found");
    if (terminalStatus(run.status)) throw new ApiError(409, "run_terminal", "Run is terminal");
    const sandbox = readSandbox(run.sandbox);
    if (!sandbox.runnerTokenHash || !(await verifyKey(token, sandbox.runnerTokenHash))) {
      throw new ApiError(401, "unauthorized", "Invalid runner token");
    }
    (request as RunnerRequest).runnerRun = run;
  }

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
      const { ack, afterId } = request.query as { ack: string[]; afterId?: string };
      if (ack.length > 0) {
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
              isNull(steerMessages.deliveredAt),
              inArray(steerMessages.id, ack),
            ),
          );
      }
      // Transitional, and deletable once no sandbox launched before this change
      // shipped can still be polling. A run keeps the runner image dispatch
      // launched its sandbox with, so during the deploy that ships this route
      // every run already in flight speaks the protocol this branch replaced: it
      // polls with afterId, applies what comes back, and starts the next poll
      // with no delay of its own, relying on the response to have retired the
      // rows it just applied. Served by the ack path alone, that poll marks
      // nothing, so it is handed the same rows again on every iteration — one
      // more copy of the same steer body appended per iteration, as fast as this
      // route can answer. So a request that names no ack and does carry the
      // cursor — which no runner built after this change sends — gets the
      // previous semantics back for that request: rows above the cursor, marked
      // delivered by the select that served them. Anything carrying an ack is a
      // runner that retires its own rows by id and takes the path above, cursor
      // beside it or not.
      const cursor = ack.length > 0 ? undefined : afterId;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const messages = await db
          .select()
          .from(steerMessages)
          // Served under the same org scope the ack mutates: a row this run's
          // org cannot acknowledge is a row it must not be handed either, or the
          // channel wedges on a message that returns on every poll.
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
          if (cursor) {
            // The compatibility path's mark-on-select, scoped exactly like the
            // ack update above. A poll that predates the ack has no other way to
            // say what it handled, so this response is the only thing that can
            // retire these rows for it.
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
      preHandler: authenticate,
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
    async (request) => {
      const run = (request as RunnerRequest).runnerRun;
      if (!run) throw notFound("Run not found");
      const body = request.body as {
        status: "succeeded" | "failed" | "canceled";
        receipt?: Record<string, unknown>;
        error?: string;
        git?: {
          branch?: string;
          headSha?: string;
          changed: boolean;
          pushError?: string;
          pullRequestTitle?: string;
          pullRequestBody?: string;
        };
        engineSessionId?: string;
        securityReport?: unknown;
      };
      return (await finishRun(db, run, body, {
        config,
        githubClientFactory: app.githubClientFactory,
        enqueue: app.enqueue,
      })) as unknown as Record<string, unknown>;
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
