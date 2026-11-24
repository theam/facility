import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  githubIssues,
  githubWebhookEvents,
  migrate,
  orgs,
  projectRepositories,
  projects,
  stories,
  storyConversations,
  turns,
} from "@facility/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AgentCatalogService } from "../src/agents/catalog.js";
import { GithubAgentTriggerService } from "../src/agents/github-triggers.js";
import {
  bindGithubRepositoryClient,
  type GithubClientFactory,
  type Octokit,
} from "../src/github/client.js";
import { GithubMirrorService } from "../src/github/mirror.js";
import { rebindRepository } from "../src/github/rebind-repository.js";
import { GithubRepositoryBindingChanged } from "../src/github/repository-binding.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { parseProjectManifest } from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const { db, client } = createDb(databaseUrl);
const orgId = newId("org"),
  projectId = newId("proj"),
  repoId = newId("repo"),
  storyId = newId("story");
const oldInstallation = newId("ghi"),
  newInstallation = newId("ghi");
const number = 70_000_000 + Math.floor(Math.random() * 1_000_000);
const owner = `rebind-${projectId}`;
const input = { installationId: number + 1, owner, name: "app" };
const scope = { orgId, projectId, repoId };
const agent = parseAgentManifest(
  `---\nname: builder\ndescription: Test builder\nengine: codex\nmodel: gpt-5.5\nenabled: true\ntriggers:\n  - type: manual\n---\nImplement the request.`,
  "builder.md",
);
const service = new StoryWorkspaceService(
  db,
  new FakeWorkspaceRuntime(`/private/tmp/rebind-${projectId}`),
);
const queue = () =>
  service.queueMessage({
    orgId,
    projectId,
    storyId,
    body: "Work",
    dedupeKey: newId("msg"),
    agent,
    actor: { type: "service", id: "regression" },
    trigger: { type: "manual" },
  });
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(beforeLookup: () => Promise<unknown> = async () => undefined): Octokit {
  return {
    repositoryInstallationId: async () => number + 1,
    rest: {
      repos: {
        get: async () => {
          await beforeLookup();
          return { data: { id: 456, owner: { login: owner }, name: "app", default_branch: "dev" } };
        },
      },
    },
  } as unknown as Octokit;
}
beforeAll(async () => {
  await migrate(databaseUrl);
  await db.insert(orgs).values({ id: orgId, name: "Rebind regression", slug: orgId });
  await db.insert(projects).values({ id: projectId, orgId, name: "Rebind", slug: projectId });
  await db.insert(githubInstallations).values([
    {
      id: oldInstallation,
      orgId,
      installationId: number,
      accountId: number,
      accountLogin: owner,
      targetType: "Organization",
    },
    {
      id: newInstallation,
      orgId,
      installationId: number + 1,
      accountId: number,
      accountLogin: owner,
      targetType: "Organization",
    },
  ]);
  await db.insert(projectRepositories).values({
    id: repoId,
    orgId,
    projectId,
    installationId: oldInstallation,
    githubRepositoryId: 456,
    owner,
    name: "app",
    defaultBranch: "dev",
    role: "primary",
  });
  await db.insert(stories).values({
    id: storyId,
    orgId,
    projectId,
    repositoryId: repoId,
    provider: "manual",
    externalId: storyId,
    title: "Idle story",
    createdBy: {},
  });
  await db.insert(storyConversations).values({ id: newId("sess"), orgId, projectId, storyId });
});
afterAll(async () => {
  await client.end();
});

it("does not hold a database connection while the factory resolves credentials", async () => {
  const limited = createDb(databaseUrl, { max: 1 });
  try {
    const factory: GithubClientFactory = async () => {
      await limited.db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, newInstallation));
      return provider();
    };
    const result = await rebindRepository(limited.db, factory, scope, input);
    expect(result.installationId).toBe(newInstallation);
  } finally {
    await limited.client.end({ timeout: 1 });
  }
  await db
    .update(projectRepositories)
    .set({ installationId: oldInstallation })
    .where(eq(projectRepositories.id, repoId));
});

