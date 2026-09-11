import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubBranches,
  githubInstallations,
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
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDeliveryRecord } from "../src/stories/delivery-record.js";

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

describe("delivery-record checks", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; delivery-record tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const otherOrgId = newId("org");
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const installationId = newId("ghi");
  const repositoryId = newId("repo");
  const storyId = newId("story");
  const conversationId = newId("sess");
  const workspaceId = newId("ws");

  const cleanTurnId = newId("turn");
  const failedTurnId = newId("turn");
  const runningTurnId = newId("turn");
  const holeTurnId = newId("turn");
  const divergentTurnId = newId("turn");
  const eventlessTurnId = newId("turn");

  const sha = (fill: string) => fill.repeat(40).slice(0, 40);
  // The engine session a turn ran in: the row and the context event must name the same one.
  const sessionOf = (turnId: string) => `${turnId}:session`;

  function turnRow(id: string, state: string) {
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
      createdBy: { type: "user", id: "maintainer" },
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
      initialBranch: "facility/story",
      initialSha: sha("0"),
      finalBranch: "facility/story",
      finalSha: sha("a"),
      commits: [
        {
          sha: sha("a"),
          author: "Builder",
          authoredAt: "2026-09-06T10:00:00+00:00",
          subject: "feat: work",
        },
      ],
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
        commits: [
          {
            sha: sha("a"),
            author: "Builder",
            authoredAt: "2026-09-06T10:00:00+00:00",
            subject: "feat: work",
          },
        ],
        changedFiles: [{ status: "M", path: "src/app.ts" }],
        dirty: false,
        ...overrides,
      },
    };
  }

  // The event the captureError path writes, under the same key as a completed capture.
  function captureFailedEvent(turnId: string) {
    return {
      id: newId("evid"),
      orgId,
      projectId,
      storyId,
      turnId,
      source: "workspace" as const,
      type: "git.capture_failed",
      externalKey: `turn:${turnId}:git`,
      occurredAt: new Date("2026-09-06T10:00:00Z"),
      data: { initialSha: sha("0"), error: "workspace unreachable during settle" },
    };
  }

  // The start-side telling, written before the engine runs.
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
        branch: "facility/story",
        initialSha: sha("0"),
        ...overrides,
      },
    };
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db.insert(orgs).values([
      { id: orgId, name: "Record", slug: `record-${suffix}`, settings: {} },
      { id: otherOrgId, name: "OtherRecord", slug: `other-record-${suffix}`, settings: {} },
    ]);
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Record", slug: `record-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId: otherOrgId,
        name: "Other",
        slug: `other-${suffix}`,
        settings: {},
      },
    ]);
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
      name: `record-${suffix}`,
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      repositoryId,
      provider: "github",
      externalId: "issue:99",
      title: "Deliver with a verifiable record",
      status: "working",
      branch: "facility/story",
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

    await db
      .insert(turns)
      .values([
        turnRow(cleanTurnId, "succeeded"),
        turnRow(failedTurnId, "failed"),
        turnRow(runningTurnId, "running"),
        turnRow(holeTurnId, "succeeded"),
        turnRow(divergentTurnId, "succeeded"),
        turnRow(eventlessTurnId, "succeeded"),
      ]);

    await db.insert(turnGitEvidence).values([
      // clean: completed capture + matching event
      evidenceRow(cleanTurnId),
      // failed turn whose capture failed explicitly: completeness satisfied
      evidenceRow(failedTurnId, {
        finalSha: null,
        finalBranch: null,
        commits: [],
        changedFiles: [],
        captureError: "workspace unreachable during settle",
      }),
      // divergent: row says finalSha=a, event will say finalSha=b
      evidenceRow(divergentTurnId),
      // eventless: completed capture, no git event inserted
      evidenceRow(eventlessTurnId),
      // holeTurnId deliberately gets NO row at all
    ]);

    await db
      .insert(storyEvidenceEvents)
      .values([
        gitEvent(cleanTurnId),
        gitEvent(divergentTurnId, { finalSha: sha("b") }),
        captureFailedEvent(failedTurnId),
        contextEvent(cleanTurnId),
        contextEvent(failedTurnId),
        contextEvent(divergentTurnId),
        contextEvent(eventlessTurnId),
      ]);
  });

  afterAll(async () => {
    await client.end();
  });

  it("reports a clean lifecycle with zero findings and counts only settled turns", async () => {
    const report = await verifyDeliveryRecord(db, { orgId, projectId });
    expect(report.checkedTurns).toBe(5); // running turn excluded
    expect(report.findings.filter((f) => f.turnId === cleanTurnId)).toEqual([]);
    // explicit captureError paired with its capture_failed event is an honest settle
    expect(report.findings.filter((f) => f.turnId === failedTurnId)).toEqual([]);
  });

  it("finds the settled turn whose evidence row is missing entirely", async () => {
    const report = await verifyDeliveryRecord(db, { orgId, projectId });
    const finding = report.findings.find((f) => f.turnId === holeTurnId);
    expect(finding).toMatchObject({ check: "completeness", shape: "missing-evidence" });
  });

  it("finds the completed capture whose story evidence event was destroyed", async () => {
    const report = await verifyDeliveryRecord(db, { orgId, projectId });
    const finding = report.findings.find((f) => f.turnId === eventlessTurnId);
    expect(finding).toMatchObject({ check: "coherence", shape: "missing-event" });
  });

  it("finds the two ledgers disagreeing about the final SHA", async () => {
    const report = await verifyDeliveryRecord(db, { orgId, projectId });
    const finding = report.findings.find((f) => f.turnId === divergentTurnId);
    expect(finding).toMatchObject({ check: "coherence", shape: "divergent" });
    expect(finding?.detail).toContain("finalSha");
  });

  it("finds a capture that silently never settled once its error is erased", async () => {
    await db
      .update(turnGitEvidence)
      .set({ captureError: null })
      .where(and(eq(turnGitEvidence.orgId, orgId), eq(turnGitEvidence.turnId, failedTurnId)));
    const report = await verifyDeliveryRecord(db, { orgId, projectId });
    const finding = report.findings.find((f) => f.turnId === failedTurnId);
    expect(finding).toMatchObject({ check: "completeness", shape: "unsettled-capture" });
    // put the honest error back for the suites below
    await db
      .update(turnGitEvidence)
      .set({ captureError: "workspace unreachable during settle" })
      .where(and(eq(turnGitEvidence.orgId, orgId), eq(turnGitEvidence.turnId, failedTurnId)));
  });

  it("never inspects another org's record", async () => {
    const report = await verifyDeliveryRecord(db, {
      orgId: otherOrgId,
      projectId: otherProjectId,
    });
    expect(report.checkedTurns).toBe(0);
    expect(report.findings).toEqual([]);
  });

  describe("attribution: GitHub as witness", () => {
    // Two more settled turns whose ledgers disagree, added before the witness arrives.
    const driftedRowTurnId = newId("turn");
    const unwitnessedTurnId = newId("turn");

    beforeAll(async () => {
      await db
        .insert(turns)
        .values([turnRow(driftedRowTurnId, "succeeded"), turnRow(unwitnessedTurnId, "succeeded")]);
      await db.insert(turnGitEvidence).values([
        // row says e, event will say f; GitHub will report f
        evidenceRow(driftedRowTurnId, { finalSha: sha("e") }),
        // row says c, event will say d; GitHub reports neither
        evidenceRow(unwitnessedTurnId, { finalSha: sha("c") }),
      ]);
      await db
        .insert(storyEvidenceEvents)
        .values([
          gitEvent(driftedRowTurnId, { finalSha: sha("f") }),
          gitEvent(unwitnessedTurnId, { finalSha: sha("d") }),
          contextEvent(driftedRowTurnId),
          contextEvent(unwitnessedTurnId),
        ]);
      // The witness: head SHAs GitHub reported, as the mirror stores them.
      await db.insert(githubBranches).values([
        {
          id: newId("ghb"),
          orgId,
          projectId,
          repositoryId,
          name: "facility/story",
          headSha: sha("a"),
        },
        { id: newId("ghb"), orgId, projectId, repositoryId, name: "feature/f", headSha: sha("f") },
      ]);
    });

    it("counts the settled turns whose final SHA GitHub has reported", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.checkedTurns).toBe(7);
      // clean, divergent, and eventless all recorded final SHA a, which GitHub saw
      expect(report.witnessedTurns).toBe(3);
    });

    it("when the ledgers disagree and GitHub saw the row's SHA, the event drifted", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const finding = report.findings.find((f) => f.turnId === divergentTurnId);
      expect(finding).toMatchObject({ check: "attribution", shape: "witness-disagrees" });
      expect(finding?.detail).toContain("the evidence event drifted");
    });

    it("when the ledgers disagree and GitHub saw the event's SHA, the row drifted", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const finding = report.findings.find((f) => f.turnId === driftedRowTurnId);
      expect(finding).toMatchObject({ check: "attribution", shape: "witness-disagrees" });
      expect(finding?.detail).toContain("the evidence row drifted");
    });

    it("without a witness a divergence stays a coherence finding, never a verdict", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const finding = report.findings.find((f) => f.turnId === unwitnessedTurnId);
      expect(finding).toMatchObject({ check: "coherence", shape: "divergent" });
    });
  });

  describe("the start-side telling and the capture pairing", () => {
    const contextlessTurnId = newId("turn"); // clean capture, context event destroyed
    const contextDriftTurnId = newId("turn"); // context event tells a different starting SHA
    const errorEventlessTurnId = newId("turn"); // capture error on the row, no capture_failed event
    const mismatchedTurnId = newId("turn"); // completed capture, but the event says capture failed

    beforeAll(async () => {
      await db
        .insert(turns)
        .values([
          turnRow(contextlessTurnId, "succeeded"),
          turnRow(contextDriftTurnId, "succeeded"),
          turnRow(errorEventlessTurnId, "failed"),
          turnRow(mismatchedTurnId, "succeeded"),
        ]);
      await db.insert(turnGitEvidence).values([
        evidenceRow(contextlessTurnId),
        evidenceRow(contextDriftTurnId),
        evidenceRow(errorEventlessTurnId, {
          finalSha: null,
          finalBranch: null,
          commits: [],
          changedFiles: [],
          captureError: "workspace unreachable during settle",
        }),
        evidenceRow(mismatchedTurnId),
      ]);
      await db
        .insert(storyEvidenceEvents)
        .values([
          gitEvent(contextlessTurnId),
          gitEvent(contextDriftTurnId),
          contextEvent(contextDriftTurnId, { initialSha: sha("9") }),
          contextEvent(errorEventlessTurnId),
          captureFailedEvent(mismatchedTurnId),
          contextEvent(mismatchedTurnId),
        ]);
    });

    it("finds a settled turn whose context event is gone", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.checkedTurns).toBe(11);
      const findings = report.findings.filter((f) => f.turnId === contextlessTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "missing-context" }]);
    });

    it("finds the context event disagreeing with the row about where the turn started", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === contextDriftTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "divergent" }]);
      expect(findings[0]?.detail).toBe("row and context event disagree on initialSha");
    });

    it("finds a capture error whose own event never landed", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === errorEventlessTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "missing-event" }]);
      expect(findings[0]?.detail).toContain("git.capture_failed");
    });

    it("finds a completed capture whose event on record says the capture failed", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      const findings = report.findings.filter((f) => f.turnId === mismatchedTurnId);
      expect(findings).toMatchObject([{ check: "coherence", shape: "divergent" }]);
      expect(findings[0]?.detail).toContain("git.capture_failed");
    });

    it("an honest capture error with its event is not a finding", async () => {
      const report = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(report.findings.filter((f) => f.turnId === failedTurnId)).toEqual([]);
    });

    it("pages with a keyset cursor and never double-counts", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let witnessed = 0;
      do {
        const page = await verifyDeliveryRecord(db, { orgId, projectId, cursor, limit: 4 });
        seen.push(...page.findings.map((f) => `${f.turnId}|${f.check}|${f.shape}`));
        witnessed += page.witnessedTurns;
        cursor = page.cursor ?? undefined;
      } while (cursor);
      const whole = await verifyDeliveryRecord(db, { orgId, projectId });
      expect(seen.sort()).toEqual(
        whole.findings.map((f) => `${f.turnId}|${f.check}|${f.shape}`).sort(),
      );
      expect(witnessed).toBe(whole.witnessedTurns);
    });
  });
});
