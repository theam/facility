import type { RunBundle } from "./state.js";

type DeliveryBundle = { mode: string; repo: Pick<RunBundle["repo"], "cloneUrl"> };

export const DELIVERY_REPO_NOT_CONFIGURED = "delivery_repo_not_configured";

// Keep delivery-mode detection aligned with the runner so only runs that need a
// branch and pull request are subject to the repository preflight.
export function requiresDelivery(mode: string) {
  return mode === "builder" || mode.endsWith("-builder");
}

// A delivery-mode run without a repository cannot create its branch or pull
// request, so fail it before provisioning any spend-capable resources.
export function deliveryRepoConfigured(bundle: DeliveryBundle) {
  return !requiresDelivery(bundle.mode) || Boolean(bundle.repo.cloneUrl);
}
