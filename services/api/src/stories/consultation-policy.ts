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
  const capability = consultationModelCapability(engine, model, effort);
  if (!capability.eligible) return capability;
  if (Buffer.byteLength(prompt) > CONSULTATION_LIMITS.agentPromptBytes)
    return {
      eligible: false,
      reason: "agent_prompt_too_large",
      provider: capability.provider,
      estimateCents: null,
    };
  return capability;
}

/** Model/effort compatibility is independent of the prepared context's byte limit. */
export function consultationModelCapability(
  engine: string,
  model: string,
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
  if (effort && !consultationEfforts[priceKey]?.includes(effort))
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

// Reviewed API capabilities, separate from CLI/catalog acceptance and price availability.
// https://platform.claude.com/docs/en/build-with-claude/effort
const anthropicEfforts = ["low", "medium", "high", "xhigh", "max"];
// https://developers.openai.com/api/docs/models/gpt-5.5
const openaiEfforts = ["none", "low", "medium", "high", "xhigh"];
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
const openai56Efforts = [...openaiEfforts, "max"];
const consultationEfforts: Record<string, readonly string[]> = {
  "claude-fable-5-1": anthropicEfforts,
  "claude-opus-5-5": anthropicEfforts,
  "claude-sonnet-5-5": anthropicEfforts,
  "claude-opus-5": anthropicEfforts,
  "claude-fable-5": anthropicEfforts,
  "claude-opus-4-8": anthropicEfforts,
  "claude-sonnet-5": anthropicEfforts,
  "claude-haiku-4-5": [],
  "gpt-5.5": openaiEfforts,
  "gpt-5.5-mini": openaiEfforts,
  "gpt-5.6-sol": openai56Efforts,
  "gpt-5.6-terra": openai56Efforts,
  "gpt-5.6-luna": openai56Efforts,
};
