/**
 * Regression tests for the three review findings on #308. Each fixture is
 * modelled on the writer that produces it, not on a description of it:
 *
 * - The dispatcher claims a turn (`running`, `startedAt` set) before the
 *   budget check, and only reaches `TurnGitEvidenceService.start()` after
 *   credentials and environment preparation. A turn rejected in between
 *   settles `failed` with `startedAt` set and neither telling written.
 * - `start()` writes the row and then the context event; `complete()` logs
 *   commits `--reverse`, so a telling's commit list ends at its final SHA.
 * - The mirror stores branch heads by name, pull heads by head ref, and one
 *   CI observation per GitHub event, so a busy pull reports one head many
 *   times.
 */
import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubBranches,
  githubCiEvents,
  githubInstallations,
  githubPullRequests,
  migrate,
  orgs,
  projectRepositories,
  projects,
  stories,
  storyConversations,
  storyEvidenceEvents,
  turnGitEvidence,
  turns,
  workspaces,
} from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDeliveryRecord, witnessObservations } from "../src/stories/delivery-record.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("delivery-record review findings", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; delivery-record review tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const storyId = newId("story");
  const conversationId = newId("sess");
  const workspaceId = newId("ws");
  const installationId = newId("ghi");
  const repositoryId = newId("repo");
  const pullNumber = 7;
  const branch = "facility/story";

  const sha = (fill: string) => fill.repeat(40).slice(0, 40);
  const sessionOf = (turnId: string) => `${turnId}:session`;
  const commit = (s: string) => ({
    sha: s,
    author: "Builder",
    authoredAt: "2026-09-06T10:00:00+00:00",
    subject: "feat: work",
  });

  function turnRow(id: string, state: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      orgId,
      projectId,
      storyId,
      conversationId,
      agentName: "builder",
      manifestHash: "hash",
      manifest: {},
      engine: "codex",
      model: "gpt-5.6-sol",
      state,
      triggerType: "mcp",
      startedAt: new Date("2026-09-06T09:58:00Z"),
      endedAt: new Date("2026-09-06T10:00:00Z"),
      createdBy: { type: "user", id: "maintainer" },
      ...overrides,
    };
  }

  function evidenceRow(turnId: string, overrides: Record<string, unknown> = {}) {
    return {
      turnId,
      orgId,
      projectId,
      storyId,
      workspaceId,
      engineSessionId: sessionOf(turnId),
      initialBranch: branch,
      initialSha: sha("0"),
      finalBranch: branch,
      finalSha: sha("a"),
      commits: [commit(sha("a"))],
      changedFiles: [{ status: "M", path: "src/app.ts" }],
      dirty: false,
      completedAt: new Date("2026-09-06T10:00:00Z"),
      ...overrides,
    };
  }

  function gitEvent(turnId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: newId("evid"),
      orgId,
      projectId,
      storyId,
      turnId,
      source: "workspace" as const,
      type: "git.changes_recorded",
      externalKey: `turn:${turnId}:git`,
      occurredAt: new Date("2026-09-06T10:00:00Z"),
      data: {
        initialSha: sha("0"),
        finalSha: sha("a"),
        commits: [commit(sha("a"))],
        changedFiles: [{ status: "M", path: "src/app.ts" }],
        dirty: false,
        ...overrides,
      },
    };
  }

  function contextEvent(turnId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: newId("evid"),
      orgId,
      projectId,
      storyId,
      turnId,
      source: "workspace" as const,
      type: "turn.context_recorded",
      externalKey: `turn:${turnId}:context`,
      occurredAt: new Date("2026-09-06T09:59:00Z"),
      data: {
        agent: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        sessionId: sessionOf(turnId),
        nativeSessionId: null,
        workspaceId,
        workspaceProvider: "fake",
        branch,
        initialSha: sha("0"),
        ...overrides,
      },
    };
  }

  function ciEvent(headSha: string) {
    return {
      id: newId("cie"),
      orgId,
      projectId,
      repositoryId,
      pullNumber,
      headSha,
      state: "success",
    };
  }

  // Finding 1 — unstarted captures
  const budgetTurnId = newId("turn"); // failed at the budget check: claimed, never captured
  const queuedCancelTurnId = newId("turn"); // canceled while queued: never claimed
  const rowLostTurnId = newId("turn"); // failed after start(): context event survives, row destroyed
  const succeededHoleTurnId = newId("turn"); // succeeded, both tellings destroyed
  // Finding 2 — blame from SHA presence alone
  const staleTurnId = newId("turn"); // row's finalSha overwritten with the turn's own starting SHA
  const foreignTurnId = newId("turn"); // row's finalSha is a head GitHub saw on an unrelated branch
  const honestTurnId = newId("turn"); // event's finalSha corrupted; GitHub saw the row's on the branch
  const noopTurnId = newId("turn"); // no commits: final == initial is an honest, witnessable no-op
  // Finding 3 — bounded witness reads
  const busyTurnId = newId("turn"); // one head, reported by GitHub 1,001 times

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Review", slug: `review-${suffix}`, settings: {} });
    await db
      .insert(projects)
      .values({ id: projectId, orgId, name: "Review", slug: `review-${suffix}`, settings: {} });
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 500_000,
      accountId: 1,
      accountLogin: "acme",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      installationId,
      owner: "acme",
      name: `review-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:308",
      title: "Address the review",
      status: "working",
      branch,
      createdBy: { type: "user", id: "maintainer" },
    });
    await db.insert(storyConversations).values({ id: conversationId, orgId, projectId, storyId });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      projectId,
      storyId,
      provider: "fake",
      volumeRef: `memory://${workspaceId}`,
      state: "running",
    });

    await db.insert(turns).values([
      // exactly as StoryWorkspaceService.failTurn leaves a turn the dispatcher claimed
      turnRow(budgetTurnId, "failed", { error: "Project monthly budget is exhausted" }),
      // exactly as cancelTurn leaves a turn that was never claimed
      turnRow(queuedCancelTurnId, "canceled", { startedAt: null, error: null }),
      turnRow(rowLostTurnId, "failed", { error: "engine crashed" }),
      turnRow(succeededHoleTurnId, "succeeded"),
      turnRow(staleTurnId, "succeeded"),
      turnRow(foreignTurnId, "succeeded"),
      turnRow(honestTurnId, "succeeded"),
      turnRow(noopTurnId, "succeeded"),
      turnRow(busyTurnId, "succeeded"),
    ]);

    await db.insert(turnGitEvidence).values([
      // stale: the writer's own initial SHA landed in finalSha; commits still end at s
      evidenceRow(staleTurnId, { finalSha: sha("0"), commits: [commit(sha("s"))] }),
      evidenceRow(foreignTurnId, { finalSha: sha("x"), commits: [commit(sha("x"))] }),
      evidenceRow(honestTurnId, { finalSha: sha("h"), commits: [commit(sha("h"))] }),
      evidenceRow(noopTurnId, { finalSha: sha("0"), commits: [], changedFiles: [] }),
      evidenceRow(busyTurnId, { finalSha: sha("c"), commits: [commit(sha("c"))] }),
    ]);

    await db.insert(storyEvidenceEvents).values([
      contextEvent(rowLostTurnId),
      contextEvent(staleTurnId),
      gitEvent(staleTurnId, { finalSha: sha("s"), commits: [commit(sha("s"))] }),
      contextEvent(foreignTurnId),
      gitEvent(foreignTurnId, { finalSha: sha("y"), commits: [commit(sha("y"))] }),
      contextEvent(honestTurnId),
      // only the event's finalSha was corrupted; its commits still end at h
      gitEvent(honestTurnId, { finalSha: sha("g"), commits: [commit(sha("h"))] }),
      contextEvent(noopTurnId),
      gitEvent(noopTurnId, { finalSha: sha("0"), commits: [], changedFiles: [] }),
      contextEvent(busyTurnId),
      gitEvent(busyTurnId, { finalSha: sha("c"), commits: [commit(sha("c"))] }),
    ]);

    // GitHub's record, as the mirror stores it.
    await db.insert(githubBranches).values([
      { id: newId("ghb"), orgId, projectId, repositoryId, name: branch, headSha: sha("h") },
      {
        id: newId("ghb"),
        orgId,
        projectId,
        repositoryId,
        name: "totally/unrelated",
        headSha: sha("x"),
      },
    ]);
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repositoryId,
      number: pullNumber,
      title: "Address the review",
      state: "open",
      headRef: branch,
      headSha: sha("p"),
      baseRef: "main",
      htmlUrl: `https://github.com/acme/review-${suffix}/pull/${pullNumber}`,
    });
    // CI once reported the branch's earlier head (the stale turn's starting point) …
    await db.insert(githubCiEvents).values(ciEvent(sha("0")));
    // … and reported the busy turn's head 1,001 times.
    const busy = Array.from({ length: 1_001 }, () => ciEvent(sha("c")));
    for (let index = 0; index < busy.length; index += 200) {
      await db.insert(githubCiEvents).values(busy.slice(index, index + 200));
    }
  });

  afterAll(async () => {
    await client.end();
  });

  describe("unstarted captures are the lifecycle, not a hole", () => {
    it("a turn the budget rejected after the dispatcher claimed it is not a finding", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.findings.filter((f) => f.turnId === budgetTurnId)).toEqual([]);
    });

    it("a turn canceled while still queued is not a finding", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.findings.filter((f) => f.turnId === queuedCancelTurnId)).toEqual([]);
    });

    it("both are counted as unstarted so coverage stays visible", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.checkedTurns).toBe(9);
      expect(report.unstartedCaptures).toBe(2);
    });

    it("a failed turn whose context event survives but whose row is gone is still a hole", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const finding = report.findings.find((f) => f.turnId === rowLostTurnId);
      expect(finding).toMatchObject({ check: "completeness", shape: "missing-evidence" });
    });

    it("a succeeded turn with neither telling is still a hole: success cannot skip capture", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const finding = report.findings.find((f) => f.turnId === succeededHoleTurnId);
      expect(finding).toMatchObject({ check: "completeness", shape: "missing-evidence" });
    });
  });

  describe("the witness corroborates a telling, never convicts from presence alone", () => {
    it("the turn's own starting SHA in finalSha does not convict the correct event", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === staleTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "divergent" }]);
      expect(findings[0]?.detail).toContain("finalSha");
    });

    it("a head GitHub saw on an unrelated branch does not convict the event", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === foreignTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "divergent" }]);
    });

    it("a head GitHub saw on the turn's branch, ending the row's own commits, still convicts", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === honestTurnId);
      expect(findings).toMatchObject([{ check: "attribution", shape: "witness-disagrees" }]);
      expect(findings[0]?.detail).toContain("the evidence event drifted");
    });

    it("an honest no-op turn is witnessed by its unchanged head; the stale turn is not", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      // honest (h on the branch), noop (0 on the branch's pull), busy (c on the pull)
      expect(report.witnessedTurns).toBe(3);
      expect(report.findings.filter((f) => f.turnId === noopTurnId)).toEqual([]);
    });
  });

  describe("witness reads are bounded by the page, not by GitHub's chatter", () => {
    it("1,001 CI observations of one head come back as one (sha, branch) pair", async () => {
      const seen = await witnessObservations(db, { orgId, projectId }, [sha("c")]);
      expect(seen).toEqual([{ sha: sha("c"), branch }]);
    });

    it("a page asking about n SHAs never loads more pairs than the mirror holds for them", async () => {
      const seen = await witnessObservations(db, { orgId, projectId }, [
        sha("c"),
        sha("0"),
        sha("h"),
        sha("x"),
        sha("never"),
      ]);
      expect(seen).toHaveLength(4);
      expect(new Set(seen.map((s) => s.sha))).toEqual(
        new Set([sha("c"), sha("0"), sha("h"), sha("x")]),
      );
    });
  });
});
