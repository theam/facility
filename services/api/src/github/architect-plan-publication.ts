export function architectPlanPublicationKey(runId: string, proposalId: string) {
  return `architect-plan:${runId}:${proposalId}`;
}

export function architectPlanPublicationMarker(runId: string, proposalId: string) {
  return `<!-- facility:${architectPlanPublicationKey(runId, proposalId)} -->`;
}

export function legacyRunProgressMarker(runId: string) {
  return `<!-- facility-run-progress run=${runId} -->`;
}

export function isGithubNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return (
    candidate.status === 404 || candidate.statusCode === 404 || candidate.response?.status === 404
  );
}

export function findArchitectPlanPublicationComment<T extends { authorType: string; body: string }>(
  comments: T[],
  input: { runId: string; publicationMarker: string; allowLegacy: boolean },
) {
  const bots = comments.filter((comment) => comment.authorType.toLowerCase() === "bot");
  return (
    bots.find((comment) => comment.body.includes(input.publicationMarker)) ??
    (input.allowLegacy
      ? bots.find((comment) => comment.body.includes(legacyRunProgressMarker(input.runId)))
      : undefined)
  );
}

export function rotateArchitectPlanPublicationOrgIds(orgIds: string[], now: Date, limit: number) {
  if (limit <= 0 || orgIds.length === 0) return [];
  if (orgIds.length <= limit) return [...orgIds];
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const offset = (minuteBucket * limit) % orgIds.length;
  return Array.from(
    { length: limit },
    (_, index) => orgIds[(offset + index) % orgIds.length] ?? "",
  );
}

export function effectiveArchitectPlanProposalState(
  state: string,
  expiresAt: Date,
  now = new Date(),
) {
  const open = state === "open" && expiresAt.getTime() > now.getTime();
  return { open, state: state === "open" && !open ? "expired" : state };
}

export function renderClosedArchitectPlanPublication(input: {
  runId: string;
  plan: string;
  proposalState: string;
  publicationMarker: string;
  updatedAt?: Date;
}) {
  return [
    `<!-- facility-run-progress run=${input.runId} -->`,
    input.publicationMarker,
    "### ✅ Facility Architect plan",
    "",
    `**Human Gate 1:** no longer open (\`${input.proposalState}\`)`,
    `**Run:** \`${input.runId}\``,
    "",
    "This is the plan snapshot produced by the completed Architect run. Facility will not accept a new Builder approval from this closed proposal.",
    "",
    "## Plan snapshot",
    "",
    input.plan.slice(0, 48_000),
    "",
    `_Last updated: ${(input.updatedAt ?? new Date()).toISOString()}_`,
  ].join("\n");
}