it("rejects rebind when a real message is queued during the external lookup", async () => {
  const entered = latch(),
    release = latch();
  const operation = rebindRepository(
    db,
    async () =>
      provider(async () => {
        entered.resolve();
        await release.promise;
      }),
    scope,
    input,
  );
  const result = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let turnId: string | undefined;
  try {
    await entered.promise;
    turnId = (await queue()).turn?.id;
    expect(turnId).toBeTruthy();
    release.resolve();
    expect(await result).toMatchObject({ error: { code: "project_busy" } });
    expect(
      (await db.select().from(projectRepositories).where(eq(projectRepositories.id, repoId)))[0]
        ?.installationId,
    ).toBe(oldInstallation);
  } finally {
    release.resolve();
    await result;
    if (turnId) await db.update(turns).set({ state: "succeeded" }).where(eq(turns.id, turnId));
  }
});

it("makes ordinary turn enqueue wait for the project topology fence", async () => {
  const held = latch(),
    release = latch();
  const lock = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:${projectId}`}))`);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const enqueued = queue();
  try {
    await vi.waitFor(
      async () => {
        const rows = await db.execute(
          sql`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted and objid = (hashtext(${`${orgId}:${projectId}`})::bigint & 4294967295)::oid`,
        );
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 10 },
    );
    expect(
      (await db.select().from(turns).where(eq(turns.storyId, storyId))).every(
        (turn) => turn.state !== "queued",
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await lock;
    const turn = (await enqueued).turn;
    if (turn) await db.update(turns).set({ state: "succeeded" }).where(eq(turns.id, turn.id));
  }
});

it("drops an in-flight webhook if the App switches while its catalog is loading", async () => {
  const entered = latch(),
    release = latch();
  const manifest = parseAgentManifest(
    `---\nname: reviewer\ndescription: Review\nengine: codex\nmodel: gpt-5.5\nenabled: true\ntriggers:\n  - type: github\n    name: opened\n    event: pull_request\n    actions: [opened]\n---\nReview.`,
    "reviewer.md",
  );
  const catalog = {
    list: async () => {
      entered.resolve();
      await release.promise;
      return [{ manifest }];
    },
  } as unknown as AgentCatalogService;
  const worker = new GithubAgentTriggerService(
    db,
    catalog,
    service,
    {
      load: async () =>
        parseProjectManifest(
          `version: 1\nrepositories:\n  primary: github.com/${owner}/app\nenvironment:\n  setup: echo setup\n  start: 'true'\n`,
        ),
    },
    "test",
  );
  const id = `gh_${crypto.randomUUID()}`;
  await db.insert(githubWebhookEvents).values({
    id,
    orgId,
    projectId,
    repositoryId: repoId,
    installationId: oldInstallation,
    verified: true,
    eventType: "pull_request",
    payload: {
      action: "opened",
      repository: { id: 456, name: "app", owner: { login: owner } },
      pull_request: { number: 321, title: "Review", head: { ref: "feature/321" } },
    },
  });
  const pending = worker.handleInbound(id);
  try {
    await entered.promise;
    await rebindRepository(db, async () => provider(), scope, input);
    release.resolve();
    expect(await pending).toEqual({ matched: 0, queued: 0, merged: 0 });
    expect(
      await db.select().from(stories).where(eq(stories.externalId, "pull-request:321")),
    ).toHaveLength(0);
    expect(
      (await db.select().from(githubWebhookEvents).where(eq(githubWebhookEvents.id, id)))[0]
        ?.processedAt,
    ).toBeTruthy();
  } finally {
    release.resolve();
    await pending;
    await db
      .update(projectRepositories)
      .set({ installationId: oldInstallation })
      .where(eq(projectRepositories.id, repoId));
  }
});

it("rechecks the binding after runtime creation, before queuing the first message", async () => {
  const entered = latch(),
    release = latch();
  const runtime = new FakeWorkspaceRuntime(`/private/tmp/rebind-runtime-${projectId}`);
  const create = runtime.create.bind(runtime);
  vi.spyOn(runtime, "create").mockImplementation(async (input) => {
    entered.resolve();
    await release.promise;
    return create(input);
  });
  const guarded = new StoryWorkspaceService(db, runtime);
  const externalId = newId("story");
  const pending = guarded
    .start({
      orgId,
      projectId,
      repositoryId: repoId,
      expectedGithubBinding: {
        repositoryId: repoId,
        installationId: oldInstallation,
        githubRepositoryId: 456,
      },
      provider: "github",
      externalId,
      title: "Bound trigger",
      agent,
      message: "Work",
      messageDedupeKey: externalId,
      actor: { type: "service", id: "github:test" },
      workspace: { image: "test" },
      trigger: { type: "github" },
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    await entered.promise;
    await rebindRepository(db, async () => provider(), scope, input);
    release.resolve();
    expect(await pending).toMatchObject({ error: expect.any(GithubRepositoryBindingChanged) });
    const [story] = await db.select().from(stories).where(eq(stories.externalId, externalId));
    if (!story) throw new Error("Missing story fixture");
    expect(await db.select().from(turns).where(eq(turns.storyId, story.id))).toHaveLength(0);
  } finally {
    release.resolve();
    await pending;
    await db
      .update(projectRepositories)
      .set({ installationId: oldInstallation })
      .where(eq(projectRepositories.id, repoId));
  }
});

it("keeps mirror writes behind the same repository row fence as rebind", async () => {
  const held = latch(),
    release = latch();
  const lock = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:${projectId}`}))`);
    await tx
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.id, repoId))
      .for("update");
    held.resolve();
    await release.promise;
    await tx
      .update(projectRepositories)
      .set({ installationId: newInstallation })
      .where(eq(projectRepositories.id, repoId));
  });
  await held.promise;
  const mirror = new GithubMirrorService(db, async () => provider());
  const pending = mirror
    .handleWebhook({
      id: `gh_${crypto.randomUUID()}`,
      orgId,
      projectId,
      repositoryId: repoId,
      installationId: oldInstallation,
      eventType: "issues",
      payload: {
        repository: { id: 456, name: "app", owner: { login: owner } },
        issue: {
          number: 321,
          title: "Must not mirror",
          html_url: "https://github.test/issues/321",
          state: "open",
        },
      },
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    await vi.waitFor(
      async () => {
        const rows = await db.execute(
          sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%project_repositories%' and query like '%for share%'`,
        );
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    release.resolve();
    await lock;
    expect(await pending).toMatchObject({ error: expect.any(GithubRepositoryBindingChanged) });
    expect(
      await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, repoId)),
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await lock;
    await pending;
    await db
      .update(projectRepositories)
      .set({ installationId: oldInstallation })
      .where(eq(projectRepositories.id, repoId));
  }
});

