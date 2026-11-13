import { z } from "zod";
import { readDecisionBlock } from "./decision-block.js";

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

/** The plan's original text remains the canonical source. */
export function readDecisionBrief(markdown: string): DecisionBriefProjection {
  const result = readDecisionBlock(markdown, "facility-decision", DecisionBriefSchema);
  return result.status === "available" ? { status: "available", brief: result.value } : result;
}
