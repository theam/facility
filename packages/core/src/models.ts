export type FacilityEngine = "claude_code" | "codex" | "byo";

export const CLAUDE_CODE_MODEL_POLICY_VERSION = "2.1.215";

// Claude Code resolves these CLI aliases before it calls the provider. A
// run-scoped virtual key must therefore allow the concrete wire model(s), not
// the alias passed on Claude's command line. These exact request values were
// captured from the official Linux binary with Facility's custom base URL for
// the pinned version in runner/Dockerfile; its version-lock test forces this
// policy to be reviewed on CLI upgrades.
const CLAUDE_CODE_WIRE_MODELS: Readonly<Record<string, readonly string[]>> = {
  opusplan: ["claude-opus-4-8", "claude-sonnet-5"],
  opus: ["claude-opus-4-8"],
  opus48: ["opus48"],
  sonnet: ["claude-sonnet-5"],
  sonnet46: ["sonnet46"],
  haiku: ["claude-haiku-4-5-20251001"],
  haiku45: ["haiku45"],
  fable: ["claude-fable-5"],
  fable5: ["fable5"],
};

/** Resolve an engine config into the exact provider models its virtual key may use. */
export function allowedModelsForEngine(
  engine: FacilityEngine,
  config: Record<string, unknown>,
): string[] | undefined {
  // BYO commands own their provider/model routing. Their config may contain
  // model metadata, but Facility must not reinterpret it as a gateway policy.
  if (engine === "byo") return undefined;
  const configured = [config.model, config.primary].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!configured) return undefined;
  // Codex's primary value is already the wire model passed to its provider;
  // unlike Claude Code, the pinned CLI has no client-side model aliases here.
  if (engine === "codex") return [configured];
  return [...(CLAUDE_CODE_WIRE_MODELS[configured] ?? [configured])];
}
