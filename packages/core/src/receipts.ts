import { createHash } from "node:crypto";
import { z } from "zod";

const ReceiptCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped", "unknown"]),
  source: z.enum(["platform", "agent"]),
  exit_code: z.number().int().optional(),
});

export const FacilityReceiptSchema = z.object({
  schema: z.literal("facility.run.v1"),
  run_id: z.string().optional(),
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
  provider: z.enum(["claude_code", "codex_cli", "byo"]),
  model: z.string().optional(),
  mode: z.enum([
    "architect",
    "builder",
    "review",
    "address_review",
    "ci_doctor",
    "security_sweep",
    "po",
    "learning",
    "canary",
    "custom",
  ]),
  result: z.string(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative().optional(),
    cache_write: z.number().int().nonnegative().optional(),
    cost_cents: z.number().int().nonnegative().nullable(),
    cost_source: z.string(),
  }),
  activity: z.object({
    turns: z.number().int().nonnegative(),
    shell_commands: z.number().int().nonnegative(),
    file_changes: z.number().int().nonnegative(),
    mcp_tool_calls: z.number().int().nonnegative(),
    web_searches: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  github: z
    .object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      issue: z.number().int().optional(),
      pr: z.number().int().optional(),
      actor_sha256: z.string().optional(),
    })
    .optional(),
  timing: z.object({
    started_at: z.string(),
    ended_at: z.string().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
  }),
  events: z
    .object({
      count: z.number().int().nonnegative(),
      checks: z.number().int().nonnegative(),
    })
    .optional(),
  checks: z.array(ReceiptCheckSchema).optional(),
  checks_truncated: z.boolean().optional(),
  integrity: z
    .object({
      algorithm: z.literal("sha256"),
      previous_sha256: z.string().length(64).nullable(),
      payload_sha256: z.string().length(64),
      attestation: z.string().optional(),
    })
    .optional(),
});

export type FacilityReceipt = z.infer<typeof FacilityReceiptSchema>;

export function receiptContentDigest(receipt: FacilityReceipt): string {
  const parsed = FacilityReceiptSchema.parse(receipt);
  const { integrity, ...content } = parsed;
  return receiptDigest(content, integrity?.previous_sha256 ?? null, integrity?.attestation);
}

export function sealFacilityReceipt(
  receipt: FacilityReceipt,
  previousSha256: string | null,
): FacilityReceipt {
  const parsed = FacilityReceiptSchema.parse(receipt);
  const { integrity: _integrity, ...content } = parsed;
  const integrity = {
    algorithm: "sha256" as const,
    previous_sha256: previousSha256,
    ...(parsed.integrity?.attestation ? { attestation: parsed.integrity.attestation } : {}),
  };
  return FacilityReceiptSchema.parse({
    ...content,
    integrity: {
      ...integrity,
      payload_sha256: receiptDigest(content, previousSha256, integrity.attestation),
    },
  });
}

export function verifyFacilityReceipt(receipt: FacilityReceipt): boolean {
  const parsed = FacilityReceiptSchema.safeParse(receipt);
  if (!parsed.success || !parsed.data.integrity) return false;
  return parsed.data.integrity.payload_sha256 === receiptContentDigest(parsed.data);
}

function receiptDigest(
  content: Record<string, unknown>,
  previousSha256: string | null,
  attestation?: string,
): string {
  const digestable = {
    ...content,
    integrity: {
      algorithm: "sha256",
      previous_sha256: previousSha256,
      ...(attestation ? { attestation } : {}),
    },
  };
  return createHash("sha256").update(stableStringify(digestable)).digest("hex");
}

const LegacyAgentReceiptSchema = z.object({
  schema: z.string().regex(/(^|\.)agent_sdlc\.run\.v1$/),
  provider: z.enum(["claude_code", "codex_cli"]),
  mode: z.enum(["architect", "builder", "review", "address_review", "ci_doctor", "security_sweep"]),
  result: z.string(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative().optional(),
    cache_write: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
    cost_source: z.string(),
  }),
  activity: z.object({
    turns: z.number().int().nonnegative().default(0),
    shell_commands: z.number().int().nonnegative().default(0),
    file_changes: z.number().int().nonnegative().default(0),
    mcp_tool_calls: z.number().int().nonnegative().default(0),
    web_searches: z.number().int().nonnegative().default(0),
    tool_calls: z.number().int().nonnegative().default(0),
    errors: z.number().int().nonnegative().default(0),
  }),
  github: z
    .object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      issue: z.number().int().optional(),
      pr: z.number().int().optional(),
      actor: z.string().optional(),
      actor_sha256: z.string().optional(),
    })
    .optional(),
  timing: z.object({
    started_at: z.string(),
    ended_at: z.string().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
  }),
  checks: z.array(ReceiptCheckSchema).optional(),
});

function hashActor(actor: string): string {
  return createHash("sha256").update(actor).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseLegacyAgentReceipt(json: unknown): FacilityReceipt {
  const receipt = LegacyAgentReceiptSchema.parse(json);
  return FacilityReceiptSchema.parse({
    schema: "facility.run.v1",
    provider: receipt.provider,
    mode: receipt.mode,
    result: receipt.result,
    usage: {
      input_tokens: receipt.usage.input_tokens,
      output_tokens: receipt.usage.output_tokens,
      cache_read: receipt.usage.cache_read,
      cache_write: receipt.usage.cache_write,
      cost_cents:
        receipt.usage.cost_usd == null ? null : Math.floor(receipt.usage.cost_usd * 100 + 0.5),
      cost_source: receipt.usage.cost_source,
    },
    activity: receipt.activity,
    github: receipt.github
      ? {
          owner: receipt.github.owner,
          repo: receipt.github.repo,
          issue: receipt.github.issue,
          pr: receipt.github.pr,
          actor_sha256:
            receipt.github.actor_sha256 ??
            (receipt.github.actor ? hashActor(receipt.github.actor) : undefined),
        }
      : undefined,
    timing: receipt.timing,
    checks: receipt.checks,
  });
}
