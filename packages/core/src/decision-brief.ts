import { z } from "zod";

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"));
const Claim = z.object({ text: text(600), evidenceIds: z.array(Id).max(8) }).strict();
const Evidence = z
  .object({
    id: Id,
    label: text(120),
    reference: text(160),
    url: z
      .string()
      .max(2000)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            ![...value].some(
              (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === "\\",
            )
          );
        } catch {
          return false;
        }
      }, "Use an HTTP(S) source URL without credentials or control characters")
      .url(),
  })
  .strict();

/** Author statements, not permissions, workflow policy or verified observations. */
export const DecisionBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: Claim,
    whyNow: Claim,
    options: z
      .array(z.object({ id: Id, label: text(100), consequence: Claim }).strict())
      .min(2)
      .max(4),
    recommendation: z.object({ optionId: Id, reason: Claim }).strict().nullable(),
    decisiveRisk: Claim,
    unknowns: z.array(Claim).max(5),
    evidence: z.array(Evidence).max(8),
  })
  .strict()
  .superRefine((brief, ctx) => {
    const options = new Set(brief.options.map((option) => option.id));
    const evidence = new Set(brief.evidence.map((source) => source.id));
    if (options.size !== brief.options.length || evidence.size !== brief.evidence.length)
      ctx.addIssue({ code: "custom", message: "Use unique option and evidence IDs" });
    if (brief.recommendation && !options.has(brief.recommendation.optionId))
      ctx.addIssue({ code: "custom", message: "Recommend one of the listed options" });
    const claims = [
      brief.summary,
      brief.whyNow,
      brief.decisiveRisk,
      ...brief.options.map((option) => option.consequence),
      ...brief.unknowns,
      ...(brief.recommendation ? [brief.recommendation.reason] : []),
    ];
    for (const claim of claims) {
      if (
        new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
        claim.evidenceIds.some((id) => !evidence.has(id))
      )
        ctx.addIssue({ code: "custom", message: "Reference each listed source at most once" });
    }
  });

export const DecisionBriefProjectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), brief: DecisionBriefSchema }),
  z.object({ status: z.literal("absent") }),
  z.object({
    status: z.literal("invalid"),
    reason: z.enum([
      "duplicate",
      "malformed",
      "unsupported_version",
      "invalid_fields",
      "too_large",
    ]),
  }),
]);
export type DecisionBrief = z.infer<typeof DecisionBriefSchema>;
export type DecisionBriefProjection = z.infer<typeof DecisionBriefProjectionSchema>;

/** A bounded read of one top-level fenced block; the original is never rewritten. */
export function readDecisionBrief(markdown: string): DecisionBriefProjection {
  if (markdown.length > 100_000) return { status: "invalid", reason: "too_large" };
  let fence: { char: string; length: number; brief: boolean } | undefined;
  let count = 0;
  let body: string[] = [];
  let complete = false;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1]?.[0] === fence.char && closing[1].length >= fence.length) {
        if (fence.brief) complete = true;
        fence = undefined;
      } else if (fence.brief) body.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (!opening?.[1]) continue;
    const brief = opening[2]?.trim() === "facility-decision";
    fence = { char: opening[1][0] ?? "`", length: opening[1].length, brief };
    if (brief) {
      count++;
      if (count > 1) return { status: "invalid", reason: "duplicate" };
      body = [];
    }
  }
  if (!count) return { status: "absent" };
  if (!complete) return { status: "invalid", reason: "malformed" };
  const json = body.join("\n");
  if (json.length > 16_000) return { status: "invalid", reason: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion !== 1)
    return { status: "invalid", reason: "unsupported_version" };
  const result = DecisionBriefSchema.safeParse(value);
  return result.success
    ? { status: "available", brief: result.data }
    : { status: "invalid", reason: "invalid_fields" };
}
