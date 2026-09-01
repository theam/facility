import { hashKey, newId } from "@facility/core";
import {
  agentDefs,
  auditEvents,
  conversationMessages,
  conversations,
  createDb,
  migrate,
  projects,
  registryItems,
  runEvents,
  runs,
  seed,
  virtualKeys,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type FinalizationStep, finishRun } from "../src/sandbox/orchestrator.js";
import {
  appendRunEvents,
  RESULT_FINALIZATION_LEASE_MS,
  readSandbox,
} from "../src/sandbox/state.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 8).toString("base64");

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

// finishRun commits the terminal status first and only then does the work that
// follows it: reclaiming the sandbox and keys, the result and audit events, the
// conversation reply. A control plane that goes down inside that window has a
// run whose verdict is recorded and whose finalization is not, and the runner's
// replay of /result is the only party that comes back for it. These tests cut
// the first attempt at each depth of that window, replay the result through the
// route, and check that every effect lands exactly once — and that once it has,
// the route refuses the run as terminal like any other.
describe("result finalization after an interrupted terminal claim", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; finalization tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4402,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    packageRegistryToken: "package-token",
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let orgId = "";
  let projectId = "";
  let agentDefId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/__test/session",
      payload: { email: `finalization-${Date.now()}@example.com` },
    });
    orgId = login.json().orgId;
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Finalization Test Project",
          slug: `finalization-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = project?.id ?? "";
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `finalization-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("contract fixture missing");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `finalization-agent-${Date.now()}`,
          engine: "claude_code",
          model: {},
          contractItemId: contract.id,
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent fixture missing");
    agentDefId = agent.id;
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  // A conversation run with a live virtual key: the fixture that touches the
  // most steps after the claim — key revocation, the result event, the audit
  // row, and the conversation reply that unlocks the thread.
  async function conversationRun(label: string) {
    const token = `frt_${label}_${Date.now()}`;
    const runId = newId("run");
    const virtualKeyId = newId("vkey");
    const conversationId = newId("evt");
    const run = (
      await db
        .insert(runs)
        .values({
          id: runId,
          orgId,
          projectId,
          agentDefId,
          mode: "conversation",
          engine: "claude_code",
          status: "running",
          trigger: { type: "conversation", conversationId, message: "hello" },
          sandbox: { runnerTokenHash: await hashKey(token), virtualKeyId },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    await db.insert(virtualKeys).values({
      id: virtualKeyId,
      orgId,
      projectId,
      runId,
      name: `${label} run key`,
      prefix: `${label}_${Date.now()}`,
      last4: "0000",
      hash: `${label}-hash`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // Pinned to the run the way the message handler pins it at dispatch:
    // finishConversationTurn finalizes only the run the thread points at.
    await db.insert(conversations).values({
      id: conversationId,
      orgId,
      projectId,
      agentDefId,
      status: "running",
      lastRunId: runId,
      createdBy: { type: "user", id: "test" },
    });
    await appendRunEvents(db, orgId, run.id, [{ type: "assistant", data: { text: "the reply" } }]);
    return { run, token, conversationId, virtualKeyId };
  }

  async function finalizationState(runId: string, conversationId: string, virtualKeyId: string) {
    const [stored] = await db.select().from(runs).where(eq(runs.id, runId));
    const results = await db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "result")));
    const finished = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, orgId),
          eq(auditEvents.action, "run.finished"),
          sql`${auditEvents.target}->>'id' = ${runId}`,
        ),
      );
    const replies = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.runId, runId));
    const [conversation] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const [key] = await db
      .select({ revokedAt: virtualKeys.revokedAt })
      .from(virtualKeys)
      .where(eq(virtualKeys.id, virtualKeyId));
    return {
      status: stored?.status,
      sandbox: readSandbox(stored?.sandbox),
      resultEvents: results.length,
      finishedAudits: finished.length,
      replies: replies.length,
      conversationStatus: conversation?.status,
      keyRevoked: key?.revokedAt !== null,
    };
  }

  const body = { status: "succeeded" as const, engineSessionId: "sess_finalization" };

  // The wait the runner would have spent: the lease the dead attempt took at
  // its claim is moved back past its own length, so the next replay may take
  // it over.
  async function expireFinalizationLease(runId: string) {
    const expired = new Date(Date.now() - RESULT_FINALIZATION_LEASE_MS - 1_000).toISOString();
    await db
      .update(runs)
      .set({ sandbox: sql`${runs.sandbox} || ${JSON.stringify({ finalizingAt: expired })}::jsonb` })
      .where(eq(runs.id, runId));
  }

  async function postResult(runId: string, token: string) {
    return app.inject({
      method: "POST",
      url: `/internal/runs/${runId}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  // One case per depth of the window: the attempt is cut right after the claim,
  // after the keys are revoked, after the result event, and after the audit row
  // — so a resumed attempt has to skip a different prefix of the work each time.
  it.each<{ interruptAfter: FinalizationStep; before: Record<string, unknown> }>([
    {
      interruptAfter: "claim",
      before: { keyRevoked: false, resultEvents: 0, finishedAudits: 0, replies: 0 },
    },
    {
      interruptAfter: "keys",
      before: { keyRevoked: true, resultEvents: 0, finishedAudits: 0, replies: 0 },
    },
    {
      interruptAfter: "result_event",
      before: { keyRevoked: true, resultEvents: 1, finishedAudits: 0, replies: 0 },
    },
    {
      interruptAfter: "audit",
      before: { keyRevoked: true, resultEvents: 1, finishedAudits: 1, replies: 0 },
    },
  ])("resumes a finalization interrupted after $interruptAfter and completes it exactly once", async ({
    interruptAfter,
    before,
  }) => {
    const { run, token, conversationId, virtualKeyId } = await conversationRun(
      `resume_${interruptAfter}`,
    );

    // The first attempt: the control plane dies at the chosen step. The claim
    // is committed, whatever came after it is not.
    await expect(
      finishRun(db, run, body, {
        afterFinalizationStep: (step) => {
          if (step === interruptAfter) throw new Error("control plane restarted");
        },
      }),
    ).rejects.toThrow("control plane restarted");
    const interrupted = await finalizationState(run.id, conversationId, virtualKeyId);
    expect(interrupted).toMatchObject({ status: "succeeded", ...before });
    expect(interrupted.sandbox.finishedAt).toEqual(expect.any(String));
    expect(interrupted.sandbox.finalizedAt).toBeUndefined();
    expect(interrupted.conversationStatus).toBe("running");

    // The runner's replay of the same result, through the route. Admitted
    // although the run is terminal, because its finalization is pending — but
    // not before the dead attempt's lease has run out.
    const early = await postResult(run.id, token);
    expect(early.statusCode).toBe(503);
    expect(early.json().error.code).toBe("finalization_in_progress");
    expect(Number(early.headers["retry-after"])).toBeGreaterThan(0);
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toMatchObject(before);
    await expireFinalizationLease(run.id);
    const replay = await postResult(run.id, token);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: run.id, status: "succeeded" });
    const resumed = await finalizationState(run.id, conversationId, virtualKeyId);
    expect(resumed).toMatchObject({
      status: "succeeded",
      keyRevoked: true,
      resultEvents: 1,
      finishedAudits: 1,
      replies: 1,
      conversationStatus: "idle",
    });
    expect(resumed.sandbox.finalizedAt).toEqual(expect.any(String));

    // Finalized, the run is terminal to every request, this one included, and
    // a further replay changes nothing.
    const again = await postResult(run.id, token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("run_terminal");
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toEqual(resumed);
  });

  it("finalizes an uninterrupted result once and refuses its replay", async () => {
    const { run, token, conversationId, virtualKeyId } = await conversationRun("uninterrupted");
    const first = await postResult(run.id, token);
    expect(first.statusCode).toBe(200);
    const finalized = await finalizationState(run.id, conversationId, virtualKeyId);
    expect(finalized).toMatchObject({
      status: "succeeded",
      keyRevoked: true,
      resultEvents: 1,
      finishedAudits: 1,
      replies: 1,
      conversationStatus: "idle",
    });
    expect(finalized.sandbox.finalizedAt).toEqual(expect.any(String));
    const replay = await postResult(run.id, token);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("run_terminal");
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toEqual(finalized);
  });

  it("admits only /result into the pending window, and only with the run's token", async () => {
    const { run, token } = await conversationRun("window");
    await expect(
      finishRun(db, run, body, {
        afterFinalizationStep: (step) => {
          if (step === "claim") throw new Error("control plane restarted");
        },
      }),
    ).rejects.toThrow("control plane restarted");

    // Every other runner route has nothing left to do for a run whose verdict
    // is committed, pending finalization or not.
    const events = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "log", data: { line: "late" } }],
    });
    expect(events.statusCode).toBe(409);
    expect(events.json().error.code).toBe("run_terminal");

    // The admission is a narrowing of the terminal refusal, not of the token
    // check: a replay with the wrong token is refused like any other request.
    const forged = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/result`,
      headers: { authorization: "Bearer frt_not_this_run" },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
    const [stored] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(readSandbox(stored?.sandbox).finalizedAt).toBeUndefined();
  });

  it("lets one replay take over an expired lease and holds the rest off", async () => {
    // The attempt a rolling restart cut the runner off from may still be
    // running on the old process while the runner replays to the new one, so
    // a replay never runs the steps beside another attempt: it waits the lease
    // out, and of two replays that arrive on an expired lease only one runs.
    const { run, token, conversationId, virtualKeyId } = await conversationRun("lease");
    await expect(
      finishRun(db, run, body, {
        afterFinalizationStep: (step) => {
          if (step === "claim") throw new Error("control plane restarted");
        },
      }),
    ).rejects.toThrow("control plane restarted");
    await expireFinalizationLease(run.id);
    // Two replays on the expired lease at once: the takeover is one atomic
    // update, so exactly one wins it, and the other sees a lease just renewed.
    const [first, second] = await Promise.all([
      postResult(run.id, token),
      postResult(run.id, token),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 503]);
    const held = first.statusCode === 503 ? first : second;
    expect(held.json().error.code).toBe("finalization_in_progress");
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toMatchObject({
      keyRevoked: true,
      resultEvents: 1,
      finishedAudits: 1,
      replies: 1,
      conversationStatus: "idle",
    });
  });

  // A first attempt paused inside the named step, and the promise that lets
  // the test resume it. The two lease tests below both hold an attempt open
  // past the lease; they differ in whether its heartbeat is running.
  function attemptHeldAt(
    step: FinalizationStep,
    run: (typeof runs)["$inferSelect"],
    renewMs: number,
  ) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked!: () => void;
    const reached = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const attempt = finishRun(db, run, body, {
      finalizationLeaseRenewMs: renewMs,
      afterFinalizationStep: async (at) => {
        if (at !== step) return;
        blocked();
        await held;
      },
    });
    return { attempt, reached, release };
  }

  async function storedFinalizingAt(runId: string) {
    const [stored] = await db
      .select({ sandbox: runs.sandbox })
      .from(runs)
      .where(eq(runs.id, runId));
    return Date.parse(readSandbox(stored?.sandbox).finalizingAt ?? "");
  }

  it("renews the lease under a live attempt that outlasts it, so a replay waits instead of taking over", async () => {
    // Finalization can legitimately run longer than the lease — a security
    // sync can spend minutes on GitHub — so an attempt renews for as long as
    // it works. An attempt alive past the lease therefore still looks held to
    // the runner's replay, which waits on a 503 rather than running the steps
    // beside it and duplicating their effects.
    const { run, token, conversationId, virtualKeyId } = await conversationRun("renewal");
    const first = attemptHeldAt("keys", run, 25);
    await first.reached;
    // Age the lease past expiry under the working attempt — standing in for
    // the wait the test cannot spend — and watch the heartbeat re-freshen it.
    await expireFinalizationLease(run.id);
    let renewed = false;
    for (let i = 0; i < 500 && !renewed; i++) {
      const at = await storedFinalizingAt(run.id);
      renewed = Number.isFinite(at) && Date.now() - at < RESULT_FINALIZATION_LEASE_MS;
      if (!renewed) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(renewed).toBe(true);
    const replay = await postResult(run.id, token);
    expect(replay.statusCode).toBe(503);
    expect(replay.json().error.code).toBe("finalization_in_progress");
    // No takeover: nothing past the step the attempt is paused in has run.
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toMatchObject({
      keyRevoked: true,
      resultEvents: 0,
      finishedAudits: 0,
      replies: 0,
    });
    first.release();
    await expect(first.attempt).resolves.toMatchObject({ id: run.id, status: "succeeded" });
    const finalized = await finalizationState(run.id, conversationId, virtualKeyId);
    expect(finalized).toMatchObject({
      status: "succeeded",
      keyRevoked: true,
      resultEvents: 1,
      finishedAudits: 1,
      replies: 1,
      conversationStatus: "idle",
    });
    expect(finalized.sandbox.finalizedAt).toEqual(expect.any(String));
    const again = await postResult(run.id, token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("run_terminal");
  });

  it("aborts a stalled attempt a replay superseded before it repeats an effect", async () => {
    // The other half of the fence: an attempt that really did stop renewing —
    // its process stalled — loses the lease to the replay. When it wakes it
    // must discover that at its next step boundary and abort, not run the
    // remaining steps beside the winner: the per-step guards are idempotency
    // guards, and two concurrent attempts could each see an effect missing and
    // create it twice.
    const { run, token, conversationId, virtualKeyId } = await conversationRun("superseded");
    // A renewal cadence far past the test stands in for the stall.
    const first = attemptHeldAt("keys", run, 600_000);
    await first.reached;
    await expireFinalizationLease(run.id);
    // The replay takes the expired lease over and finalizes everything.
    const replay = await postResult(run.id, token);
    expect(replay.statusCode).toBe(200);
    const won = await finalizationState(run.id, conversationId, virtualKeyId);
    expect(won).toMatchObject({
      status: "succeeded",
      keyRevoked: true,
      resultEvents: 1,
      finishedAudits: 1,
      replies: 1,
      conversationStatus: "idle",
    });
    expect(won.sandbox.finalizedAt).toEqual(expect.any(String));
    // The stalled attempt wakes into a lease it no longer holds: the renewal
    // compare-and-set at its next boundary fails against the winner's token,
    // and it surfaces the same 503 a waiting replay gets — whose retry the
    // finished run then refuses as run_terminal — with every effect counted
    // exactly once.
    first.release();
    await expect(first.attempt).rejects.toThrow("Run finalization is in progress");
    expect(await finalizationState(run.id, conversationId, virtualKeyId)).toEqual(won);
  });

  it("refuses a result for a run another path made terminal", async () => {
    // A failRun or a cancel commits its terminal status without finishRun's
    // claim, so the run carries no finishedAt: there is no finalization of a
    // result to resume, and the runner's late verdict is refused as before.
    const token = `frt_failed_${Date.now()}`;
    const run = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId,
          projectId,
          mode: "builder",
          engine: "byo",
          status: "failed",
          error: "sandbox_lost",
          trigger: {},
          sandbox: { runnerTokenHash: await hashKey(token) },
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!run) throw new Error("run fixture missing");
    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("run_terminal");
    const results = await db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "result")));
    expect(results).toHaveLength(0);
  });
});
