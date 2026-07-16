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
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "../errors.js";
import type { AppConfig, Principal } from "../types.js";
import { raisePlatformIssue } from "../watchtower/issues.js";
import { FacilityGithubClient, type GithubClientFactory, type TreeItem } from "./client.js";
import { readRepoFiles } from "./repo-files.js";

export type KickstartAnswers = RenderAnswers & {
  execution_lane?: Record<string, "repo" | "platform">;
};

export type RepoRow = typeof repos.$inferSelect;

const MANAGED_FACILITY_PATHS = [
  ".facility.json",
  "STANDARD.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/workflows/facility-crew.yml",
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
  await args.db
    .update(repos)
    .set({
      fingerprintStatus: "pending_merge",
      fingerprint: { ...render.manifest, files: render.manifest.files },
      renderAnswers,
      updatedAt: new Date(),
    })
    .where(eq(repos.id, args.repo.id));
  // Persist the resolved acceptance gates into the project's settings too, so the
  // PLATFORM lane runs them (the runner reads projects.settings.check_cmds as its
  // fallback). Without this, only the repo lane's vendored workflows would carry
  // the detected checks and a platform-lane run would have zero gates. Merge with
  // `||` to preserve default_branch and any other settings keys.
  await args.db
    .update(projects)
    .set({
      settings: sql`${projects.settings} || ${JSON.stringify({ check_cmds: renderAnswers.checkCmds ?? [] })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.orgId, args.repo.orgId), eq(projects.id, args.projectId)));
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
    "5. Connect a deployment provider and require its per-PR live preview check.",
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
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  const files = await readRepoFiles(
    client,
    args.repo.defaultBranch,
    expected.files.map((file) => file.path),
  );
  const actual = manifestFor([...files.entries()].map(([path, content]) => ({ path, content })));
  const diff = diffManifest(expected, actual);
  const status =
    diff.missing.length || diff.modified.length || diff.extra.length ? "drifted" : "ok";
  await args.db
    .update(repos)
    .set({ fingerprintStatus: status, fingerprintVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(repos.id, args.repo.id));
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
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  const files = await readRepoFiles(client, args.repo.defaultBranch, paths);
  if (!expected && files.size === 0) {
    throw new ApiError(400, "nothing_to_adopt", "No managed Facility files were found to adopt");
  }
  const manifest = manifestFor([...files.entries()].map(([path, content]) => ({ path, content })));
  await args.db
    .update(repos)
    .set({
      fingerprint: manifest,
      fingerprintStatus: "ok",
      fingerprintVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repos.id, args.repo.id));
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
