import {
  detectFromFiles,
  diffManifest,
  manifestFor,
  newId,
  type RenderAnswers,
  renderFacilityInit,
  sha256Hex,
} from "@facility/core";
import {
  actionTypes,
  type FacilityDb,
  githubInstallations,
  insertAuditEvent,
  projects,
  proposals,
  repos,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { lockBuilderPlanPolicy } from "../builder-plan-policy.js";
import { ApiError } from "../errors.js";
import type { AppConfig, Principal } from "../types.js";
import { raisePlatformIssue } from "../watchtower/issues.js";
import { FacilityGithubClient, type GithubClientFactory, type TreeItem } from "./client.js";
import { decodeContent, readRepoFiles } from "./repo-files.js";

export type KickstartAnswers = RenderAnswers;

export type RepoRow = typeof repos.$inferSelect;

export type FacilityRepoManifest = {
  packageInstall?: string | null;
  provision?: string | null;
  checks?: string[];
  models?: {
    build?: string;
    review?: string;
    plan?: string;
    codexBuild?: string;
    codexPlan?: string;
  };
  executionLane?: Record<string, "repo" | "platform">;
};

const MANAGED_FACILITY_PATHS = [
  ".facility.json",
  "STANDARD.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/workflows/facility-crew.yml",
  ".github/workflows/facility-codex.yml",
  ".github/workflows/facility-review.yml",
  ".github/workflows/facility-address-review.yml",
  ".github/workflows/facility-doctor.yml",
  ".github/workflows/facility-security-sweep.yml",
  ".github/workflows/facility-watchtower.yml",
  ".github/workflows/facility-canary.yml",
  ".github/facility/architect.md",
  ".github/facility/builder.md",
  ".github/facility/doctor.md",
  ".github/facility/sweep.md",
  ".github/facility/doctor/resolve.mjs",
  ".github/facility/delivery/verify.mjs",
  ".github/facility/receipts/collect.mjs",
  ".github/facility/review/finalize.mjs",
  ".github/facility/security/sync-findings.mjs",
  ".github/facility/watchtower/outcomes.mjs",
  ".github/facility/watchtower/health.mjs",
  ".github/facility/watchtower/canary.mjs",
  ".github/facility/watchtower/budgets.json",
  ".github/facility/move-board-status.sh",
  ".claude/settings.json",
  ".claude/hooks/protect-branch.mjs",
  ".claude/hooks/protect-files.mjs",
  ".claude/agents/standards-reviewer.md",
  ".claude/agents/security-reviewer.md",
  ".claude/skills/working-to-standard/SKILL.md",
  ".claude/skills/reviewing-to-standard/SKILL.md",
  ".claude/skills/maintainable-software/SKILL.md",
  ".claude/commands/verify.md",
  ".claude/commands/open-pr.md",
  "guards/run.mjs",
  "guards/_kit.mjs",
  "guards/actions-pinned.mjs",
  "guards/watchtower-locked.mjs",
  "guards/README.md",
];

export async function createGithubClientForRepo(
  db: FacilityDb,
  factory: GithubClientFactory,
  repo: RepoRow,
): Promise<FacilityGithubClient> {
  if (!repo.installationId) throw new Error("Repository has no GitHub installation");
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, repo.installationId))
      .limit(1)
  )[0];
  if (!installation) throw new Error("GitHub installation not found");
  return new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
}

