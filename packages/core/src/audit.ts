import { createHash } from "node:crypto";
import { z } from "zod";

export const AUDIT_ACTIONS = [
  "org.created",
  "org.updated",
  "member.added",
  "member.updated",
  "member.removed",
  "role.created",
  "role.updated",
  "role.deleted",
  "key.issued",
  "key.revoked",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.kickstarted",
  "project.upgraded",
  "repo.added",
  "repo.removed",
  "fingerprints.adopted",
  "fingerprints.verified",
  "run.started",
  "run.canceled",
  "run.steered",
  "run.finished",
  "hitl.proposed",
  "hitl.decided",
  "hitl.executed",
  "mcp.tool.executed",
  "registry.created",
  "registry.versioned",
  "registry.published",
  "registry.deprecated",
  "budget.created",
  "budget.updated",
  "budget.deleted",
  "provider.created",
  "provider.deleted",
  "kb.updated",
  "task.proposed",
  "task.updated",
  "issue.acked",
  "issue.reopened",
  "issue.resolved",
  "auth.login",
  "auth.logout",
] as const;

export const AuditEventSchema = z.object({
  orgId: z.string(),
  actor: z.object({
    type: z.enum(["user", "key", "agent", "system"]),
    id: z.string().optional(),
    name: z.string().optional(),
  }),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string().optional() }),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().optional(),
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashChain(prevHash: string | null, event: unknown): string {
  return createHash("sha256")
    .update(`${prevHash ?? ""}:${stableStringify(event)}`)
    .digest("hex");
}
