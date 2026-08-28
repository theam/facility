import { describe, expect, it } from "vitest";
import {
  architectPlanPublicationKey,
  architectPlanPublicationMarker,
  effectiveArchitectPlanProposalState,
  findArchitectPlanPublicationComment,
  isGithubNotFound,
  legacyRunProgressMarker,
  renderClosedArchitectPlanPublication,
  rotateArchitectPlanPublicationOrgIds,
} from "../src/github/architect-plan-publication.js";

describe("Architect plan publication", () => {
  it("builds a stable tenant-independent publication identity", () => {
    expect(architectPlanPublicationKey("run_123", "prop_456")).toBe(
      "architect-plan:run_123:prop_456",
    );
  });

  it("wraps the stable identity in a recoverable GitHub marker", () => {
    expect(architectPlanPublicationMarker("run_123", "prop_456")).toBe(
      "<!-- facility:architect-plan:run_123:prop_456 -->",
    );
  });

  it("recognizes Octokit not-found errors without swallowing other failures", () => {
    expect(isGithubNotFound({ status: 404 })).toBe(true);
    expect(isGithubNotFound({ statusCode: 404 })).toBe(true);
    expect(isGithubNotFound({ response: { status: 404 } })).toBe(true);
    expect(isGithubNotFound({ status: 500 })).toBe(false);
  });

  it("prefers the new marker but can recover a bot-authored legacy progress comment", () => {
    const comments = [
      {
        id: 1,
        authorType: "User",
        body: legacyRunProgressMarker("run_123"),
      },
      {
        id: 2,
        authorType: "Bot",
        body: legacyRunProgressMarker("run_123"),
      },
      {
        id: 3,
        authorType: "Bot",
        body: architectPlanPublicationMarker("run_123", "prop_456"),
      },
    ];
    expect(
      findArchitectPlanPublicationComment(comments, {
        runId: "run_123",
        publicationMarker: architectPlanPublicationMarker("run_123", "prop_456"),
        allowLegacy: true,
      })?.id,
    ).toBe(3);
    expect(
      findArchitectPlanPublicationComment(comments.slice(0, 2), {
        runId: "run_123",
        publicationMarker: architectPlanPublicationMarker("run_123", "prop_456"),
        allowLegacy: true,
      })?.id,
    ).toBe(2);
  });

  it("does not treat a legacy progress marker as an unpublished outbox delivery", () => {
    expect(
      findArchitectPlanPublicationComment(
        [{ id: 2, authorType: "Bot", body: legacyRunProgressMarker("run_123") }],
        {
          runId: "run_123",
          publicationMarker: architectPlanPublicationMarker("run_123", "prop_456"),
          allowLegacy: false,
        },
      ),
    ).toBeUndefined();
  });

  it("rotates a bounded organization window without starving the remainder", () => {
    const orgIds = Array.from({ length: 30 }, (_, index) => `org_${index}`);
    const first = rotateArchitectPlanPublicationOrgIds(
      orgIds,
      new Date("1970-01-01T00:00:00.000Z"),
      25,
    );
    const second = rotateArchitectPlanPublicationOrgIds(
      orgIds,
      new Date("1970-01-01T00:01:00.000Z"),
      25,
    );

    expect(first).toHaveLength(25);
    expect(second).toHaveLength(25);
    expect(new Set([...first, ...second])).toEqual(new Set(orgIds));
  });

  it("preserves all eligible organizations when they fit in one window", () => {
    expect(
      rotateArchitectPlanPublicationOrgIds(
        ["org_a", "org_b"],
        new Date("2026-08-26T12:34:00.000Z"),
        25,
      ),
    ).toEqual(["org_a", "org_b"]);
  });

  it("keeps an open proposal effective strictly before expiry", () => {
    expect(
      effectiveArchitectPlanProposalState(
        "open",
        new Date("2026-08-26T12:01:00.000Z"),
        new Date("2026-08-26T12:00:00.000Z"),
      ),
    ).toEqual({ open: true, state: "open" });
  });

  it("treats an open proposal as expired at the exact boundary", () => {
    expect(
      effectiveArchitectPlanProposalState(
        "open",
        new Date("2026-08-26T12:00:00.000Z"),
        new Date("2026-08-26T12:00:00.000Z"),
      ),
    ).toEqual({ open: false, state: "expired" });
  });

  it("preserves an explicit terminal proposal state", () => {
    expect(
      effectiveArchitectPlanProposalState(
        "rejected",
        new Date("2026-08-27T12:00:00.000Z"),
        new Date("2026-08-26T12:00:00.000Z"),
      ),
    ).toEqual({ open: false, state: "rejected" });
  });

  it("renders a terminal snapshot with its marker and without an approval CTA", () => {
    const body = renderClosedArchitectPlanPublication({
      runId: "run_123",
      plan: "1. Keep the gate closed.",
      proposalState: "executed",
      publicationMarker: architectPlanPublicationMarker("run_123", "prop_456"),
      updatedAt: new Date("2026-08-26T12:00:00.000Z"),
    });

    expect(body).toContain("<!-- facility:architect-plan:run_123:prop_456 -->");
    expect(body).toContain("Human Gate 1:** no longer open (`executed`)");
    expect(body).toContain("1. Keep the gate closed.");
    expect(body).toContain("2026-08-26T12:00:00.000Z");
    expect(body).not.toContain("Approve this plan");
    expect(body).not.toContain("/builder");
  });

  it("bounds the terminal plan snapshot", () => {
    const body = renderClosedArchitectPlanPublication({
      runId: "run_123",
      plan: `start${"x".repeat(60_000)}tail`,
      proposalState: "expired",
      publicationMarker: architectPlanPublicationMarker("run_123", "prop_456"),
      updatedAt: new Date("2026-08-26T12:00:00.000Z"),
    });

    expect(body).toContain("start");
    expect(body).not.toContain("tail");
  });
});
