import { CONSULTATION_LIMITS, normalizeModel, reservationCents } from "@facility/core";

export type ConsultationProvider = "openai" | "anthropic";
type ConsultationCapability =
  | { eligible: false; reason: string; provider: ConsultationProvider | null; estimateCents: null }
  | { eligible: true; reason: null; provider: ConsultationProvider; estimateCents: number };
export function consultationCapability(
  engine: string,
  model: string,
  prompt: string,
  effort?: string | null,
): ConsultationCapability {
  const provider: ConsultationProvider | null =
    engine === "codex" ? "openai" : engine === "claude_code" ? "anthropic" : null;
  const priceKey = normalizeModel(model);
  const undated = model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (
    !provider ||
    !priceKey ||
    priceKey === "custom" ||
    undated !== priceKey ||
    (provider === "openai" ? !priceKey.startsWith("gpt-") : !priceKey.startsWith("claude-"))
  )
    return {
      eligible: false as const,
      reason: "model_api_unsupported",
      provider,
      estimateCents: null,
    };
  if (Buffer.byteLength(prompt) > CONSULTATION_LIMITS.agentPromptBytes)
    return {
      eligible: false as const,
      reason: "agent_prompt_too_large",
      provider,
      estimateCents: null,
    };
  if (
    effort &&
    !(
      provider === "openai"
        ? ["none", "minimal", "low", "medium", "high", "xhigh"]
        : ["low", "medium", "high", "xhigh", "max"]
    ).includes(effort)
  )
    return {
      eligible: false as const,
      reason: "reasoning_api_unsupported",
      provider,
      estimateCents: null,
    };
  // A deliberately conservative byte-based estimate, including provider message framing.
  // This is admission accounting, not a claim about an exact provider invoice.
  const estimateCents = reservationCents(model, "consultation");
  if (estimateCents === null)
    return { eligible: false, reason: "model_pricing_unavailable", provider, estimateCents: null };
  return { eligible: true as const, reason: null, provider, estimateCents };
}

export function sameConsultationModel(requested: string, returned: unknown) {
  if (typeof returned !== "string") return false;
  return (
    returned === requested ||
    returned.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "") === requested
  );
}
