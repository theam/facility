// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import InsightsPage from "../app/(app)/projects/[projectId]/insights/page";

const mocks = vi.hoisted(() => ({
  denied: false,
  measured: 1,
  failed: 2,
  budgetUnconfirmed: false,
  budgetWritable: true,
  identityUnavailable: false,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../components/insights/budget-form", () => ({
  BudgetForm: () => <button type="button">Save budget</button>,
}));
vi.mock("../lib/api", () => ({
  api: {
    me: async () =>
      mocks.identityUnavailable
        ? { ok: false, message: "Identity unavailable" }
        : {
            ok: true,
            data: { permissions: mocks.budgetWritable ? ["budgets:write"] : ["budgets:read"] },
          },
    projectObservability: async () =>
      mocks.denied
        ? { ok: false, offline: false, message: "Access denied" }
        : {
            ok: true,
            data: {
              health: "attention",
              turns: {
                total: 3,
                succeeded: 1,
                failed: mocks.failed,
                canceled: 0,
                queued: 0,
                running: 0,
                successRate: null,
              },
              usage: {
                turns: mocks.measured,
                unpricedTurns: 0,
                costCents: 125,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                durationMs: 0,
              },
              workspaces: { retained: 0, states: {} },
              github: { openPullRequests: 0, failedChecks: 0 },
              analytics: {
                mergedPullRequests: 0,
                observedFirstPassRate: null,
                observedFirstPassMerges: 0,
                ciEvidenceMerges: 0,
                averagePullRequestLeadTimeHours: null,
                ciEvidenceRate: null,
                activeAgents: 0,
              },
              attention: { open: 0 },
              byAgent: [],
              byModel: [],
              recentAudit: [],
            },
          },
    projectBudget: async () => ({
      ok: true,
      data: {
        state: mocks.budgetUnconfirmed ? "unconfirmed" : "not_configured",
        spent_cents: 0,
        monthly_limit_cents: 5000,
        enabled: true,
      },
    }),
  },
}));

async function page() {
  return renderToStaticMarkup(
    await InsightsPage({ params: Promise.resolve({ projectId: "example" }) }),
  );
}

describe("Insights spend rendering", () => {
  it("shows budget editing only to a writer and retains readable policy for a viewer", async () => {
    expect(await page()).toContain("Save budget");
    mocks.budgetWritable = false;
    const html = await page();
    expect(html).not.toContain("Save budget");
    expect(html).toContain("Monthly limit: $50.00.");
    expect(html).toContain("Enforcement is");
    mocks.budgetWritable = true;
  });
  it("hides budget mutations when identity is unavailable without discarding authorized reads", async () => {
    mocks.identityUnavailable = true;
    const html = await page();
    expect(html).not.toContain("Save budget");
    expect(html).toContain("Monthly limit: $50.00.");
    mocks.identityUnavailable = false;
  });
  it("shows interrupted budget spending as a lower bound and explains the model-call block", async () => {
    mocks.budgetUnconfirmed = true;
    const html = await page();
    expect(html).toContain("unconfirmed");
    expect(html).toContain("At least");
    expect(html).toContain("new model calls are blocked while the budget is enabled");
    expect(html).toContain("open reservations and settled title charges");
    mocks.budgetUnconfirmed = false;
  });
  it("shows partial cost and the missing usage in the actual page", async () => {
    mocks.denied = false;
    mocks.measured = 1;
    mocks.failed = 2;
    const html = await page();
    expect(html).toContain("at least $1.25");
    expect(html).toContain("1 priced · 2 without a price");
    expect(html).not.toContain("0 unpriced turns");
  });
  it("shows unknown cost when no completed turn reported usage", async () => {
    mocks.measured = 0;
    const html = await page();
    expect(html).toContain("unknown");
    expect(html).toContain("3 turns without a price");
  });
  it("does not render cost data when the observability request is denied", async () => {
    mocks.denied = true;
    const html = await page();
    expect(html).toContain("Access denied");
    expect(html).not.toContain("$1.25");
    mocks.denied = false;
  });
});