it("takes the project row before the repository row so disconnect cannot deadlock with a new issue", async () => {
  const held = latch(),
    mirrorStarted = latch(),
    release = latch();
  const disconnectFence = db.transaction(async (tx) => {
    await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    held.resolve();
    await mirrorStarted.promise;
    try {
      await vi.waitFor(
        async () => {
          const rows = await db.execute(
            sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%"projects"%' and query like '%for key share%'`,
          );
          expect(rows[0]?.waiting).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );
      // A mirror that had taken repo FOR SHARE first would make this fail immediately.
      await tx
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.id, repoId))
        .for("update", { noWait: true });
    } finally {
      release.resolve();
    }
  });
  await held.promise;
  const mirror = new GithubMirrorService(db, async () => provider());
  const pending = mirror.handleWebhook({
    id: `gh_${crypto.randomUUID()}`,
    orgId,
    projectId,
    repositoryId: repoId,
    installationId: oldInstallation,
    eventType: "issues",
    payload: {
      repository: { id: 456, name: "app", owner: { login: owner } },
      issue: {
        number: 322,
        title: "New issue",
        html_url: "https://github.test/issues/322",
        state: "open",
      },
    },
  });
  mirrorStarted.resolve();
  await release.promise;
  await disconnectFence;
  expect((await pending).mirrored).toBe(1);
});

it("does not mirror a replacement public repository's issues when its slug changes during GET", async () => {
  let currentId = 456;
  const client = bindGithubRepositoryClient(
    {
      request: async (route: string) => {
        if (route.endsWith("/branches")) return { data: [] };
        currentId = 999;
        return {
          data: [
            {
              number: 987,
              title: "Replacement issue",
              state: "closed",
              html_url: "https://github.test/issues/987",
            },
          ],
        };
      },
      rest: {
        git: {},
        pulls: {},
        repos: {
          get: async () => ({ data: { id: currentId, name: "app" } }),
        },
      },
    } as unknown as Octokit,
    456,
  );
  const before = await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, repoId));
  await expect(
    new GithubMirrorService(db, async () => client).syncProject(orgId, projectId),
  ).rejects.toThrow("identity changed");
  expect(await db.select().from(githubIssues).where(eq(githubIssues.repositoryId, repoId))).toEqual(
    before,
  );
});
