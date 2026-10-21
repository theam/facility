import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../errors.js";

export const PLAN_CONFIRMATION_TTL_MS = 15 * 60_000;
export type PlanProofBinding = {
  orgId: string;
  projectId: string;
  storyId: string;
  requestId: string;
  planRevision: number;
  planDigest: string;
  decisionRevision: number;
  intent: "approve" | "reject";
  reason: string | null;
  expiresAt: Date;
};
export type InteractivePlanActor = {
  id: string;
  name: string | null;
  sessionCookie: string;
};

/** The normal auth hook has already verified this cookie and active membership. */
export function interactivePlanActor(request: {
  principal?: { type: "user" | "key"; id: string; userId?: string; name?: string };
  headers: { authorization?: string };
  cookies: Record<string, string | undefined>;
}): InteractivePlanActor {
  const actor = request.principal;
  const sessionCookie = request.cookies.facility_session;
  if (request.headers.authorization !== undefined || actor?.type !== "user" || !sessionCookie)
    throw new ApiError(
      403,
      "interactive_confirmation_required",
      "Open the confirmation link in Facility and review this exact plan with your browser session",
    );
  return { id: actor.userId ?? actor.id, name: actor.name?.slice(0, 120) ?? null, sessionCookie };
}

export function planConfirmationProof(
  binding: PlanProofBinding,
  actor: InteractivePlanActor,
  masterKey: string,
) {
  const sessionFingerprint = createHash("sha256").update(actor.sessionCookie).digest("hex");
  const fields = [
    "facility:plan-confirmation:v1",
    binding.orgId,
    binding.projectId,
    binding.storyId,
    binding.requestId,
    binding.planRevision,
    binding.planDigest,
    binding.decisionRevision,
    binding.intent,
    binding.reason,
    binding.expiresAt.toISOString(),
    actor.id,
    sessionFingerprint,
  ];
  return createHmac("sha256", Buffer.from(masterKey, "base64"))
    .update(JSON.stringify(fields))
    .digest("base64url");
}

export function verifyPlanConfirmationProof(
  proof: string,
  binding: PlanProofBinding,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  if (now.getTime() >= binding.expiresAt.getTime())
    throw new ApiError(
      409,
      "plan_confirmation_expired",
      "This confirmation expired. Request a new review of the current plan",
    );
  const expected = Buffer.from(planConfirmationProof(binding, actor, masterKey));
  const actual = Buffer.from(proof);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new ApiError(
      400,
      "plan_confirmation_invalid",
      "This confirmation does not match your session or the reviewed plan. Reload the review page",
    );
}
