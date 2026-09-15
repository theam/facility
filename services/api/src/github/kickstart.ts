import { renderWorkspaceKickstart, sha256Hex } from "@facility/core";
import { type FacilityDb, githubInstallations } from "@facility/db";
import { eq } from "drizzle-orm";
import type { AppConfig, Principal } from "../types.js";
import { FacilityGithubClient, type GithubClientFactory, type TreeItem } from "./client.js";
import { readRepoFiles } from "./repo-files.js";

export type KickstartAnswers = {
  defaultBranch?: string;
  provisionCmd?: string;
  startCmd?: string;
  readyCmd?: string;
  servicePort?: number;
  models?: {
    build?: string;
    review?: string;
    plan?: string;
    codexBuild?: string;
    codexPlan?: string;
  };
};

export type GithubRepositoryRow = {
  id: string;
  orgId: string;
  projectId: string;
  installationId: string | null;
  owner: string;
  name: string;
  defaultBranch: string;
};

export async function createGithubClientForRepo(
  db: FacilityDb,
  factory: GithubClientFactory,
  repository: GithubRepositoryRow,
): Promise<FacilityGithubClient> {
  if (!repository.installationId) throw new Error("Repository has no GitHub installation");
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, repository.installationId))
      .limit(1)
  )[0];
  if (!installation || installation.orgId !== repository.orgId || installation.suspendedAt) {
    throw new Error("GitHub installation is unavailable");
  }
  return new FacilityGithubClient(await factory(installation.installationId), {
    owner: repository.owner,
    repo: repository.name,
    defaultBranch: repository.defaultBranch,
  });
}

export async function kickstartPreview(
  db: FacilityDb,
  factory: GithubClientFactory,
  repository: GithubRepositoryRow,
  answers: KickstartAnswers,
) {
  const client = await createGithubClientForRepo(db, factory, repository);
  const existing = await readRepoFiles(client, repository.defaultBranch);
  const detection = detectWorkspace(existing, answers.defaultBranch ?? repository.defaultBranch);
  const workspaceAnswers = workspaceKickstartAnswers(
    repository,
    answers,
    existing,
    detection.packageManager,
  );
  const rendered = renderWorkspaceKickstart(workspaceAnswers, existing);
  return {
    detection: {
      ...detection,
      setup: workspaceAnswers.setup,
      start: workspaceAnswers.start,
      ready: workspaceAnswers.ready,
      servicePort: workspaceAnswers.servicePort,
    },
    files: rendered.files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.content),
      sha256: sha256Hex(file.content),
      mode: file.mode,
      action: "create" as const,
    })),
    skipped: rendered.skipped,
  };
}

export async function kickstartRepo(args: {
  db: FacilityDb;
  factory: GithubClientFactory;
  config: AppConfig;
  principal: Principal;
  projectId: string;
  repo: GithubRepositoryRow;
  answers: KickstartAnswers;
}) {
  const client = await createGithubClientForRepo(args.db, args.factory, args.repo);
  const existing = await readRepoFiles(client, args.repo.defaultBranch);
  const detection = detectWorkspace(
    existing,
    args.answers.defaultBranch ?? args.repo.defaultBranch,
  );
  const rendered = renderWorkspaceKickstart(
    workspaceKickstartAnswers(args.repo, args.answers, existing, detection.packageManager),
    existing,
  );
  if (rendered.files.length === 0) {
    throw new Error("Repository already contains the Facility 0.12 kickstart files");
  }

  const branch = "facility/kickstart-0.12";
  const baseSha = await client.getDefaultBranchSha();
  const baseCommit = await client.getCommit(baseSha);
  const treeSha = await client.createTree(
    baseCommit.treeSha,
    await renderTree(client, rendered.files),
  );
  const commitSha = await client.createCommit(
    "feat!: configure Facility 0.12 story workspaces",
    treeSha,
    [baseSha],
  );
  try {
    await client.createBranch(branch, commitSha);
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    await client.updateBranch(branch, commitSha);
  }
  const existingPullRequest = (
    await client.listOpenPullRequestsForHead(branch, args.repo.defaultBranch)
  )[0];
  const pr =
    existingPullRequest ??
    (await client.createPullRequest({
      title: "feat!: configure Facility 0.12 story workspaces",
      head: branch,
      body: kickstartPrBody(rendered.files.map((file) => file.path)),
    }));
  return {
    branch,
    commitSha,
    pr: { number: pr.number, url: pr.url },
    files: rendered.files,
    manifest: rendered.manifest,
  };
}

