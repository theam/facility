// @vitest-environment jsdom
import type { DeliveryAcceptanceReview, StoryWorkflowPolicyState } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPolicy } from "../components/project/workflow-policy";
import { DeliveryAcceptanceConfirmation } from "../components/story/delivery-acceptance-confirmation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const initial: StoryWorkflowPolicyState = {
  revision: 1,
  policy: {
    planApprovalAgents: [],
    holdAfterFailure: false,
    requireDeliveryAcceptance: false,
    requirePreviewForAcceptance: false,
  },
};
function review(): DeliveryAcceptanceReview {
  return {
    schemaVersion: 1,
    orgId: "org",
    projectId: "project",
    storyId: "story",
    proof: "p".repeat(43),
    receipt: null,
    request: {
      id: "request",
      status: "pending",
      requestedBy: { type: "service", id: "service", name: "Fixture service" },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      confirmationUrl:
        "https://facility.test/projects/project/stories/story/delivery-acceptance/request",
      snapshot: {
        candidateRevision: "a".repeat(64),
        scopeRevision: 1,
        planRevision: 1,
        planDigest: "d".repeat(64),
        decisionRevision: 1,
        policyRevision: 1,
        acceptanceRevision: 0,
        previewGeneration: "a".repeat(64),
        pullRequests: [
          {
            repository: "example/app",
            number: 7,
            headSha: "b".repeat(40),
            url: "https://github.com/example/app/pull/7",
          },
        ],
      },
    },
  };
}
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!value) throw Error(`Missing button: ${text}`);
  return value;
}
const click = async (text: string) => act(async () => button(text).click());
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("interactive workflow controls", () => {
  it("keeps configuration read-only without both configuration grants", async () => {
    await act(async () =>
      root.render(
        <WorkflowPolicy projectId="project" initial={initial} agents={[]} canWrite={false} />,
      ),
    );
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.textContent).toContain("must confirm changes in Facility");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires an explicit policy review and preserves its confirmation key after an acknowledgement failure", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let attempts = 0;
    fetcher.mockImplementation(async (url, options) => {
      const body = JSON.parse(String(options?.body));
      calls.push({ path: String(url), body });
      if (String(url).endsWith("/review"))
        return response({
          expectedRevision: 1,
          policy: body.policy,
          nonce: "nonce",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          proof: "p".repeat(43),
        });
      if (++attempts === 1)
        return response({ error: { message: "Acknowledgement unavailable" } }, 503);
      return response({ revision: 2, policy: body.policy });
    });
    await act(async () =>
      root.render(<WorkflowPolicy projectId="project" initial={initial} agents={[]} canWrite />),
    );
    const delivery = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Require human acceptance"))
      ?.querySelector("input");
    if (!delivery) throw Error("Missing delivery acceptance policy input");
    await act(async () => delivery.click());
    expect(fetcher).not.toHaveBeenCalled();
    await click("Review changes");
    expect(calls).toHaveLength(1);
    expect(container.textContent).toContain("Queued agents may start immediately");
    await click("Confirm workflow policy");
    expect(container.textContent).toContain("Acknowledgement unavailable");
    await click("Confirm workflow policy");
    expect(calls[1]?.body).toEqual(calls[2]?.body);
    expect(calls[1]?.body).toMatchObject({
      expected_revision: 1,
      nonce: "nonce",
      proof: "p".repeat(43),
      policy: { requireDeliveryAcceptance: true },
    });
    expect(container.textContent).toContain("Workflow policy saved");
  });
  it("shows the exact reviewed heads and requires a click, retaining the same acceptance retry key", async () => {
    const value = review(),
      calls: unknown[] = [];
    let attempts = 0;
    fetcher.mockImplementation(async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)));
      if (++attempts === 1) return response({ error: { message: "Connection interrupted" } }, 503);
      return response({
        status: "current",
        receipt: {
          id: "receipt",
          revision: 1,
          requestId: value.request.id,
          snapshot: value.request.snapshot,
          confirmedBy: { type: "user", id: "person", name: "Ada" },
          confirmedAt: new Date().toISOString(),
          method: "interactive_session",
        },
      });
    });
    await act(async () => root.render(<DeliveryAcceptanceConfirmation initial={value} />));
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain("b".repeat(40));
    expect(container.querySelector("a[target='_blank']")?.getAttribute("href")).toBe(
      "https://github.com/example/app/pull/7",
    );
    await click("Accept this exact delivery");
    expect(container.textContent).toContain("Connection interrupted");
    await click("Accept this exact delivery");
    expect(calls[0]).toEqual(calls[1]);
    expect(container.textContent).toContain("Acceptance recorded");
    expect(container.textContent).toContain("Accepted by Ada");
  });
  it.each([
    "expired",
    "superseded",
  ] as const)("does not offer confirmation of a %s review", async (status) => {
    const value = review();
    value.request.status = status;
    if (status === "expired") value.request.expiresAt = new Date(Date.now() - 60000).toISOString();
    await act(async () => root.render(<DeliveryAcceptanceConfirmation initial={value} />));
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "Accept this exact delivery",
      ),
    ).toBe(false);
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
