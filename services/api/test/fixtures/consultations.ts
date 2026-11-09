import { createHash, randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  githubInstallations,
  migrate,
  orgMembers,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  roles,
  stories,
  storyConversations,
  storyMessages,
  turns,
  users,
} from "@facility/db";
import { vi } from "vitest";
import type { Octokit } from "../../src/github/client.js";
import { callConsultationProvider } from "../../src/stories/consultation-provider.js";
import { GithubConsultationSources } from "../../src/stories/consultation-sources.js";
import { StoryConsultationService } from "../../src/stories/consultations.js";

export const consultationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
export async function consultationTestEnvironment() {
  const { db, client } = createDb(consultationDatabaseUrl);
  await migrate(consultationDatabaseUrl);
  const orgId = newId("org"),
    otherOrgId = newId("org");
  await db.insert(orgs).values([
    { id: orgId, name: "Consultation tests", slug: randomUUID() },
    { id: otherOrgId, name: "Other tenant", slug: randomUUID() },
  ]);
  async function fixture(fixtureOrgId = orgId) {
    const projectId = newId("proj"),
      storyId = newId("story"),
      conversationId = newId("sess"),
      repositoryId = newId("repo"),
      installationId = newId("ghi");
    const userId = newId("user"),
      roleId = newId("role");
    await db.insert(roles).values({
      id: roleId,
      orgId: fixtureOrgId,
      name: roleId,
      permissions: ["projects:read", "workspaces:execute", "costs:read", "budgets:read"],
    });
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Test requester",
      status: "active",
    });
    await db
      .insert(orgMembers)
      .values({ id: newId("member"), orgId: fixtureOrgId, userId, roleId });
    await db
      .insert(projects)
      .values({ id: projectId, orgId: fixtureOrgId, name: "Consultation", slug: projectId });
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId: fixtureOrgId,
      projectId,
      monthlyLimitCents: 100_000,
      enabled: true,
    });
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId: fixtureOrgId,
      installationId: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
      accountId: 1,
      accountLogin: "example",
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId: fixtureOrgId,
      projectId,
      owner: "example",
      name: projectId,
      defaultBranch: "main",
      role: "primary",
      installationId,
    });
    await db.insert(stories).values({
      id: storyId,
      orgId: fixtureOrgId,
      projectId,
      provider: "manual",
      externalId: storyId,
      title: "Consult about a saved task",
      titleSource: "user",
      createdBy: { type: "user", id: userId },
    });
    await db.insert(storyConversations).values({
      id: conversationId,
      orgId: fixtureOrgId,
      projectId,
      storyId,
      summary: "Saved task summary",
    });
    const previousTurnId = newId("turn");
    await db.insert(turns).values({
      id: previousTurnId,
      orgId: fixtureOrgId,
      projectId,
      storyId,
      conversationId,
      agentName: "reviewer",
      manifestHash: "fixture",
      manifest: {},
      engine: "codex",
      model: "gpt-5.5",
      state: "succeeded",
      triggerType: "ui",
      createdBy: { type: "user", id: userId },
    });
    await db.insert(storyMessages).values({
      id: newId("msg"),
      orgId: fixtureOrgId,
      projectId,
      storyId,
      conversationId,
      seq: 1,
      role: "user",
      body: "Earlier task request",
      actor: { type: "user", id: userId },
      turnId: previousTurnId,
    });
    const state = {
      model: "gpt-5.5",
      engine: "codex",
      reasoningEffort: "high",
      catalogSha: "a".repeat(40),
      fileSha: "a".repeat(40),
      sourceText: "export const answer = 42;\n",
      mode: "100644",
      keyAvailable: true,
      output: "A suggested change based on the supplied snapshot.",
      outcome: "completed",
      providerError: undefined as Error | undefined,
      usageMissing: false,
      providerGate: undefined as Promise<void> | undefined,
      ignoreAbort: false,
      sourceGate: undefined as Promise<void> | undefined,
    };
    const manifest = () =>
      `---\nname: reviewer\ndescription: Review a task\nengine: ${state.engine}\nmodel: ${state.model}\noptions:\n  reasoning_effort: ${state.reasoningEffort}\ntriggers:\n  - type: ui\n  - type: mcp\n---\nHelp review software work.\n`;
    const blob = () => Buffer.from(state.sourceText);
    const blobSha = () =>
      createHash("sha1").update(`blob ${blob().length}\0`).update(blob()).digest("hex");
    const mutation = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected GitHub mutation");
    });
    const githubRequest = vi.fn(async (route: string, args: Record<string, unknown> = {}) => {
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        if (state.sourceGate) await state.sourceGate;
        return {
          data: {
            sha: args.tree_sha,
            truncated: false,
            tree:
              args.tree_sha === "b".repeat(40)
                ? [{ path: "src", type: "tree", mode: "040000", sha: "c".repeat(40) }]
                : [{ path: "app.ts", type: "blob", mode: state.mode, sha: blobSha() }],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}")
        return {
          data: {
            sha: blobSha(),
            size: blob().length,
            content: blob().toString("base64"),
            encoding: "base64",
          },
        };
      throw new Error("Unexpected GitHub route");
    });
    const octokit = {
      request: githubRequest,
      rest: {
        git: {
          getCommit: vi.fn(async (args: Record<string, unknown>) => {
            if (args.commit_sha !== state.fileSha)
              throw Object.assign(new Error("missing commit"), { status: 404 });
            return { data: { sha: state.fileSha, tree: { sha: "b".repeat(40) } } };
          }),
          createBlob: mutation,
          createTree: mutation,
          createCommit: mutation,
          createRef: mutation,
          updateRef: mutation,
        },
        repos: {
          getBranch: vi.fn(async () => ({ data: { commit: { sha: state.catalogSha } } })),
          getContent: vi.fn(async (args: Record<string, unknown>) => {
            if (args.path === ".agents")
              return { data: [{ path: ".agents/reviewer.md", type: "file" }] };
            if (args.path === ".agents/reviewer.md")
              return {
                data: {
                  type: "file",
                  content: Buffer.from(manifest()).toString("base64"),
                  encoding: "base64",
                },
              };
            throw Object.assign(new Error("optional source missing"), { status: 404 });
          }),
          createInOrg: mutation,
        },
        pulls: { create: mutation },
      },
    } satisfies Octokit;
    const sources = new GithubConsultationSources(db, async () => octokit);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (state.providerError) throw state.providerError;
      if (state.providerGate)
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new Error("request aborted"));
          if (!state.ignoreAbort) init?.signal?.addEventListener("abort", aborted, { once: true });
          state.providerGate?.then(() => {
            init?.signal?.removeEventListener("abort", aborted);
            resolve();
          }, reject);
        });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        object: "response",
        model: body.model,
        service_tier: "default",
        status: state.outcome,
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: state.output }],
          },
        ],
        ...(state.usageMissing
          ? {}
          : {
              usage: {
                input_tokens: 100,
                output_tokens: 10,
                total_tokens: 110,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              },
            }),
      });
    });
    const credentials = vi.fn(async () =>
      state.keyAvailable ? "synthetic-provider-key" : undefined,
    );
    const enqueue = vi.fn(async () => "job-test");
    const service = new StoryConsultationService(db, {
      sources,
      credentials,
      enqueue,
      complete: (input) => callConsultationProvider(input, fetch),
    });
    const scope = { orgId: fixtureOrgId, projectId, storyId };
    const actor = { type: "user" as const, id: userId, name: "Test requester" };
    const body = async (withFile = false) => {
      const options = await service.options(scope, "ui", { costsVisible: true });
      const agent = options.agents[0];
      if (!agent) throw new Error("Missing test agent");
      return {
        agent: agent.name,
        expected_agent_hash: agent.manifestHash,
        expected_catalog_sha: options.catalogSha,
        message: "Please consult about this saved task.",
        sources: withFile
          ? [{ repository_id: repositoryId, commit_sha: state.fileSha, path: "src/app.ts" }]
          : [],
        idempotency_key: randomUUID(),
      };
    };
    return {
      scope,
      actor,
      userId,
      roleId,
      repositoryId,
      installationId,
      previousTurnId,
      conversationId,
      state,
      sources,
      octokit,
      service,
      body,
      fetch,
      githubRequest,
      mutation,
      credentials,
      enqueue,
    };
  }
  return { db, client, orgId, otherOrgId, fixture };
}