export function parseFacilityRepoManifest(content: string): FacilityRepoManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiError(400, "facility_manifest_invalid", ".facility.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "facility_manifest_invalid", ".facility.json must be an object");
  }
  const value = parsed as Record<string, unknown>;
  const optionalCommand = (key: string) => {
    const command = value[key];
    if (command === undefined || command === null) return command;
    if (typeof command !== "string" || !command.trim()) {
      throw new ApiError(
        400,
        "facility_manifest_invalid",
        `${key} must be a command string or null`,
      );
    }
    return command;
  };
  let checks: string[] | undefined;
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || !value.checks.every((item) => typeof item === "string")) {
      throw new ApiError(400, "facility_manifest_invalid", "checks must be an array of commands");
    }
    checks = value.checks as string[];
  }
  let executionLane: Record<string, "repo" | "platform"> | undefined;
  if (value.executionLane !== undefined) {
    if (
      !value.executionLane ||
      typeof value.executionLane !== "object" ||
      Array.isArray(value.executionLane) ||
      !Object.values(value.executionLane).every((lane) => lane === "repo" || lane === "platform")
    ) {
      throw new ApiError(
        400,
        "facility_manifest_invalid",
        "executionLane values must be repo or platform",
      );
    }
    executionLane = value.executionLane as Record<string, "repo" | "platform">;
  }
  const modelValue = value.models;
  const models =
    modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
      ? Object.fromEntries(
          Object.entries(modelValue).filter(
            ([key, model]) =>
              ["build", "review", "plan", "codexBuild", "codexPlan"].includes(key) &&
              typeof model === "string" &&
              model.trim(),
          ),
        )
      : undefined;
  return {
    packageInstall: optionalCommand("packageInstall"),
    provision: optionalCommand("provision"),
    checks,
    models,
    executionLane,
  };
}

export async function syncRepoFacilityConfig(args: {
  db: FacilityDb;
  factory?: GithubClientFactory;
  client?: FacilityGithubClient;
  repo: RepoRow;
}) {
  const client =
    args.client ??
    (args.factory ? await createGithubClientForRepo(args.db, args.factory, args.repo) : undefined);
  if (!client) throw new Error("syncRepoFacilityConfig requires a GitHub client or factory");
  const content = await readFacilityManifest(client, args.repo.defaultBranch);
  let manifest: FacilityRepoManifest | null = null;
  let manifestError: unknown;
  if (content) {
    try {
      manifest = parseFacilityRepoManifest(content);
    } catch (error) {
      manifestError = error;
    }
  }
  const outcome = await args.db.transaction(async (transaction) => {
    const tx = transaction as unknown as FacilityDb;
    await lockBuilderPlanPolicy(tx, args.repo.orgId, args.repo.projectId);
    const project = (
      await tx
        .select({ builderPlanPolicy: projects.builderPlanPolicy })
        .from(projects)
        .where(and(eq(projects.orgId, args.repo.orgId), eq(projects.id, args.repo.projectId)))
        .limit(1)
    )[0];
    const liveRepo = (
      await tx
        .select()
        .from(repos)
        .where(and(eq(repos.orgId, args.repo.orgId), eq(repos.id, args.repo.id)))
        .limit(1)
    )[0];
    if (!liveRepo) throw new ApiError(404, "repo_not_found", "Repository not found");
    const requiredBuilderPlan = project?.builderPlanPolicy === "required";
    const current =
      liveRepo.renderAnswers &&
      typeof liveRepo.renderAnswers === "object" &&
      !Array.isArray(liveRepo.renderAnswers)
        ? (liveRepo.renderAnswers as Record<string, unknown>)
        : {};
    if (!content) {
      if (requiredBuilderPlan) {
        await markRequiredBuilderLaneDrift(tx, liveRepo);
        return { error: requiredBuilderLaneError(liveRepo, "facility_manifest_missing") };
      }
      const renderAnswers = clearManifestOverrides(current);
      await tx
        .update(repos)
        .set({ renderAnswers, updatedAt: new Date() })
        .where(and(eq(repos.orgId, liveRepo.orgId), eq(repos.id, liveRepo.id)));
      return { renderAnswers };
    }
    if (manifestError || !manifest) {
      if (requiredBuilderPlan) {
        await markRequiredBuilderLaneDrift(tx, liveRepo);
        return { error: requiredBuilderLaneError(liveRepo, "facility_manifest_invalid") };
      }
      return { error: manifestError ?? new Error("facility_manifest_invalid") };
    }
    const builderLane = manifest.executionLane?.builder ?? manifest.executionLane?.["/builder"];
    const codexBuilderLane =
      manifest.executionLane?.["codex-builder"] ?? manifest.executionLane?.["/codex-builder"];
    if (requiredBuilderPlan && (builderLane !== "platform" || codexBuilderLane !== "platform")) {
      await markRequiredBuilderLaneDrift(tx, liveRepo);
      return { error: requiredBuilderLaneError(liveRepo, "builder_platform_lane_missing") };
    }
    const renderAnswers = {
      ...current,
      packageInstallCmd: manifest.packageInstall ?? null,
      provisionCmd: manifest.provision ?? null,
      checkCmds: manifest.checks ?? [],
      models: manifest.models ?? {},
      execution_lane: manifest.executionLane ?? {},
    };
    await tx
      .update(repos)
      .set({ renderAnswers, updatedAt: new Date() })
      .where(and(eq(repos.orgId, liveRepo.orgId), eq(repos.id, liveRepo.id)));
    return { renderAnswers };
  });
  if (outcome.error) throw outcome.error;
  return outcome.renderAnswers;
}

