export type AiBrand = "claude" | "openai";

export type AiIdentity = {
  brand: AiBrand | null;
  label: string;
};

const ENGINE_IDENTITIES: Record<string, AiIdentity> = {
  claude_code: { brand: "claude", label: "Claude Code" },
  codex: { brand: "openai", label: "Codex" },
};

const MODEL_IDENTITIES: Record<string, AiIdentity> = {
  "claude-fable-5": { brand: "claude", label: "Claude Fable 5" },
  "claude-opus-4-8": { brand: "claude", label: "Claude Opus 4.8" },
  "claude-sonnet-4-6": { brand: "claude", label: "Claude Sonnet 4.6" },
  "claude-sonnet-5": { brand: "claude", label: "Claude Sonnet 5" },
  "claude-haiku-4-5": { brand: "claude", label: "Claude Haiku 4.5" },
  "claude-haiku-4-5-20251001": { brand: "claude", label: "Claude Haiku 4.5" },
  "gpt-5.5": { brand: "openai", label: "GPT-5.5" },
  "gpt-5.5-mini": { brand: "openai", label: "GPT-5.5 Mini" },
  "gpt-5.6-sol": { brand: "openai", label: "GPT-5.6 Sol" },
  "gpt-5.6-terra": { brand: "openai", label: "GPT-5.6 Terra" },
  "gpt-5.6-luna": { brand: "openai", label: "GPT-5.6 Luna" },
};

const PROVIDER_IDENTITIES: Record<string, AiIdentity> = {
  anthropic: { brand: "claude", label: "Anthropic" },
  openai: { brand: "openai", label: "OpenAI" },
};

/** Known platform identifiers get product names; user-defined values remain verbatim. */
export function engineIdentity(value: string): AiIdentity {
  return ENGINE_IDENTITIES[value] ?? { brand: null, label: value };
}

/** Known catalog identifiers get product names; user-defined values remain verbatim. */
export function modelIdentity(value: string): AiIdentity {
  return MODEL_IDENTITIES[value] ?? { brand: null, label: value };
}

/** Model name when its surrounding engine identity already communicates the Claude brand. */
export function modelProductLabel(value: string): string {
  return modelIdentity(value).label.replace(/^Claude /, "");
}

/** Known provider slugs get product names; custom provider names remain verbatim. */
export function providerIdentity(value: string): AiIdentity {
  return PROVIDER_IDENTITIES[value] ?? { brand: null, label: value };
}
