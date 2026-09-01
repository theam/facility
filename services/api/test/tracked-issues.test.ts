import { describe, expect, it } from "vitest";
import { FacilityGithubClient, type Octokit } from "../src/github/client.js";
import {
  qualifyingSecurityFindings,
  redactSecurityText,
  SecurityReportSchema,
  syncSecurityFindings,
} from "../src/github/security-findings.js";
import { ensureTrackedIssue, trackedIssueMarker } from "../src/github/tracked-issues.js";

describe("trusted GitHub issue projection", () => {
  it("deduplicates against a closed learning decision without reopening or rewriting it", async () => {
    const marker = trackedIssueMarker("learning", "guard:repeated-failure");
    const observed: Record<string, unknown> = {};
    const octokit = {
      rest: {
        issues: {
          listForRepo: async () => ({
            data: [
              {
                number: 9,
                state: "closed",
                html_url: "https://github.test/issues/9",
                body: `old body\n${marker}`,
                labels: [{ name: "human-priority" }],
              },
            ],
          }),
          createLabel: async () => ({ data: {} }),
          update: async (input: Record<string, unknown>) => {
            observed.update = input;
            return { data: { number: 9, html_url: "https://github.test/issues/9" } };
          },
          create: async () => {
            throw new Error("must not create a duplicate");
          },
        },
      },
    } as unknown as Octokit;
    const client = new FacilityGithubClient(octokit, {
      owner: "acme",
      repo: "app",
      defaultBranch: "main",
    });

    const result = await ensureTrackedIssue(client, {
      kind: "learning",
      fingerprint: "guard:repeated-failure",
      title: "Learned task",
      body: "Current evidence",
      labels: [{ name: "facility-learning", color: "5319E7", description: "Learning task" }],
      reopen: false,
    });

    expect(result).toMatchObject({ number: 9, created: false, updated: false });
    expect(observed.update).toBeUndefined();
  });

  it("updates an open tracked issue while preserving human labels", async () => {
    const marker = trackedIssueMarker("security", "reachable-auth-bypass");
    let update: Record<string, unknown> | undefined;
    const client = new FacilityGithubClient(
      {
        rest: {
          issues: {
            listForRepo: async () => ({
              data: [
                {
                  number: 10,
                  state: "open",
                  body: marker,
                  labels: [{ name: "human-priority" }],
                },
              ],
            }),
            createLabel: async () => ({ data: {} }),
            update: async (input: Record<string, unknown>) => {
              update = input;
              return { data: { number: 10, html_url: "https://github.test/issues/10" } };
            },
            create: async () => {
              throw new Error("must not create a duplicate");
            },
          },
        },
      } as unknown as Octokit,
      { owner: "acme", repo: "app", defaultBranch: "main" },
    );

    await expect(
      ensureTrackedIssue(client, {
        kind: "security",
        fingerprint: "reachable-auth-bypass",
        title: "Security finding",
        body: "Current evidence",
        labels: [{ name: "facility-security", color: "B60205", description: "Security" }],
      }),
    ).resolves.toMatchObject({ number: 10, created: false, updated: true });
    expect(update).toMatchObject({ labels: ["human-priority", "facility-security"] });
  });

  it("qualifies only high-confidence actionable high/critical security findings", () => {
    const finding = {
      fingerprint: "auth-bypass",
      title: "Authorization bypass",
      severity: "high" as const,
      confidence: "high" as const,
      actionable: true,
      risk: "Reachable admin path",
      locations: ["src/admin.ts:4"],
      smallest_fix: "Apply the authorization guard",
      evidence: [],
    };
    const report = SecurityReportSchema.parse({
      schema: "facility.security.findings.v1",
      findings: [finding, { ...finding, fingerprint: "low", severity: "low" }],
    });
    expect(qualifyingSecurityFindings(report).map((item) => item.fingerprint)).toEqual([
      "auth-bypass",
    ]);
    expect(redactSecurityText("credential ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe(
      "credential «redacted»",
    );
  });

  it("re-proves finalization ownership before each finding it syncs", async () => {
    // The sync is the long tail of run finalization — several GitHub calls per
    // finding — so ownership of the finalization lease is asserted per finding,
    // not only around the whole step: an attempt superseded mid-report must
    // stop before it races the winner into a duplicate tracked issue.
    const finding = {
      fingerprint: "auth-bypass",
      title: "Authorization bypass",
      severity: "high" as const,
      confidence: "high" as const,
      actionable: true,
      risk: "Reachable admin path",
      locations: ["src/admin.ts:4"],
      smallest_fix: "Apply the authorization guard",
      evidence: [],
    };
    const report = SecurityReportSchema.parse({
      schema: "facility.security.findings.v1",
      findings: [finding, { ...finding, fingerprint: "second" }],
    });
    let created = 0;
    const client = new FacilityGithubClient(
      {
        rest: {
          issues: {
            listForRepo: async () => ({ data: [] }),
            createLabel: async () => ({ data: {} }),
            create: async () => {
              created += 1;
              return {
                data: { number: created, html_url: `https://github.test/issues/${created}` },
              };
            },
          },
        },
      } as unknown as Octokit,
      { owner: "acme", repo: "app", defaultBranch: "main" },
    );
    let assertionsLeft = 1;
    await expect(
      syncSecurityFindings(client, report, { runId: "run_test" }, async () => {
        assertionsLeft -= 1;
        if (assertionsLeft < 0) throw new Error("finalization superseded");
      }),
    ).rejects.toThrow("finalization superseded");
    // The report carries two qualifying findings; ownership held for the first
    // and was lost before the second, so exactly one issue was created.
    expect(created).toBe(1);
  });
});