async function markRequiredBuilderLaneDrift(db: FacilityDb, repo: RepoRow) {
  await db
    .update(repos)
    .set({ fingerprintStatus: "drifted", fingerprintVerifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(repos.orgId, repo.orgId), eq(repos.id, repo.id)));
}

async function markRepoFingerprintPending(db: FacilityDb, repo: RepoRow) {
  await updateRepoFingerprintUnderPolicyLock(db, repo, {
    fingerprintStatus: "pending",
    fingerprintVerifiedAt: null,
  });
}

async function updateRepoFingerprintUnderPolicyLock(
  db: FacilityDb,
  repo: RepoRow,
  values: Pick<
    Partial<typeof repos.$inferInsert>,
    "fingerprint" | "fingerprintStatus" | "fingerprintVerifiedAt" | "renderAnswers"
  >,
) {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as FacilityDb;
    await lockBuilderPlanPolicy(tx, repo.orgId, repo.projectId);
    await tx
      .update(repos)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(repos.orgId, repo.orgId), eq(repos.id, repo.id)));
  });
}

function requiredBuilderLaneError(repo: RepoRow, reason: string) {
  return new ApiError(
    409,
    "builder_plan_platform_lane_required",
    "A required Builder plan project cannot accept default-branch configuration without platform lanes for /builder and /codex-builder",
    { repo: `${repo.owner}/${repo.name}`, reason },
  );
}

function clearManifestOverrides(current: Record<string, unknown>) {
  return {
    ...current,
    packageInstallCmd: null,
    provisionCmd: null,
    checkCmds: [],
    models: {},
    execution_lane: {},
  };
}

async function readFacilityManifest(client: FacilityGithubClient, ref: string) {
  try {
    const value = (await client.getContent(".facility.json", ref)) as {
      type?: string;
      content?: string;
      encoding?: string;
    };
    if (Array.isArray(value) || value.type !== "file" || typeof value.content !== "string") {
      return null;
    }
    return decodeContent(value.content, value.encoding);
  } catch (error) {
    // Absence is a valid, fail-closed repo-lane configuration. Permission and
    // network failures are not absence and must remain retryable/loud.
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function kickstartPreview(
  db: FacilityDb,
  factory: GithubClientFactory,
  repo: RepoRow,
  answers: KickstartAnswers,
) {
  const client = await createGithubClientForRepo(db, factory, repo);
  const existing = await readRepoFiles(client, repo.defaultBranch);
  const detection = detectFromFiles({
    files: existing,
    defaultBranch: answers.defaultBranch ?? repo.defaultBranch,
    org: repo.owner,
  });
  const render = await renderFacilityInit(
    {
      ...answers,
      defaultBranch: answers.defaultBranch ?? detection.defaultBranch,
      checkCmds: answers.checkCmds ?? detection.checks,
      provisionCmd: answers.provisionCmd ?? detection.provision,
      modules: answers.modules ?? detection.suggestedModules,
      packageManager: answers.packageManager ?? detection.packageManager,
      workflowNames: answers.workflowNames ?? detection.workflowNames,
    },
    { existingFiles: existing },
  );
  return {
    detection,
    files: render.files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.content),
      sha256: sha256Hex(file.content),
      mode: file.mode,
      action: existing.has(file.path) ? "update" : "create",
    })),
    skipped: render.skipped,
  };
}

