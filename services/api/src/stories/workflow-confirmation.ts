import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../errors.js";
import type { InteractivePlanActor } from "./plan-confirmation.js";

export const WORKFLOW_CONFIRMATION_TTL_MS = 15 * 60_000;
export type WorkflowProofBinding = {
  purpose: "workflow_policy" | "delivery_acceptance";
  orgId: string;
  projectId: string;
  storyId?: string;
  nonce: string;
  digest: string;
  expiresAt: Date;
};

/** Every actionable value is represented by a canonical server-derived digest. */
export function workflowConfirmationProof(
  binding: WorkflowProofBinding,
  actor: InteractivePlanActor,
  masterKey: string,
) {
  return createHmac("sha256", Buffer.from(masterKey, "base64"))
    .update(
      JSON.stringify([
        "facility:workflow-confirmation:v1",
        binding.purpose,
        binding.orgId,
        binding.projectId,
        binding.storyId ?? null,
        binding.nonce,
        binding.digest,
        binding.expiresAt.toISOString(),
        actor.id,
        createHash("sha256").update(actor.sessionCookie).digest("hex"),
      ]),
    )
    .digest("base64url");
}

export function verifyWorkflowConfirmationProof(
  proof: string,
  binding: WorkflowProofBinding,
  actor: InteractivePlanActor,
  masterKey: string,
  now = new Date(),
) {
  const remaining = binding.expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > WORKFLOW_CONFIRMATION_TTL_MS)
    throw new ApiError(
      409,
      "workflow_confirmation_expired",
      "Request a fresh confirmation of the current workflow state",
    );
  const expected = Buffer.from(workflowConfirmationProof(binding, actor, masterKey));
  const actual = Buffer.from(proof);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new ApiError(
      400,
      "workflow_confirmation_invalid",
      "This confirmation does not match your session or the reviewed action",
    );
}
