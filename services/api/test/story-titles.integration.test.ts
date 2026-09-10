import { randomUUID } from "node:crypto";
import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  orgs,
  projectBudgets,
  projects,
  stories,
  storyConversations,
  storyMessages,
  turns,
  turnUsage,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CostBudgetService } from "../src/insights/costs.js";
import {
  callTitleProvider,
  StoryTitleService,
  type TitleCompletionCall,
  TitleProviderError,
} from "../src/stories/titles.js";
import { recoverPendingTitles } from "../src/worker.js";

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

describe("story title generation", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; title tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const otherProjectId = newId("proj");

  beforeAll(async () => {
    await migrate(databaseUrl);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Titles", slug: `titles-${suffix}`, settings: {} });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Titles", slug: `titles-${suffix}`, settings: {} },
      { id: otherProjectId, orgId, name: "Other", slug: `titles-other-${suffix}`, settings: {} },
    ]);
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedStory(
    input: {
      titleSource?: "pending" | "user";
      engine?: "claude_code" | "codex";
      message?: string;
      project?: string;
      updatedAt?: Date;
    } = {},
  ) {
    const storyId = newId("story");
    const conversationId = newId("sess");
    const project = input.project ?? projectId;
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId: project,
      provider: "manual",
      externalId: `manual:${storyId}`,
      title: "Provisional title",
      titleSource: input.titleSource ?? "pending",
      status: "working",
      createdBy: { type: "user", id: "user_test" },
      updatedAt: input.updatedAt,
    });
    await db
      .insert(storyConversations)
      .values({ id: conversationId, orgId, projectId: project, storyId });
    await db.insert(storyMessages).values({
      id: newId("msg"),
      orgId,
      projectId: project,
      storyId,
      conversationId,
      seq: 1,
      role: "user",
      body:
        input.message ??
        "Please add a retry to the nightly sync job so transient failures recover.",
      actor: { type: "user", id: "user_test" },
    });
    if (input.engine) {
      await db.insert(turns).values({
        id: newId("turn"),
        orgId,
        projectId: project,
        storyId,
        conversationId,
        agentName: "builder",
        manifestHash: "hash",
        manifest: {},
        engine: input.engine,
        model: input.engine === "codex" ? "gpt-5.5" : "claude-sonnet-5",
        state: "queued",
        triggerType: "ui",
        createdBy: { type: "user", id: "user_test" },
      });
    }
    return storyId;
  }

  async function storyRow(storyId: string) {
    return (await db.select().from(stories).where(eq(stories.id, storyId)))[0];
  }

  function service(
    input: { complete?: TitleCompletionCall; credentials?: Record<string, string> } = {},
  ) {
    return new StoryTitleService(db, {
      credentials: async () => input.credentials ?? { anthropic: "sk-ant-test", openai: "sk-test" },
      budget: new CostBudgetService(db),
      complete:
        input.complete ??
        (async () => ({
          title: "Add retry to the nightly sync job",
          inputTokens: 120,
          outputTokens: 12,
        })),
    });
  }

  it("replaces the provisional title, records usage, and prefers the story's engine provider", async () => {
    const calls: Array<{ provider: string; model: string; request: string }> = [];
    const storyId = await seedStory({ engine: "codex" });
    const outcome = await service({
      complete: async (call) => {
        calls.push(call);
        return {
          title: "  Add retry to the nightly sync job.\n",
          inputTokens: 100,
          outputTokens: 10,
        };
      },
    }).generate({ orgId, projectId, storyId });
    expect(outcome).toEqual({ outcome: "generated", title: "Add retry to the nightly sync job" });
    expect(calls).toMatchObject([{ provider: "openai", model: "gpt-5.5-mini" }]);
    expect(calls[0]?.request).toContain("nightly sync job");
    const row = await storyRow(storyId);
    expect(row).toMatchObject({
      title: "Add retry to the nightly sync job",
      titleSource: "generated",
      titleGeneration: expect.objectContaining({
        status: "generated",
        provider: "openai",
        inputTokens: 100,
        outputTokens: 10,
        attempts: 1,
      }),
    });
    expect((row?.titleGeneration as { costCents: number }).costCents).toBeGreaterThan(0);
    // The original request is untouched.
    expect(
      (await db.select().from(storyMessages).where(eq(storyMessages.storyId, storyId)))[0]?.body,
    ).toContain("Please add a retry");
    expect(await db.select().from(turnUsage).where(eq(turnUsage.storyId, storyId))).toEqual([]);
  });

  it("falls back to the other provider when the preferred credential is missing", async () => {
    const providers: string[] = [];
    const storyId = await seedStory({ engine: "codex" });
    await service({
      credentials: { anthropic: "sk-ant-test" },
      complete: async (call) => {
        providers.push(call.provider);
        return { title: "Generated", inputTokens: 1, outputTokens: 1 };
      },
    }).generate({ orgId, projectId, storyId });
    expect(providers).toEqual(["anthropic"]);
  });

  it("keeps the provisional title and settles as fallback without credentials or budget", async () => {
    const withoutCredentials = await seedStory();
    expect(
      await service({ credentials: {} }).generate({
        orgId,
        projectId,
        storyId: withoutCredentials,
      }),
    ).toEqual({ outcome: "fallback", reason: "credentials_unavailable" });
    expect(await storyRow(withoutCredentials)).toMatchObject({
      title: "Provisional title",
      titleSource: "fallback",
      titleGeneration: expect.objectContaining({ reason: "credentials_unavailable" }),
    });

    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId: otherProjectId,
      monthlyLimitCents: 0,
      warningPercent: 80,
      enabled: true,
      updatedBy: "user_test",
    });
    const complete = vi.fn(async () => ({ title: "Never", inputTokens: 1, outputTokens: 1 }));
    const exhausted = await seedStory({ project: otherProjectId });
    expect(
      await service({ complete }).generate({
        orgId,
        projectId: otherProjectId,
        storyId: exhausted,
      }),
    ).toEqual({ outcome: "fallback", reason: "budget_exceeded" });
    expect(complete).not.toHaveBeenCalled();
    expect((await storyRow(exhausted))?.titleSource).toBe("fallback");
  });

  it("retries transient provider failures and gives up after the attempt limit", async () => {
    const storyId = await seedStory();
    const flaky = service({
      complete: async () => {
        throw new TitleProviderError("provider_unavailable", "anthropic responded with 503", true);
      },
    });
    expect(await flaky.generate({ orgId, projectId, storyId })).toEqual({
      outcome: "retry",
      reason: "provider_unavailable",
    });
    expect(await storyRow(storyId)).toMatchObject({
      titleSource: "pending",
      titleGeneration: expect.objectContaining({ attempts: 1, status: "pending" }),
    });
    expect(await flaky.generate({ orgId, projectId, storyId })).toMatchObject({ outcome: "retry" });
    expect(await flaky.generate({ orgId, projectId, storyId })).toEqual({
      outcome: "fallback",
      reason: "provider_unavailable",
    });
    expect(await storyRow(storyId)).toMatchObject({
      title: "Provisional title",
      titleSource: "fallback",
      titleGeneration: expect.objectContaining({ attempts: 3 }),
    });
  });

  it("does not retry a rejected credential and never overwrites a settled title", async () => {
    const rejected = await seedStory();
    expect(
      await service({
        complete: async () => {
          throw new TitleProviderError("provider_rejected", "anthropic responded with 401", false);
        },
      }).generate({ orgId, projectId, storyId: rejected }),
    ).toEqual({ outcome: "fallback", reason: "provider_rejected" });

    const settled = await seedStory({ titleSource: "user" });
    const complete = vi.fn(async () => ({ title: "Late", inputTokens: 1, outputTokens: 1 }));
    expect(await service({ complete }).generate({ orgId, projectId, storyId: settled })).toEqual({
      outcome: "skipped",
      reason: "title_settled",
    });
    expect(complete).not.toHaveBeenCalled();

    // A completion that lands after the story settled is discarded.
    const raced = await seedStory();
    const racing = service({
      complete: async () => {
        await db.update(stories).set({ titleSource: "fallback" }).where(eq(stories.id, raced));
        return { title: "Too late", inputTokens: 1, outputTokens: 1 };
      },
    });
    expect(await racing.generate({ orgId, projectId, storyId: raced })).toEqual({
      outcome: "skipped",
      reason: "title_settled",
    });
    expect((await storyRow(raced))?.title).toBe("Provisional title");
  });

  it("re-queues only stale pending titles, and generation stays idempotent", async () => {
    const stale = await seedStory({ updatedAt: new Date(Date.now() - 10 * 60 * 1_000) });
    const fresh = await seedStory();
    const enqueued: Array<Record<string, unknown>> = [];
    const titles = service();
    expect(
      await recoverPendingTitles(titles, async (queue, data) => {
        expect(queue).toBe("stories.title");
        enqueued.push(data);
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(enqueued.map((entry) => entry.storyId)).toContain(stale);
    expect(enqueued.map((entry) => entry.storyId)).not.toContain(fresh);
    await titles.generate({ orgId, projectId, storyId: stale });
    expect(await titles.generate({ orgId, projectId, storyId: stale })).toEqual({
      outcome: "skipped",
      reason: "title_settled",
    });
  });

  it("is scoped to the story's project", async () => {
    const storyId = await seedStory();
    expect(await service().generate({ orgId, projectId: otherProjectId, storyId })).toEqual({
      outcome: "skipped",
      reason: "story_not_found",
    });
    expect((await storyRow(storyId))?.titleSource).toBe("pending");
  });
});

describe("title provider calls", () => {
  it("talks to Anthropic and OpenAI without exposing credentials in errors", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      if (url.includes("anthropic")) {
        return Response.json({
          content: [{ type: "text", text: "Add retry to the sync job" }],
          usage: { input_tokens: 40, output_tokens: 8 },
        });
      }
      return Response.json({
        choices: [{ message: { content: "Add retry to the sync job" } }],
        usage: { prompt_tokens: 41, completion_tokens: 9 },
      });
    };
    expect(
      await callTitleProvider(
        { provider: "anthropic", apiKey: "sk-ant-secret", model: "claude-haiku-4-5", request: "x" },
        fetchImpl,
      ),
    ).toEqual({ title: "Add retry to the sync job", inputTokens: 40, outputTokens: 8 });
    expect(
      await callTitleProvider(
        { provider: "openai", apiKey: "sk-secret", model: "gpt-5.5-mini", request: "x" },
        fetchImpl,
      ),
    ).toEqual({ title: "Add retry to the sync job", inputTokens: 41, outputTokens: 9 });
    expect(requests[0]?.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(requests[1]?.headers.authorization).toBe("Bearer sk-secret");
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain("secret");

    const rateLimited = callTitleProvider(
      { provider: "openai", apiKey: "sk-secret", model: "gpt-5.5-mini", request: "x" },
      async () => new Response("slow down", { status: 429 }),
    );
    await expect(rateLimited).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    const unauthorized = callTitleProvider(
      { provider: "anthropic", apiKey: "sk-ant-secret", model: "claude-haiku-4-5", request: "x" },
      async () => new Response("nope", { status: 401 }),
    );
    await expect(unauthorized).rejects.toMatchObject({
      code: "provider_rejected",
      retryable: false,
    });
    await expect(unauthorized).rejects.not.toThrow(/secret/);
    const empty = callTitleProvider(
      { provider: "openai", apiKey: "sk-secret", model: "gpt-5.5-mini", request: "x" },
      async () => Response.json({ choices: [] }),
    );
    await expect(empty).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
});