export async function kickstartRepo(args: {
  db: FacilityDb;
  factory: GithubClientFactory;
  config: AppConfig;
  principal: Principal;
  projectId: string;
  repo: RepoRow;
  answers: KickstartAnswers;
}) {
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  const existing = await readRepoFiles(client, args.repo.defaultBranch);
  const detection = detectFromFiles({
    files: existing,
    defaultBranch: args.answers.defaultBranch ?? args.repo.defaultBranch,
    org: args.repo.owner,
  });
  const renderAnswers: KickstartAnswers = {
    ...args.answers,
    defaultBranch: args.answers.defaultBranch ?? detection.defaultBranch,
    checkCmds: args.answers.checkCmds ?? detection.checks,
    provisionCmd: args.answers.provisionCmd ?? detection.provision,
    modules: args.answers.modules ?? detection.suggestedModules,
    packageManager: args.answers.packageManager ?? detection.packageManager,
    workflowNames: args.answers.workflowNames ?? detection.workflowNames,
    execution_lane: args.answers.execution_lane ?? { architect: "repo", builder: "repo" },
  };
  await args.db.transaction(async (transaction) => {
    const tx = transaction as unknown as FacilityDb;
    await lockBuilderPlanPolicy(tx, args.repo.orgId, args.repo.projectId);
    const project = (
      await tx
        .select({ builderPlanPolicy: projects.builderPlanPolicy })
        .from(projects)
        .where(and(eq(projects.orgId, args.repo.orgId), eq(projects.id, args.repo.projectId)))
        .limit(1)
    )[0];
    const lanes = renderAnswers.execution_lane ?? {};
    const builderLane = lanes.builder ?? lanes["/builder"];
    const codexBuilderLane = lanes["codex-builder"] ?? lanes["/codex-builder"];
    if (
      project?.builderPlanPolicy === "required" &&
      (builderLane !== "platform" || codexBuilderLane !== "platform")
    ) {
      throw requiredBuilderLaneError(args.repo, "kickstart_builder_platform_lane_missing");
    }
    // Reserve the repo as unverified before any remote side effect. A
    // concurrent required-policy activation sees pending_merge and fails,
    // while a pre-existing required project has already validated the lanes.
    await tx
      .update(repos)
      .set({
        fingerprintStatus: "pending_merge",
        fingerprintVerifiedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(repos.orgId, args.repo.orgId), eq(repos.id, args.repo.id)));
  });
  const render = await renderFacilityInit(renderAnswers, { existingFiles: existing });
  const branch = "facility/kickstart";
  const baseSha = await client.getDefaultBranchSha();
  const baseCommit = await client.getCommit(baseSha);
  const tree = await renderTree(client, render.files);
  const treeSha = await client.createTree(baseCommit.treeSha, tree);
  const commitSha = await client.createCommit("facility: kickstart", treeSha, [baseSha]);
  await client.createBranch(branch, commitSha);
  const pr = await client.createPullRequest({
    title: "Install Facility",
    head: branch,
    body: kickstartPrBody(render.files.map((file) => file.path)),
  });
  await updateRepoFingerprintUnderPolicyLock(args.db, args.repo, {
    fingerprintStatus: "pending_merge",
    fingerprint: { ...render.manifest, files: render.manifest.files },
    renderAnswers,
  });
  await createKickstartProposal(
    args.db,
    args.repo.orgId,
    args.projectId,
    pr.url,
    render.files.map((file) => file.path),
  );
  await auditGithub(args.db, args.repo.orgId, "github.pr.created", args.repo, {
    number: pr.number,
    url: pr.url,
    branch,
  });
  return { branch, commitSha, pr, files: render.files, manifest: render.manifest };
}

