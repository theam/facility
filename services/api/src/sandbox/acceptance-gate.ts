import type { RunBundle } from "./state.js";

type AcceptanceRepo = Pick<RunBundle["repo"], "cloneUrl">;
type AcceptanceBundle = { mode: string; repo: AcceptanceRepo } & Pick<RunBundle, "checkCmds">;

export const CHECKS_NOT_CONFIGURED = "checks_not_configured";

export const CHECKS_NOT_CONFIGURED_MESSAGE =
  "This project has no acceptance checks configured — a builder run cannot deliver. " +
  "Configure them in Settings.";

// Delivery-mode agents ship repository changes, so the platform requires
// acceptance evidence. Mirrors the runner's requiresDelivery so the
// dispatch-time refusal and the runner's delivery gate agree.
export function requiresDelivery(mode: string) {
  return mode === "builder" || mode.endsWith("-builder");
}

function normalizedMode(mode: string) {
  return mode.replace(/^codex-/, "").replace(/-/g, "_");
}

function repairRepositoryMode(mode: string) {
  return normalizedMode(mode) === "address_review" || normalizedMode(mode) === "ci_doctor";
}

// GitHub-backed repositories let their own CI accept the signed draft pull
// request, so acceptance is owned there even when no sandbox checks are
// configured. Mirrors the runner's githubCiOwnsAcceptance: refusing these
// would block deliveries that currently succeed.
export function githubCiOwnsAcceptance(bundle: AcceptanceBundle): boolean {
  if (!bundle.repo.cloneUrl?.startsWith("https://github.com/")) return false;
  return requiresDelivery(bundle.mode) || repairRepositoryMode(bundle.mode);
}

// The runner's acceptance gate, evaluated at dispatch time: a delivery-mode
// agent may only run when acceptance is configured or the repository's own CI
// owns acceptance.
export function checksConfiguredForDispatch(bundle: AcceptanceBundle): boolean {
  return (
    githubCiOwnsAcceptance(bundle) || !requiresDelivery(bundle.mode) || bundle.checkCmds.length > 0
  );
}

// Issue-trigger variant: buildRunBundle synthesizes a repo row's clone URL the
// same way, so a trigger-time refusal uses exactly the bundle the runner would
// see — including the GitHub-backed exemption.
export function checksConfiguredForRepo(input: {
  mode: string;
  checkCmds: string[];
  repo: { owner: string; name: string } | null;
}): boolean {
  return checksConfiguredForDispatch({
    mode: input.mode,
    checkCmds: input.checkCmds,
    repo: input.repo
      ? { cloneUrl: `https://github.com/${input.repo.owner}/${input.repo.name}.git` }
      : { cloneUrl: null },
  });
}
