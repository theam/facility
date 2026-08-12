import { describe, expect, it } from "vitest";
import type { AgentStatus, Catalog, LlmRequest, Outcome, Pipeline, Run, SpendRow } from "@/lib/api";
import { buildDeliveryIntelligence } from "@/lib/delivery-intelligence";

const periodStart = "2026-08-01T00:00:00.000Z";

const agents = [
  {
    agentId: "agent_builder",
    name: "builder",
    engine: "codex",
    model: { primary: "gpt-5.6-sol" },
  },
  {
    agentId: "agent_architect",
    name: "architect",
    engine: "claude_code",
    model: { model: "claude-opus-4-8" },
  },
] as unknown as AgentStatus[];

const runs = [
  {
    id: "run_builder",
    agentDefId: "agent_builder",
    engine: "codex",
    gh: { owner: "theam", repo: "tam-os", issueNumber: 1092 },
    receipt: { usage: { cost_cents: 384 } },
  },
] as unknown as Run[];

const pipeline = {
  stages: [
    {
      key: "shipped",
      label: "Shipped",
      stories: [
        {
          repoId: "repo_tam_os",
          repoOwner: "theam",
          repoName: "tam-os",
          storyType: "issue",
          number: 1092,
          title: "External share: one polymorphic core for every resource",
          assignees: ["adrian-lorenzo"],
          prs: [
            {
              number: 1102,
              url: "https://github.com/theam/tam-os/pull/1102",
            },
          ],
        },
      ],
    },
  ],
} as unknown as Pipeline;

const outcome = {
  id: "outcome_1102",
  runId: "run_builder",
  projectId: "proj_tam_os",
  repo: "theam/tam-os",
  prNumber: 1102,
  agentLane: "builder",
  terminalAt: "2026-08-11T18:00:00.000Z",
  fate: "merged",
  reviewRounds: 0,
  fixupCommits: 0,
} as unknown as Outcome;

const requests = [
  {
    id: "llm_1",
    runId: "run_builder",
    agentDefId: "agent_builder",
    provider: "openai",
    model: "gpt-5.6-sol",
    costCents: 300,
    createdAt: "2026-08-11T17:00:00.000Z",
  },
  {
    id: "llm_2",
    runId: "run_builder",
    agentDefId: "agent_builder",
    provider: "openai",
    model: "gpt-5.6-terra",
    costCents: 84,
    createdAt: "2026-08-11T17:30:00.000Z",
  },
] as unknown as LlmRequest[];

describe("delivery intelligence", () => {
  it("compares gateway spend using agent, engine, provider, model, and shipped yield", () => {
    const result = buildDeliveryIntelligence({
      projectId: "proj_tam_os",
      periodStart,
      spend: [
        { bucket: "agent_builder", cost_cents: 1200 },
        { bucket: "agent_architect", cost_cents: 800 },
      ] as SpendRow[],
      agents,
      runs,
      outcomes: [outcome],
      requests,
      pipeline,
      catalog: { models: [] } as unknown as Catalog,
    });

    expect(result).toMatchObject({
      totalSpendCents: 2000,
      shippedCount: 1,
      costPerShippedCents: 2000,
    });
    expect(result.spendRows[0]).toMatchObject({
      agentName: "builder",
      engine: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      additionalModelCount: 1,
      spendCents: 1200,
      sharePercent: 60,
      shippedCount: 1,
      costPerShippedCents: 1200,
    });
    expect(result.spendRows[1]).toMatchObject({
      agentName: "architect",
      provider: "anthropic",
      model: "claude-opus-4-8",
      shippedCount: 0,
      costPerShippedCents: null,
    });
  });

  it("makes shipped work identifiable and auditable without reducing it to a PR number", () => {
    const result = buildDeliveryIntelligence({
      projectId: "proj_tam_os",
      periodStart,
      spend: [{ bucket: "agent_builder", cost_cents: 384 }] as SpendRow[],
      agents,
      runs,
      outcomes: [outcome],
      requests,
      pipeline,
      catalog: null,
    });

    expect(result.shippedRows).toEqual([
      expect.objectContaining({
        storyLabel: "theam/tam-os#1092",
        storyTitle: "External share: one polymorphic core for every resource",
        storyHref: "/projects/proj_tam_os/stories/1092?repoId=repo_tam_os&storyType=issue",
        assignees: ["adrian-lorenzo"],
        agentName: "builder",
        engine: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
        additionalModelCount: 1,
        costCents: 384,
        pullHref: "https://github.com/theam/tam-os/pull/1102",
        oneShot: true,
      }),
    ]);
  });

  it("does not report closed but unmerged pull requests as shipped", () => {
    const result = buildDeliveryIntelligence({
      projectId: "proj_tam_os",
      periodStart,
      spend: [],
      agents,
      runs,
      outcomes: [{ ...outcome, fate: "closed" } as unknown as Outcome],
      requests,
      pipeline,
      catalog: null,
    });

    expect(result.shippedCount).toBe(0);
    expect(result.shippedRows).toEqual([]);
  });
});