async function renderTree(
  client: FacilityGithubClient,
  files: { path: string; content: string; mode?: string; executable?: boolean }[],
): Promise<TreeItem[]> {
  const tree: TreeItem[] = [];
  for (const file of files) {
    const mode = (file.mode ?? (file.executable ? "100755" : "100644")) as TreeItem["mode"];
    if (mode === "120000") {
      tree.push({ path: file.path, mode, type: "blob", content: file.content });
    } else {
      tree.push({
        path: file.path,
        mode,
        type: "blob",
        sha: await client.createBlob(file.content),
      });
    }
  }
  return tree;
}

function kickstartPrBody(paths: string[]): string {
  return [
    "Installs the Facility workflow set generated from the bundled template set.",
    "",
    "Manual steps after merge:",
    "1. Create the agent token with `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`.",
    "2. Install the Claude GitHub App on the repo so crew pushes re-trigger CI.",
    "3. Protect the default branch with PR review.",
    "4. Put TEST-tier provider keys in the `facility-crew` Environment when needed.",
    "5. If previews are configured, set FACILITY_API_URL, FACILITY_PROJECT_ID, and FACILITY_PREVIEW_KEY so delivered PRs receive an SSO-protected Facility preview.",
    "",
    "Rendered files:",
    ...paths.map((path) => `- \`${path}\``),
  ].join("\n");
}

async function createKickstartProposal(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  prUrl: string,
  paths: string[],
) {
  const action = (
    await db
      .select()
      .from(actionTypes)
      .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, "kickstart_review")))
      .limit(1)
  )[0];
  if (!action) return;
  await db.insert(proposals).values({
    id: newId("prop"),
    orgId,
    projectId,
    actionTypeId: action.id,
    payload: { prUrl, paths },
    contextMd: [`Kickstart PR: ${prUrl}`, "", ...paths.map((path) => `- \`${path}\``)].join("\n"),
    expiresAt: new Date(Date.now() + action.defaultTtlHours * 60 * 60 * 1000),
  });
}

export async function verifyFingerprints(args: {
  db: FacilityDb;
  factory: GithubClientFactory;
  repo: RepoRow;
}) {
  const expected = args.repo.fingerprint as ReturnType<typeof manifestFor> | null;
  if (!expected) return { status: "unknown" as const };
  await markRepoFingerprintPending(args.db, args.repo);
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  await syncRepoFacilityConfig({ db: args.db, client, repo: args.repo });
  const files = await readRepoFiles(
    client,
    args.repo.defaultBranch,
    expected.files.map((file) => file.path),
  );
  const actual = manifestFor([...files.entries()].map(([path, content]) => ({ path, content })));
  const diff = diffManifest(expected, actual);
  const status =
    diff.missing.length || diff.modified.length || diff.extra.length ? "drifted" : "ok";
  await updateRepoFingerprintUnderPolicyLock(args.db, args.repo, {
    fingerprintStatus: status,
    fingerprintVerifiedAt: new Date(),
  });
  if (status !== "ok") {
    await upsertPlatformIssue(args.db, args.repo, status, diff);
  }
  return { status, diff };
}