function workspaceKickstartAnswers(
  repository: GithubRepositoryRow,
  answers: KickstartAnswers,
  existing: Map<string, string>,
  detectedPackageManager: string,
) {
  return {
    repository: `${repository.owner}/${repository.name}`,
    setup: answers.provisionCmd?.trim() || undefined,
    start: answers.startCmd?.trim() || inferStartCommand(existing, detectedPackageManager),
    ready: answers.readyCmd?.trim() || undefined,
    servicePort: answers.servicePort ?? 3000,
    models: answers.models,
  };
}

function inferStartCommand(existing: Map<string, string>, packageManager: string) {
  if (
    ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"].some((path) =>
      existing.has(path),
    )
  ) {
    return "docker compose up -d";
  }
  const source = existing.get("package.json");
  if (source) {
    try {
      const scripts = (JSON.parse(source) as { scripts?: Record<string, string> }).scripts ?? {};
      const script = scripts.dev ? "dev" : scripts.start ? "start" : undefined;
      if (script) {
        const manager =
          packageManager !== "none"
            ? packageManager
            : existing.has("pnpm-lock.yaml")
              ? "pnpm"
              : existing.has("yarn.lock")
                ? "yarn"
                : "npm";
        return manager === "npm" ? `npm run ${script}` : `${manager} ${script}`;
      }
    } catch {
      // The explicit failing command below keeps an incomplete kickstart honest.
    }
  }
  return "echo 'Configure environment.start in .facility.yml' >&2; exit 1";
}

function detectWorkspace(existing: Map<string, string>, defaultBranch: string) {
  const packageManager = existing.has("pnpm-lock.yaml")
    ? "pnpm"
    : existing.has("yarn.lock")
      ? "yarn"
      : existing.has("package-lock.json")
        ? "npm"
        : "none";
  const scripts = packageScripts(existing.get("package.json"));
  const command = (script: string) =>
    packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;
  const checks = ["lint", "typecheck", "test"].filter((script) => scripts.has(script)).map(command);
  return {
    defaultBranch,
    packageManager,
    checks,
    setup:
      packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : packageManager === "yarn"
          ? "yarn install --immutable"
          : packageManager === "npm"
            ? "npm ci"
            : undefined,
  } as const;
}

function packageScripts(source: string | undefined) {
  if (!source) return new Set<string>();
  try {
    return new Set(
      Object.keys((JSON.parse(source) as { scripts?: Record<string, string> }).scripts ?? {}),
    );
  } catch {
    return new Set<string>();
  }
}

async function renderTree(
  client: FacilityGithubClient,
  files: Array<{ path: string; content: string; mode: "100644" }>,
): Promise<TreeItem[]> {
  return Promise.all(
    files.map(async (file) => ({
      path: file.path,
      mode: file.mode,
      type: "blob" as const,
      sha: await client.createBlob(file.content),
    })),
  );
}

function kickstartPrBody(paths: string[]) {
  return [
    "Configures the persistent development environment and repository-defined agents for Facility 0.12.",
    "",
    "Before merging:",
    "1. Review the commands and ports in `.facility.yml`.",
    "2. Review each prompt, engine, model, and trigger under `.agents/`.",
    "3. Keep the default branch protected by pull-request review. Facility does not merge this PR.",
    "",
    "Files:",
    ...paths.map((path) => `- \`${path}\``),
  ].join("\n");
}
