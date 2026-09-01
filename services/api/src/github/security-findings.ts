import { z } from "zod";
import type { FacilityGithubClient } from "./client.js";
import { ensureTrackedIssue } from "./tracked-issues.js";

export const SecurityReportSchema = z
  .object({
    schema: z.literal("facility.security.findings.v1"),
    findings: z
      .array(
        z
          .object({
            fingerprint: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[a-z0-9][a-z0-9._:/-]*$/i),
            title: z.string().min(1).max(200),
            severity: z.enum(["low", "medium", "high", "critical"]),
            confidence: z.enum(["low", "medium", "high"]),
            actionable: z.boolean(),
            risk: z.string().min(1).max(8_000),
            locations: z.array(z.string().min(1).max(500)).min(1).max(20),
            smallest_fix: z.string().min(1).max(8_000),
            evidence: z.array(z.string().min(1).max(1_000)).max(20).default([]),
          })
          .strict(),
      )
      .max(20),
    dismissed: z.array(z.string().min(1).max(1_000)).max(100).default([]),
    scanners_not_enabled: z.array(z.string().min(1).max(200)).max(20).default([]),
  })
  .strict();

export type SecurityReport = z.infer<typeof SecurityReportSchema>;
export type SecurityFinding = SecurityReport["findings"][number];

export function qualifyingSecurityFindings(report: SecurityReport) {
  return report.findings.filter(
    (finding) =>
      finding.actionable &&
      finding.confidence === "high" &&
      ["high", "critical"].includes(finding.severity),
  );
}

export function sanitizeSecurityReport(report: SecurityReport): SecurityReport {
  return {
    ...report,
    findings: report.findings.map((finding) => ({
      ...finding,
      title: redactSecurityText(finding.title),
      risk: redactSecurityText(finding.risk),
      locations: finding.locations.map(redactSecurityText),
      smallest_fix: redactSecurityText(finding.smallest_fix),
      evidence: finding.evidence.map(redactSecurityText),
    })),
    dismissed: report.dismissed.map(redactSecurityText),
    scanners_not_enabled: report.scanners_not_enabled.map(redactSecurityText),
  };
}

export async function syncSecurityFindings(
  client: FacilityGithubClient,
  report: SecurityReport,
  source: { runId: string },
  assertOwnership?: () => Promise<void>,
) {
  const synced = [];
  for (const finding of qualifyingSecurityFindings(report)) {
    // Each finding costs several GitHub calls, so a long report is where a
    // finalization attempt outlives its lease. The caller's assertion re-proves
    // ownership before every finding, not only between finalization steps: an
    // attempt that stalled and was superseded stops here, before it can race
    // the winning attempt's ensureTrackedIssue into a duplicate issue.
    await assertOwnership?.();
    const issue = await ensureTrackedIssue(client, {
      kind: "security",
      fingerprint: finding.fingerprint,
      title: `[Security] ${redactSecurityText(finding.title)}`,
      body: renderSecurityIssue(finding, source),
      labels: [
        {
          name: "facility-security",
          color: "B60205",
          description: "High-confidence security finding synchronized by Facility",
        },
        {
          name: "needs-security-triage",
          color: "D93F0B",
          description: "Requires human security triage",
        },
      ],
    });
    synced.push({ fingerprint: finding.fingerprint, ...issue });
  }
  return { eligible: synced.length, synced };
}

export function renderSecurityIssue(finding: SecurityFinding, source: { runId: string }) {
  const evidence = finding.evidence.length
    ? finding.evidence.map((item) => `- ${redactSecurityText(item)}`).join("\n")
    : "- See the cited repository locations and the security run transcript.";
  return [
    `Facility's read-only security audit classified this finding as **${finding.severity}** severity with **${finding.confidence}** confidence.`,
    "",
    "## Risk",
    "",
    redactSecurityText(finding.risk),
    "",
    "## Locations",
    "",
    ...finding.locations.map((location) => `- \`${redactSecurityText(location)}\``),
    "",
    "## Smallest safe fix",
    "",
    redactSecurityText(finding.smallest_fix),
    "",
    "## Evidence",
    "",
    evidence,
    "",
    `Source run: \`${source.runId}\``,
    "",
    "Start with `/architect` so the proposed remediation and its acceptance checks are reviewed before `/builder` implements it.",
  ].join("\n");
}

export function redactSecurityText(value: string) {
  return value
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "«redacted»")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "«redacted»")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g, "«redacted»")
    .replace(
      /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
      "$1\n«redacted»\n$2",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1«redacted»");
}
