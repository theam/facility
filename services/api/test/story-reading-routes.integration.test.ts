import { randomUUID } from "node:crypto";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  attentionItems,
  createDb,
  migrate,
  orgs,
  projects,
  roles,
  seed,
  stories,
  storyArtifacts,
  storyConversations,
  storyEvidenceEvents,
  storyMessages,
  turnEvents,
  turns,
} from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

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

/**
 * The story reading surfaces the web app pages through: the enriched
 * conversation, per-run activity, raw stored events, and the evidence timeline.
 * Rows are written directly so the shapes match what the dispatcher stores,
 * including an agent message recorded before final-response separation existed.
 */
describe("story reading routes", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; story reading routes skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = "org_local";
  const projectId = newId("proj");
  const otherProjectId = newId("proj");
  const otherOrgId = newId("org");
  const storyId = newId("story");
  const conversationId = newId("sess");
  const turnIds = Array.from({ length: 4 }, () => newId("turn"));
  const bigText = "L".repeat(30_000);
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 9).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const app = await buildApp(config, { rateLimitMax: 10_000 });
  let viewerSecret = "";
  let otherProjectSecret = "";
  let otherOrgSecret = "";
  let noReadSecret = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Other tenant",
      slug: `other-tenant-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Reading", slug: `reading-${suffix}`, settings: {} },
      {
        id: otherProjectId,
        orgId,
        name: "Other project",
        slug: `reading-other-${suffix}`,
        settings: {},
      },
    ]);
    const otherOrgRole = newId("role");
    const noReadRole = newId("role");
    await db.insert(roles).values([
      {
        id: otherOrgRole,
        orgId: otherOrgId,
        name: "owner",
        description: "Other tenant owner",
        permissions: ["*"],
      },
      {
        id: noReadRole,
        orgId,
        name: `analytics-only-${suffix}`,
        description: "No project read access",
        permissions: ["analytics:read"],
      },
    ]);
    const keys = await Promise.all(Array.from({ length: 4 }, () => generateApiKey("fak")));
    const [viewer, otherProject, otherOrg, noRead] = keys as [
      (typeof keys)[number],
      (typeof keys)[number],
      (typeof keys)[number],
      (typeof keys)[number],
    ];
    viewerSecret = viewer.secret;
    otherProjectSecret = otherProject.secret;
    otherOrgSecret = otherOrg.secret;
    noReadSecret = noRead.secret;
    await db.insert(apiKeys).values([
      {
        id: viewer.id,
        orgId,
        name: "viewer",
        prefix: viewer.lookup,
        last4: viewer.last4,
        hash: viewer.hash,
        scopeType: "project",
        projectId,
        roleId: "role_bundled_viewer",
      },
      {
        id: otherProject.id,
        orgId,
        name: "other project viewer",
        prefix: otherProject.lookup,
        last4: otherProject.last4,
        hash: otherProject.hash,
        scopeType: "project",
        projectId: otherProjectId,
        roleId: "role_bundled_viewer",
      },
      {
        id: otherOrg.id,
        orgId: otherOrgId,
        name: "other tenant owner",
        prefix: otherOrg.lookup,
        last4: otherOrg.last4,
        hash: otherOrg.hash,
        scopeType: "org",
        projectId: null,
        roleId: otherOrgRole,
      },
      {
        id: noRead.id,
        orgId,
        name: "analytics only",
        prefix: noRead.lookup,
        last4: noRead.last4,
        hash: noRead.hash,
        scopeType: "project",
        projectId,
        roleId: noReadRole,
      },
    ]);

    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 10, 10, minutes));
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      provider: "manual",
      externalId: `reading-${suffix}`,
      title: "Reading story",
      status: "review",
      createdBy: { type: "user", id: "user_local_admin" },
      createdAt: at(0),
      updatedAt: at(0),
    });
    await db.insert(storyConversations).values({
      id: conversationId,
      orgId,
      projectId,
      storyId,
      nextSeq: 8,
    });
    const manifest = {
      name: "builder",
      description: "Builds",
      engine: "codex",
      model: "gpt-5.5",
      enabled: true,
      options: {},
      triggers: [{ type: "manual" }],
      file: ".agents/builder.md",
      prompt: "Build.",
      hash: "hash",
    };
    const turnRows = turnIds.map((id, index) => ({
      id,
      orgId,
      projectId,
      storyId,
      conversationId,
      agentName: index === 1 ? "architect" : "builder",
      manifestHash: "hash",
      manifest:
        index === 1 ? { ...manifest, engine: "claude_code", model: "claude-opus-4-8" } : manifest,
      engine: index === 1 ? "claude_code" : "codex",
      model: index === 1 ? "claude-opus-4-8" : "gpt-5.5",
      state: index === 2 ? "failed" : index === 3 ? "running" : "succeeded",
      triggerType: "ui",
      error: index === 2 ? "codex exited with status 1" : null,
      createdBy: { type: "user", id: "user_local_admin" },
      startedAt: at(index * 10 + 1),
      endedAt: index === 3 ? null : at(index * 10 + 5),
      createdAt: at(index * 10),
      updatedAt: at(index * 10 + 5),
    }));
    await db.insert(turns).values(turnRows);
    await db.insert(storyMessages).values([
      message(
        1,
        "user",
        "Please add the feature",
        { type: "user", id: "user_local_admin" },
        turnIds[0],
        "builder",
        at(0),
      ),
      // Recorded before final-response separation: the whole transcript is the body.
      message(
        2,
        "agent",
        "Working on it.\n\nDone, feature added.",
        { type: "system", id: "codex:thread-1" },
        turnIds[0],
        null,
        at(5),
      ),
      message(
        3,
        "user",
        "Review the design",
        { type: "service", id: "github:octocat" },
        turnIds[1],
        "architect",
        at(10),
      ),
      message(
        4,
        "agent",
        "Design reviewed.",
        { type: "system", id: "claude_code:session-1" },
        turnIds[1],
        null,
        at(15),
        {
          content: "final_response",
          engine: "claude_code",
          model: "claude-opus-4-8",
          progressMessages: 2,
        },
      ),
      message(
        5,
        "user",
        "Try again",
        { type: "user", id: "user_local_admin" },
        turnIds[2],
        "builder",
        at(20),
      ),
      message(
        6,
        "user",
        "Keep going",
        { type: "system", id: "schedule:nightly" },
        turnIds[3],
        "builder",
        at(30),
      ),
      message(
        7,
        "user",
        "Queued follow-up",
        { type: "user", id: "user_local_admin" },
        null,
        "builder",
        at(31),
      ),
    ]);
    await db.insert(turnEvents).values([
      turnEvent(turnIds[0], 1, "turn.started", {}, at(1)),
      turnEvent(
        turnIds[0],
        2,
        "engine.item.completed",
        { item: { type: "agent_message", text: "Working on it." } },
        at(2),
      ),
      turnEvent(
        turnIds[0],
        3,
        "engine.item.updated",
        { item: { type: "command_execution", command: "ls" } },
        at(2),
      ),
      turnEvent(
        turnIds[0],
        4,
        "engine.item.completed",
        {
          item: {
            type: "command_execution",
            command: "pnpm test",
            exit_code: 0,
            aggregated_output: bigText,
          },
        },
        at(3),
      ),
      turnEvent(
        turnIds[0],
        5,
        "engine.item.completed",
        { item: { type: "agent_message", text: "Done, feature added." } },
        at(4),
      ),
      turnEvent(turnIds[0], 6, "turn.succeeded", { durationMs: 240_000 }, at(5)),
      turnEvent(turnIds[2], 1, "turn.started", {}, at(21)),
      turnEvent(turnIds[2], 2, "turn.failed", { error: "codex exited with status 1" }, at(25)),
    ]);
    await db.insert(storyEvidenceEvents).values({
      id: newId("evt"),
      orgId,
      projectId,
      storyId,
      turnId: turnIds[0],
      source: "github",
      type: "github.pull_request_observed",
      externalKey: `pr-${suffix}`,
      data: { number: 7, state: "open", title: "Add the feature" },
      occurredAt: at(6),
      observedAt: at(6),
    });
    await db.insert(storyArtifacts).values({
      id: newId("art"),
      orgId,
      projectId,
      storyId,
      turnId: turnIds[0],
      kind: "screenshot",
      label: "Home page",
      uri: "https://example.test/home.png",
      metadata: {},
      createdAt: at(4),
      updatedAt: at(4),
    });
    await db.insert(attentionItems).values({
      id: newId("attn"),
      orgId,
      projectId,
      storyId,
      turnId: turnIds[2],
      kind: "turn_error",
      title: "builder failed",
      detail: "codex exited with status 1",
      status: "open",
      createdAt: at(25),
      updatedAt: at(25),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  function message(
    seq: number,
    role: "user" | "agent",
    body: string,
    actor: Record<string, string>,
    turnId: string | null | undefined,
    requestedAgentName: string | null,
    createdAt: Date,
    metadata: Record<string, unknown> = {},
  ) {
    return {
      id: newId("msg"),
      orgId,
      projectId,
      storyId,
      conversationId,
      seq,
      role,
      body,
      actor,
      turnId: turnId ?? null,
      requestedAgentName,
      requestedTrigger: { type: "ui" },
      metadata,
      createdAt,
    };
  }

  function turnEvent(
    turnId: string | undefined,
    seq: number,
    type: string,
    data: Record<string, unknown>,
    createdAt: Date,
  ) {
    if (!turnId) throw new Error("turn id missing");
    return { orgId, projectId, storyId, turnId, seq, type, data, createdAt };
  }

  const base = () => `/v1/projects/${projectId}/workspace-stories/${storyId}`;
  const viewer = () => ({ authorization: `Bearer ${viewerSecret}` });

  it("pages the conversation newest first with authors, runs, and content kinds resolved", async () => {
    const first = await app.inject({
      method: "GET",
      url: `${base()}/conversation?order=desc&limit=3`,
      headers: viewer(),
    });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json();
    // seq 7, 6, 5 fill the page; 5 is the failed run's request and has no response to keep.
    expect(page.messages.map((m: { seq: number }) => m.seq)).toEqual([7, 6, 5]);
    expect(page).toMatchObject({ has_more: true, next_cursor: 5 });
    const [queued, scheduled, retried] = page.messages;
    expect(queued).toMatchObject({
      author: { kind: "user", name: "Local Admin", avatarUrl: null },
      turn: null,
      content: { kind: "text" },
      requestedAgentName: "builder",
    });
    expect(scheduled).toMatchObject({
      author: { kind: "schedule", name: "Schedule nightly" },
      turn: { id: turnIds[3], state: "running", engine: "codex", model: "gpt-5.5" },
    });
    expect(retried.turn).toMatchObject({ state: "failed", error: "codex exited with status 1" });

    expect(page.related).toEqual([]);

    const second = await app.inject({
      method: "GET",
      url: `${base()}/conversation?order=desc&limit=3&before=5`,
      headers: viewer(),
    });
    expect(second.statusCode).toBe(200);
    const older = second.json();
    // The page boundary splits run 1 (seq 1 and 2); its request rides along as related context.
    expect(older.messages.map((m: { seq: number }) => m.seq)).toEqual([4, 3, 2]);
    expect(older.related.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(older).toMatchObject({ has_more: true, next_cursor: 2 });
    const [reviewed, review, legacy] = older.messages;
    const [request] = older.related;
    const third = await app.inject({
      method: "GET",
      url: `${base()}/conversation?order=desc&limit=3&before=2`,
      headers: viewer(),
    });
    expect(third.json()).toMatchObject({ has_more: false, next_cursor: null, related: [] });
    expect(third.json().messages.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(reviewed).toMatchObject({
      author: { kind: "agent", name: "architect" },
      turn: { engine: "claude_code", model: "claude-opus-4-8", state: "succeeded" },
      content: { kind: "final_response", progressMessages: 2, reportedModel: "claude-opus-4-8" },
    });
    expect(review).toMatchObject({
      author: {
        kind: "github",
        name: "octocat",
        handle: "@octocat",
        avatarUrl: "https://avatars.githubusercontent.com/octocat?s=64",
      },
    });
    expect(legacy).toMatchObject({
      author: { kind: "agent", name: "builder" },
      content: { kind: "combined_transcript", progressMessages: null },
      body: "Working on it.\n\nDone, feature added.",
    });
    expect(request).toMatchObject({ author: { kind: "user", name: "Local Admin" } });

    const ascending = await app.inject({
      method: "GET",
      url: `${base()}/conversation?after=0&limit=2`,
      headers: viewer(),
    });
    expect(ascending.json()).toMatchObject({ has_more: true, next_cursor: 2 });
    expect(ascending.json().messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
  });

  it("pages run activity newest first, skipping noise and bounding large payloads", async () => {
    const first = await app.inject({
      method: "GET",
      url: `${base()}/turns/${turnIds[0]}/activity?limit=2`,
      headers: viewer(),
    });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json();
    expect(page.turn).toMatchObject({ id: turnIds[0], agentName: "builder", state: "succeeded" });
    expect(page.items.map((item: { seq: number }) => item.seq)).toEqual([6, 5]);
    expect(page).toMatchObject({ has_more: true, next_cursor: 5 });
    expect(page.items[0]).toMatchObject({ kind: "lifecycle", title: "Run completed" });

    const second = await app.inject({
      method: "GET",
      url: `${base()}/turns/${turnIds[0]}/activity?limit=10&before=5`,
      headers: viewer(),
    });
    const older = second.json();
    // seq 3 is an item.updated event and is not part of readable activity.
    expect(older.items.map((item: { seq: number }) => item.seq)).toEqual([4, 2, 1]);
    expect(older).toMatchObject({ has_more: false, next_cursor: null });
    const command = older.items[0];
    expect(command).toMatchObject({ kind: "command", title: "Command exit 0", truncated: true });
    expect(command.text.length).toBeLessThan(2_100);
    expect(command.size_bytes).toBeGreaterThan(30_000);
    expect(second.body.length).toBeLessThan(6_000);

    const raw = await app.inject({
      method: "GET",
      url: `${base()}/turns/${turnIds[0]}/events/4`,
      headers: viewer(),
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().data.item.aggregated_output).toBe(bigText);
    expect(raw.headers["cache-control"]).toBe("no-store");
    const missing = await app.inject({
      method: "GET",
      url: `${base()}/turns/${turnIds[0]}/events/99`,
      headers: viewer(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("pages the timeline by occurrence with agent events summarized", async () => {
    const first = await app.inject({
      method: "GET",
      url: `${base()}/timeline?limit=4`,
      headers: viewer(),
    });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json();
    expect(page.entries).toHaveLength(4);
    expect(page.has_more).toBe(true);
    // The failure and the attention item it opened share an occurrence time; ids break the tie.
    expect(
      page.entries
        .slice(0, 2)
        .map((entry: { type: string }) => entry.type)
        .sort(),
    ).toEqual(["attention.opened", "turn.failed"]);
    const seen = new Set(page.entries.map((entry: { id: string }) => entry.id));
    let cursor = page.next_cursor as string;
    let guard = 0;
    while (cursor && guard < 10) {
      const next = await app.inject({
        method: "GET",
        url: `${base()}/timeline?limit=4&before=${encodeURIComponent(cursor)}`,
        headers: viewer(),
      });
      expect(next.statusCode, next.body).toBe(200);
      for (const entry of next.json().entries as Array<{ id: string }>) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      cursor = next.json().next_cursor;
      guard += 1;
    }
    // 1 created + 8 turn events + 1 evidence + 1 artifact + 1 attention
    expect(seen.size).toBe(12);
    expect(seen.has(`story:${storyId}:created`)).toBe(true);
    const all = await app.inject({
      method: "GET",
      url: `${base()}/timeline?limit=50`,
      headers: viewer(),
    });
    const agentEntry = all
      .json()
      .entries.find((entry: { id: string }) => entry.id === `turn:${turnIds[0]}:4`);
    expect(agentEntry.data).toMatchObject({ kind: "command", truncated: true, seq: 4 });
    expect(JSON.stringify(agentEntry).length).toBeLessThan(3_000);
    const invalid = await app.inject({
      method: "GET",
      url: `${base()}/timeline?before=not-a-cursor`,
      headers: viewer(),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("omits bounded evidence from the bundle only when asked", async () => {
    const full = await app.inject({ method: "GET", url: base(), headers: viewer() });
    expect(full.statusCode).toBe(200);
    expect(Array.isArray(full.json().events)).toBe(true);
    expect(Array.isArray(full.json().timeline)).toBe(true);
    const light = await app.inject({
      method: "GET",
      url: `${base()}?evidence=none`,
      headers: viewer(),
    });
    expect(light.statusCode).toBe(200);
    expect(light.json()).not.toHaveProperty("events");
    expect(light.json()).not.toHaveProperty("timeline");
    expect(light.json().turns).toHaveLength(4);
    expect(light.json().story.id).toBe(storyId);
  });

  it("denies reads without projects:read and hides the story across projects and tenants", async () => {
    const paths = [
      `${base()}/conversation?order=desc`,
      `${base()}/turns/${turnIds[0]}/activity`,
      `${base()}/turns/${turnIds[0]}/events/1`,
      `${base()}/timeline`,
      `${base()}?evidence=none`,
    ];
    for (const url of paths) {
      const forbidden = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${noReadSecret}` },
      });
      expect(forbidden.statusCode, url).toBe(403);
      const otherProject = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${otherProjectSecret}` },
      });
      expect([403, 404], url).toContain(otherProject.statusCode);
      expect(otherProject.body).not.toContain("Reading story");
      const otherTenant = await app.inject({
        method: "GET",
        url: url.replace(projectId, projectId),
        headers: { authorization: `Bearer ${otherOrgSecret}` },
      });
      expect([403, 404], url).toContain(otherTenant.statusCode);
      expect(otherTenant.body).not.toContain("Working on it");
      const anonymous = await app.inject({ method: "GET", url });
      expect(anonymous.statusCode, url).toBe(401);
    }
    // A turn from another story in the same project is not reachable through this story.
    const foreignTurn = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/workspace-stories/${newId("story")}/turns/${turnIds[0]}/activity`,
      headers: viewer(),
    });
    expect(foreignTurn.statusCode).toBe(404);
  });
});