export async function adoptFingerprints(args: {
  db: FacilityDb;
  factory: GithubClientFactory;
  repo: RepoRow;
  principal: Principal;
}) {
  const expected = args.repo.fingerprint as ReturnType<typeof manifestFor> | null;
  const paths = expected?.files.map((file) => file.path) ?? MANAGED_FACILITY_PATHS;
  await markRepoFingerprintPending(args.db, args.repo);
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  await syncRepoFacilityConfig({ db: args.db, client, repo: args.repo });
  const files = await readRepoFiles(client, args.repo.defaultBranch, paths);
  if (!expected && files.size === 0) {
    throw new ApiError(400, "nothing_to_adopt", "No managed Facility files were found to adopt");
  }
  const manifest = manifestFor([...files.entries()].map(([path, content]) => ({ path, content })));
  await updateRepoFingerprintUnderPolicyLock(args.db, args.repo, {
    fingerprint: manifest,
    fingerprintStatus: "ok",
    fingerprintVerifiedAt: new Date(),
  });
  await insertAuditEvent(args.db, {
    orgId: args.repo.orgId,
    projectId: args.repo.projectId,
    actor: { type: args.principal.type, id: args.principal.id },
    action: "fingerprints.adopted",
    target: { type: "repo", id: args.repo.id },
    payload: { paths },
  });
  return manifest;
}

export async function upgradeRepo(args: {
  db: FacilityDb;
  factory: GithubClientFactory;
  repo: RepoRow;
  toVersion?: string;
}) {
  const answers = args.repo.renderAnswers as KickstartAnswers | null;
  if (!answers) throw new Error("Repository has no stored render answers");
  const current = await renderFacilityInit(answers, {});
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  const repoFiles = await readRepoFiles(
    client,
    args.repo.defaultBranch,
    current.files.map((file) => file.path),
  );
  const branch = `facility/upgrade-${args.toVersion ?? current.manifest.templateSet}`;
  const baseSha = await client.getDefaultBranchSha();
  const baseCommit = await client.getCommit(baseSha);
  const treeFiles = current.files.flatMap((file) => {
    const ours = repoFiles.get(file.path);
    if (ours === undefined || ours === file.content) return [file];
    return [
      {
        ...file,
        path: `.facility/upgrade-conflicts/${file.path}`,
        content: ["<<<<<<< current", ours, "=======", file.content, ">>>>>>> facility", ""].join(
          "\n",
        ),
      },
    ];
  });
  const treeSha = await client.createTree(baseCommit.treeSha, await renderTree(client, treeFiles));
  const commitSha = await client.createCommit("facility: upgrade templates", treeSha, [baseSha]);
  await client.createBranch(branch, commitSha);
  const pr = await client.createPullRequest({
    title: "Upgrade Facility templates",
    head: branch,
    body: "Upgrades Facility managed files. Conflicts, if any, are copied under `.facility/upgrade-conflicts/` and live files are left untouched.",
  });
  await auditGithub(args.db, args.repo.orgId, "github.pr.created", args.repo, {
    number: pr.number,
    url: pr.url,
    branch,
  });
  return { branch, commitSha, pr };
}

async function upsertPlatformIssue(
  db: FacilityDb,
  repo: RepoRow,
  kind: string,
  diff: { missing: string[]; modified: string[]; extra: string[] },
) {
  const fingerprint = sha256Hex(JSON.stringify({ repo: repo.id, kind, diff }));
  // Route through the shared atomic upsert so recurring drift reopens a resolved
  // issue (and dedupes race-safely) instead of only bumping lastSeen/count.
  await raisePlatformIssue(db, {
    orgId: repo.orgId,
    projectId: repo.projectId,
    kind: "fingerprint_drift",
    severity: kind === "corrupted" ? "error" : "warn",
    fingerprint,
    title: `Facility managed files drifted in ${repo.owner}/${repo.name}`,
    bodyMd: JSON.stringify(diff, null, 2),
  });
}

async function auditGithub(
  db: FacilityDb,
  orgId: string,
  action: string,
  repo: RepoRow,
  payload: Record<string, unknown>,
) {
  await insertAuditEvent(db, {
    orgId,
    projectId: repo.projectId,
    actor: { type: "system", name: "github-app" },
    action,
    target: { type: "repo", id: repo.id },
    payload: { repo: `${repo.owner}/${repo.name}`, ...payload },
  });
}
