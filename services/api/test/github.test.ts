import { createHmac } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  inboundEvents,
  integrations,
  migrate,
  orgs,
  projects,
  repos,
  seed,
} from "@facility/db";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FacilityGithubClient } from "../src/github/client.js";
import { processGithubWebhook } from "../src/github/processor.js";
import { resolveSlashCommand } from "../src/github/router.js";
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

describe("FacilityGithubClient", () => {
  it("maps issue creation through Octokit", async () => {
    let args: Record<string, unknown> | undefined;
    const octokit = {
      rest: {
        issues: {
          create: async (input: Record<string, unknown>) => {
            args = input;
            return { data: { number: 42, html_url: "https://github.com/octo/repo/issues/42" } };
          },
        },
      },
    } as never;
    const client = new FacilityGithubClient(octokit, {
      owner: "octo",
      repo: "repo",
      defaultBranch: "main",
    });

    await expect(
      client.createIssue({ title: "Task", body: "Body", labels: ["type:task"] }),
    ).resolves.toEqual({ number: 42, url: "https://github.com/octo/repo/issues/42" });
    expect(args).toEqual({
      owner: "octo",
      repo: "repo",
      title: "Task",
      body: "Body",
      labels: ["type:task"],
    });
  });
});

describe("github integration", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; GitHub integration tests skipped", () =>
      undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4400,
    publicUrl: "http://localhost:4400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    githubAppWebhookSecret: "webhook-secret",
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    // Pre-bind installation 123 to an org — the install-callback flow does this
    // in production; an unknown installation is deliberately NOT auto-bound.
    const org = (await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1))[0];
    if (org) {
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId: org.id,
          installationId: 123,
          accountLogin: "octo",
          targetType: "Organization",
        })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("verifies GitHub HMAC before storing and no-ops replayed deliveries", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        installation: { id: 123, account: { login: "octo", type: "Organization" } },
        repository: { name: "repo", owner: { login: "octo" } },
      }),
    );
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": newId("evt"),
        "x-hub-signature-256": "sha256=bad",
      },
      payload,
    });
    expect(bad.statusCode).toBe(401);
    const delivery = newId("evt");
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`;
    const valid = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature,
      },
      payload,
    });
    expect(valid.statusCode).toBe(202);
    const replay = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature,
      },
      payload,
    });
    expect(replay.json()).toEqual({ ok: true, replayed: true });
    const rows = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, `gh_${delivery}`));
    expect(rows).toHaveLength(1);
  });

  it("routes a webhook to the resolved org's repo when two tenants share a repo name", async () => {
    // repos are per-org unique (migration 0012), so two orgs can register the
    // same owner/name. The processor must select the repo of the webhook's
    // resolved org — a global owner/name lookup would cross tenants.
    const owner = "cross";
    const name = `tenant-${Date.now()}`;
    const setups: { orgId: string; repoId: string; integrationId: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const orgId = newId("org");
      const suffix = `${Date.now()}-${i}`;
      await db.insert(orgs).values({ id: orgId, name: `xorg-${suffix}`, slug: `xorg-${suffix}` });
      const projectId = newId("proj");
      await db
        .insert(projects)
        .values({ id: projectId, orgId, name: "p", slug: `p-${suffix}`, settings: {} });
      const inst = (
        await db
          .insert(githubInstallations)
          .values({
            id: newId("int"),
            orgId,
            installationId: Date.now() * 10 + i,
            accountLogin: owner,
            targetType: "Organization",
          })
          .returning()
      )[0];
      const repoId = newId("repo");
      await db.insert(repos).values({
        id: repoId,
        orgId,
        projectId,
        installationId: inst?.id,
        owner,
        name,
        defaultBranch: "main",
        fingerprint: { files: [{ path: "managed.md" }] },
      });
      const integrationId = newId("int");
      await db
        .insert(integrations)
        .values({ id: integrationId, orgId, kind: "github", name: "gh" });
      setups.push({ orgId, repoId, integrationId });
    }
    const [target, other] = setups;
    if (!target || !other) throw new Error("two-org setup failed");
    const eventId = `gh_${newId("evt")}`;
    await db.insert(inboundEvents).values({
      id: eventId,
      orgId: target.orgId,
      integrationId: target.integrationId,
      verified: true,
      eventType: "push",
      payload: {
        repository: { owner: { login: owner }, name },
        ref: "refs/heads/main",
        commits: [{ modified: ["managed.md"] }],
      },
    });
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    await processGithubWebhook(db, config, { inboundEventId: eventId }, undefined, async (q, d) => {
      enqueued.push({ queue: q, data: d });
      return null;
    });
    const verify = enqueued.find((e) => e.queue === "fingerprints.verify");
    expect(verify?.data.repoId).toBe(target.repoId);
    expect(verify?.data.repoId).not.toBe(other.repoId);
  });

  it("matches only start-of-line slash commands and detects ambiguity", () => {
    expect(resolveSlashCommand("please ask /architect")).toEqual({ ambiguous: false });
    expect(resolveSlashCommand("/architect\n\ncontext")).toEqual({
      command: "architect",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/architect\n/builder")).toEqual({ ambiguous: true });
    expect(resolveSlashCommand("/codex-builder: go")).toEqual({
      command: "builder",
      ambiguous: false,
    });
  });

  it("refuses write operations against the default branch", async () => {
    const octokit = {
      rest: {
        git: {
          createRef: async () => ({ data: {} }),
          updateRef: async () => ({ data: {} }),
        },
        pulls: {
          create: async () => ({ data: { number: 1, html_url: "https://example.test/pr/1" } }),
        },
      },
    } as never;
    const client = new FacilityGithubClient(octokit, {
      owner: "octo",
      repo: "repo",
      defaultBranch: "main",
    });
    await expect(client.createBranch("main", "abc")).rejects.toThrow(/default branch/);
    await expect(client.updateBranch("refs/heads/main", "abc")).rejects.toThrow(/default branch/);
    await expect(client.createPullRequest({ title: "x", body: "x", head: "main" })).rejects.toThrow(
      /default branch/,
    );
  });
});
