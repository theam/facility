import { generateApiKey, hashKey, newId, seal } from "@facility/core";
import {
  agentDefs,
  apiKeys,
  createDb,
  githubInstallations,
  insertAuditEvent,
  kbSpaces,
  llmRequests,
  outcomes,
  projects,
  registryItems,
  registryVersions,
  repos,
  roles,
  runs,
  sandboxProfiles,
  virtualKeys,
} from "@facility/db";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  createGithubClientFactory,
  FacilityGithubClient,
  type GithubClientFactory,
} from "../github/client.js";
import { harnessFragmentForBundle, validateProjectKb } from "../harness.js";
import type { AppConfig } from "../types.js";
import { raisePlatformIssue } from "../watchtower/issues.js";
import { DockerSandboxDriver } from "./docker.js";
import type { LaunchSpec, SandboxDriver, SandboxDriverName } from "./driver.js";
import { sandboxDriver } from "./driver.js";
import {
  appendRunEvents,
  type RunBundle,
  type RunnerEngine,
  type RunSandboxState,
  readSandbox,
  TERMINAL_RUN_STATUSES,
  terminalStatus,
} from "./state.js";

type DispatchJob = { runId?: string; orgId?: string };
type RunRow = typeof runs.$inferSelect;

export async function dispatchRun(config: AppConfig, job: DispatchJob) {
  if (!job.runId || !job.orgId) throw new Error("runs.dispatch requires runId and orgId");
  const { db, client } = createDb(config.databaseUrl);
  // Track credentials + the launched sandbox as they come into existence so a
  // failure BEFORE they are persisted into runs.sandbox can still tear them down
  // (failRun revokes by persisted sandbox, which wouldn't yet carry these ids).
  const createdKeys: RunSandboxState = {};
  let launchedSandbox: { driver: SandboxDriver; ref: string } | undefined;
  try {
    const run = await loadRun(db, job.orgId, job.runId);
    if (run?.status !== "queued") return;
    // Claim the run atomically. If a duplicate queue delivery raced us and
    // another worker already moved it out of "queued", the update touches no
    // rows and we must NOT launch a second sandbox for the same run.
    const claimed = await db
      .update(runs)
      .set({ status: "provisioning", updatedAt: new Date() })
      .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id), eq(runs.status, "queued")))
      .returning({ id: runs.id });
    if (claimed.length === 0) return;
    await appendRunEvents(db, run.orgId, run.id, [{ type: "provisioning", data: {} }]);

    const { bundle, profile } = await buildRunBundle(db, run, config);
    const virtualKey = await generateApiKey("fvk");
    await db.insert(virtualKeys).values({
      id: virtualKey.id,
      orgId: run.orgId,
      projectId: run.projectId,
      runId: run.id,
      name: `Run ${run.id}`,
      prefix: virtualKey.lookup,
      last4: virtualKey.last4,
      hash: virtualKey.hash,
      allowedModels: modelNames(bundle.engineConfig),
      expiresAt: new Date(Date.now() + bundle.timeoutMin * 60_000),
    });
    // Track the moment it exists — before any further step that could throw.
    createdKeys.virtualKeyId = virtualKey.id;

    // Run-scoped platform key: least-privilege (kb + tasks only), pinned to the
    // run's project, so a harness agent (Project Owner, learning) can maintain
    // the KB / propose tasks through the /v1 API. Revoked when the run ends.
    const harnessRoleId = await ensureHarnessAgentRole(db, run.orgId);
    const platformKey = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: platformKey.id,
      orgId: run.orgId,
      name: `Run ${run.id} harness`,
      prefix: platformKey.lookup,
      last4: platformKey.last4,
      hash: platformKey.hash,
      scopeType: "project",
      projectId: run.projectId,
      roleId: harnessRoleId,
      createdBy: `run:${run.id}`,
      // Same lifecycle as the virtual key: bound to the run, expires with it, so
      // it can be swept on terminal + rejected once expired (no indefinite fak_).
      runId: run.id,
      expiresAt: new Date(Date.now() + bundle.timeoutMin * 60_000),
    });
    createdKeys.platformKeyId = platformKey.id;

    const runnerToken = `frt_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const driverName = normalizeDriver(profile.driver);
    const driver = await sandboxDriver(driverName);
    const launchSpec: LaunchSpec = {
      runId: run.id,
      image: profile.image,
      env: {
        FACILITY_API_URL: config.sandboxApiUrl,
        RUN_ID: run.id,
        RUNNER_TOKEN: runnerToken,
      },
      cpu: resourceNumber(profile.resources, "cpu", 2),
      memoryMb: resourceNumber(profile.resources, "memory_mb", 4096),
      timeoutMin: bundle.timeoutMin,
      cmd: command(profile.setup),
      network: objectOrEmpty(profile.network),
    };
    const launched = await driver.launch(launchSpec);
    launchedSandbox = { driver, ref: launched.ref };
    // Attach the live sandbox only if the run is still active. If a cancel raced
    // provisioning and already made the run terminal, do NOT hand it a live
    // sandbox + keys — tear the sandbox down and revoke the credentials.
    const [attached] = await db
      .update(runs)
      .set({
        sandbox: {
          driver: driver.name,
          ref: launched.ref,
          image: profile.image,
          runnerTokenHash: await hashKey(runnerToken),
          virtualKeyId: virtualKey.id,
          sealedVirtualKey: await seal(virtualKey.secret, config.secretMasterKey),
          platformKeyId: platformKey.id,
          sealedPlatformKey: await seal(platformKey.secret, config.secretMasterKey),
          projectId: run.projectId,
          bundle,
          launchedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(runs.id, run.id), notInArray(runs.status, [...TERMINAL_RUN_STATUSES])))
      .returning({ id: runs.id });
    if (!attached) {
      await driver.destroy(launched.ref).catch(() => undefined);
      await revokeRunKeys(db, createdKeys);
      return;
    }
    await appendRunEvents(db, run.orgId, run.id, [
      { type: "sandbox", data: { driver: driver.name, ref: launched.ref } },
    ]);
  } catch (error) {
    await failRun(db, job.orgId, job.runId, errorMessage(error), "provision_failed").catch(
      () => undefined,
    );
    // failRun revokes by the persisted sandbox, which on a pre-persist failure
    // wouldn't carry these — so revoke every key we minted, and destroy the
    // sandbox if it launched before the failure, directly.
    await revokeRunKeys(db, createdKeys).catch(() => undefined);
    if (launchedSandbox) {
      await launchedSandbox.driver.destroy(launchedSandbox.ref).catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end();
  }
}

export async function finishRun(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  input: {
    status: "succeeded" | "failed";
    receipt?: Record<string, unknown>;
    error?: string;
    git?: { branch?: string; headSha?: string; changed: boolean; pushError?: string };
  },
  deps?: { config?: AppConfig; githubClientFactory?: GithubClientFactory },
) {
  if (terminalStatus(run.status)) return run;
  // A harness run that succeeds must leave the KB valid. If the checkpoint
  // fails, the run is a FAILURE — but resources must still be reclaimed, so we
  // downgrade status here and fall through to cleanup rather than throwing and
  // leaking the sandbox + virtual key (finding #3).
  let { status } = input;
  let { error } = input;
  if (status === "succeeded" && (await runUsesHarness(db, run))) {
    const checkpoint = await validateProjectKb(db, run.orgId, run.projectId);
    if (!checkpoint.ok) {
      status = "failed";
      error = `kb_checkpoint_failed:${checkpoint.errors.map((e) => e.code).join(",")}`;
    }
  }
  const sandbox = readSandbox(run.sandbox);
  const aggregate = await gatewayAggregate(db, run.id);
  const receipt = {
    ...(input.receipt ?? {}),
    usage: {
      ...(typeof input.receipt?.usage === "object" && input.receipt.usage !== null
        ? input.receipt.usage
        : {}),
      input_tokens: aggregate.inputTokens,
      output_tokens: aggregate.outputTokens,
      cache_read: aggregate.cacheRead,
      cache_write: aggregate.cacheWrite,
      cost_cents: aggregate.costCents,
      cost_source: "gateway",
    },
    events: { count: aggregate.eventCount, checks: aggregate.checkCount },
  };
  const claimed = (
    await db
      .update(runs)
      .set({
        status,
        receipt,
        error,
        endedAt: new Date(),
        sandbox: { ...sandbox, finishedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      // Claim the terminal transition atomically — if a concurrent finish/cancel
      // already moved the run to a terminal state, this updates nothing and we
      // skip the (idempotent-but-wasteful) cleanup.
      .where(and(eq(runs.id, run.id), notInArray(runs.status, [...TERMINAL_RUN_STATUSES])))
      .returning()
  )[0];
  if (!claimed) return run;
  if (sandbox.driver && sandbox.ref) {
    const driver = await sandboxDriver(sandbox.driver);
    await driver.destroy(sandbox.ref).catch(() => undefined);
  }
  await revokeRunKeys(db, sandbox);
  await appendRunEvents(db, run.orgId, run.id, [{ type: "result", data: { status, error } }]);
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "run.finished",
    target: { type: "run", id: run.id },
    payload: { status, error },
  });
  if (status === "succeeded" && input.git?.branch) {
    await openRunPullRequest(db, claimed, receipt, input.git, deps).catch(async (prError) => {
      const message = errorMessage(prError);
      await appendRunEvents(db, run.orgId, run.id, [
        { type: "artifact_error", data: { kind: "pr_open_failed", error: message } },
      ]).catch(() => undefined);
      await raisePlatformIssue(db, {
        orgId: run.orgId,
        projectId: run.projectId,
        kind: "pr_open_failed",
        severity: "error",
        fingerprint: `pr_open_failed:${run.id}`,
        title: "Failed to open run pull request",
        bodyMd: `Run ${run.id} succeeded and pushed ${input.git?.branch}, but Facility could not open a pull request.\n\n${message}`,
      }).catch(() => undefined);
    });
  }
  return claimed;
}

async function openRunPullRequest(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  receipt: Record<string, unknown>,
  git: { branch?: string; headSha?: string; changed: boolean; pushError?: string },
  deps?: { config?: AppConfig; githubClientFactory?: GithubClientFactory },
) {
  if (!git.branch || git.pushError) return;
  // Resolve the repo the run actually worked on: the trigger recorded it in
  // run.gh (owner/repo). Fall back to the project's oldest repo only for runs
  // that carry no gh ref — never an arbitrary limit(1) pick (nondeterministic,
  // and wrong the moment a project has two repos).
  const gh = objectOrEmpty(run.gh);
  const ghOwner = typeof gh.owner === "string" ? gh.owner : null;
  const ghRepoName = typeof gh.repo === "string" ? gh.repo : null;
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, run.orgId),
          eq(repos.projectId, run.projectId),
          ...(ghOwner && ghRepoName ? [eq(repos.owner, ghOwner), eq(repos.name, ghRepoName)] : []),
        ),
      )
      .orderBy(repos.createdAt)
      .limit(1)
  )[0];
  // From here on, a succeeded run HAS pushed a branch — failing to open its PR
  // must be loud (artifact_error + platform issue via the caller's catch), not a
  // silent early return that strands the branch.
  if (!repo?.installationId) throw new Error("run_repo_missing_installation");
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, run.orgId),
          eq(githubInstallations.id, repo.installationId),
        ),
      )
      .limit(1)
  )[0];
  if (!installation) throw new Error("run_installation_missing");
  if (installation.suspendedAt) throw new Error("run_installation_suspended");
  const config = deps?.config;
  const factory =
    deps?.githubClientFactory ??
    (config?.githubAppId && config.githubAppPrivateKey ? createGithubClientFactory(config) : null);
  if (!factory) throw new Error("github_app_unconfigured");
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  const issueNumber = numberOrUndefined(gh.issueNumber);
  const pr = await client.createPullRequest({
    head: git.branch,
    base: repo.defaultBranch,
    title: issueNumber ? `${run.mode}: #${issueNumber}` : `${run.mode}: run ${run.id}`,
    body: prBody(run, receipt, issueNumber),
  });
  const nextGh = { ...gh, branch: git.branch, pr: { number: pr.number, url: pr.url } };
  await db.update(runs).set({ gh: nextGh, updatedAt: new Date() }).where(eq(runs.id, run.id));
  await db
    .insert(outcomes)
    .values({
      id: newId("evt"),
      orgId: run.orgId,
      projectId: run.projectId,
      runId: run.id,
      repo: `${repo.owner}/${repo.name}`,
      prNumber: pr.number,
      agentLane: run.engine,
      openedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [outcomes.orgId, outcomes.repo, outcomes.prNumber],
      set: { runId: run.id, updatedAt: new Date() },
    });
  if (issueNumber) {
    await client
      .createIssueComment(issueNumber, `Facility opened PR #${pr.number}: ${pr.url}`)
      .catch(() => undefined);
  }
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "github.pr.created",
    target: { type: "run", id: run.id },
    payload: { runId: run.id, branch: git.branch, pr },
  });
}

function prBody(run: RunRow, receipt: Record<string, unknown>, issueNumber: number | undefined) {
  const usage = objectOrEmpty(receipt.usage);
  const cost = usage.cost_cents;
  return [
    `Facility run: ${run.id}`,
    `Mode: ${run.mode}`,
    `Engine: ${run.engine}`,
    `Cost: ${typeof cost === "number" ? `${cost} cents` : "unknown"}`,
    "",
    issueNumber ? `Closes #${issueNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function cancelRun(config: AppConfig, run: RunRow) {
  const sandbox = readSandbox(run.sandbox);
  if (sandbox.driver && sandbox.ref) {
    const driver = await sandboxDriver(sandbox.driver);
    await driver.stop(sandbox.ref).catch(() => undefined);
    await driver.destroy(sandbox.ref).catch(() => undefined);
  }
  const { db, client } = createDb(config.databaseUrl);
  try {
    await revokeRunKeys(db, sandbox);
  } finally {
    await client.end();
  }
}

const HARNESS_AGENT_PERMS = ["kb:read", "kb:write", "tasks:read", "tasks:write"];

/** Idempotently ensure the least-privilege role a harness agent's key binds to. */
async function ensureHarnessAgentRole(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
): Promise<string> {
  const existing = (
    await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, "harness-agent")))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const id = newId("key");
  await db
    .insert(roles)
    .values({
      id,
      orgId,
      name: "harness-agent",
      description: "Run-scoped key for Project Owner / learning agents (KB + tasks).",
      permissions: HARNESS_AGENT_PERMS,
    })
    .onConflictDoNothing();
  const row = (
    await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, "harness-agent")))
      .limit(1)
  )[0];
  return row?.id ?? id;
}

export async function reconcileSandboxes(config: AppConfig) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    // The orphan-container sweep is docker-specific. Skip it gracefully when the
    // daemon isn't reachable (e.g. an aws-driver deployment has no local Docker)
    // so the driver-agnostic reconciliation below — timeout cost-cap backstop and
    // the orphaned-key sweep — still runs instead of the whole tick throwing.
    try {
      const docker = new DockerSandboxDriver();
      for (const container of await docker.listFacilityContainers()) {
        const run = (await db.select().from(runs).where(eq(runs.id, container.runId)).limit(1))[0];
        const sandbox = readSandbox(run?.sandbox);
        if (!run || terminalStatus(run.status) || sandbox.ref !== container.ref) {
          await docker.destroy(container.ref);
        }
      }
    } catch {
      // Docker unavailable on this host; other drivers reconcile below.
    }

    const liveRuns = await db
      .select()
      .from(runs)
      .where(inArray(runs.status, ["provisioning", "running"]));
    for (const run of liveRuns) {
      // Isolate each run: one unreachable/misconfigured driver must not abort the
      // whole tick (and skip the orphaned-key sweep below) — just skip that run.
      try {
        const sandbox = readSandbox(run.sandbox);
        if (!sandbox.driver || !sandbox.ref) continue;
        const driver = await sandboxDriver(sandbox.driver);
        // Hard cost cap / driver-level backstop: if a run has blown past its timeout
        // (with grace beyond the runner's own SIGTERM→SIGKILL escalation), destroy
        // the sandbox and fail the run — covers an engine that ignores signals or a
        // wedged sandbox the in-container runner can't kill itself.
        const launchedAt = sandbox.launchedAt ? Date.parse(sandbox.launchedAt) : Number.NaN;
        const timeoutMin = Number(sandbox.bundle?.timeoutMin) || 60;
        const deadline = Number.isNaN(launchedAt) ? null : launchedAt + (timeoutMin + 3) * 60_000;
        if (deadline !== null && Date.now() > deadline) {
          await driver.destroy(sandbox.ref).catch(() => undefined);
          await failRun(db, run.orgId, run.id, "sandbox_timeout", "sandbox_timeout");
          continue;
        }
        const status = await driver.status(sandbox.ref);
        if (status === "exited" || status === "lost") {
          await failRun(db, run.orgId, run.id, "sandbox_lost", "sandbox_lost");
        }
      } catch {
        // Driver unreachable for this run; leave it for the next tick.
      }
    }

    // Invariant backstop: a terminal run must never own a live key. Each terminal
    // path already revokes best-effort, but a crash between the status commit and
    // that revoke would otherwise leave keys live until their natural expiry — so
    // reconcile the invariant here, covering every terminal path uniformly.
    await revokeOrphanedRunKeys(db);
  } finally {
    await client.end();
  }
}

// Revoke any still-live run-scoped key whose run has already gone terminal, in
// two set-based UPDATEs (the isNull filter keeps the working set to genuine
// orphans, backed by the partial live-key indexes from migration 0010). Both the
// spend-capable virtual key and the platform key now carry runId, so the sweep is
// symmetric. Push the gateway invalidation for each revoked virtual key, exactly
// like revokeRunKeys (the gateway doesn't cache platform keys — api auth rechecks
// revokedAt + expiry on every hit).
async function revokeOrphanedRunKeys(db: ReturnType<typeof createDb>["db"]) {
  const terminalRunIds = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, [...TERMINAL_RUN_STATUSES]));
  const orphanVirtualKeys = await db
    .update(virtualKeys)
    .set({ revokedAt: new Date() })
    .where(and(isNull(virtualKeys.revokedAt), inArray(virtualKeys.runId, terminalRunIds)))
    .returning({ prefix: virtualKeys.prefix });
  for (const row of orphanVirtualKeys) {
    await db
      .execute(sql`select pg_notify('facility_key_revoked', ${row.prefix})`)
      .catch(() => undefined);
  }
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(isNull(apiKeys.revokedAt), inArray(apiKeys.runId, terminalRunIds)));
}

async function buildRunBundle(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  config: AppConfig,
) {
  const agent = run.agentDefId
    ? (await db.select().from(agentDefs).where(eq(agentDefs.id, run.agentDefId)).limit(1))[0]
    : undefined;
  if (!agent) throw new Error("run_missing_agent_def");
  if (agent.orgId !== run.orgId || agent.projectId !== run.projectId) {
    throw new Error("agent_not_in_project");
  }
  const profile = (
    await db
      .select()
      .from(sandboxProfiles)
      .where(
        and(
          eq(sandboxProfiles.orgId, run.orgId),
          agent.sandboxProfileId
            ? eq(sandboxProfiles.id, agent.sandboxProfileId)
            : or(eq(sandboxProfiles.id, "sbx_dev_default"), isNull(sandboxProfiles.projectId)),
        ),
      )
      // Deterministic fallback when an org has several global profiles: the
      // canonical seeded default wins, otherwise the oldest global profile — never
      // an arbitrary row (limit(1) with no order returned a nondeterministic pick).
      .orderBy(
        sql`case when ${sandboxProfiles.id} = 'sbx_dev_default' then 0 else 1 end`,
        sandboxProfiles.createdAt,
      )
      .limit(1)
  )[0];
  if (!profile) throw new Error("run_missing_sandbox_profile");
  const repo = (
    await db
      .select()
      .from(repos)
      .where(and(eq(repos.orgId, run.orgId), eq(repos.projectId, run.projectId)))
      .limit(1)
  )[0];
  // The project's configured acceptance gates (settings.check_cmds) — what
  // kickstart detects and the web project page edits — are the fallback source of
  // truth for the platform lane when the sandbox profile doesn't override them.
  const project = (
    await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.orgId, run.orgId), eq(projects.id, run.projectId)))
      .limit(1)
  )[0];
  const contract = await activeRegistryContent(db, run.orgId, agent.contractItemId);
  const skills = await activeSkills(db, run.orgId, run.projectId);
  const space = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, run.orgId), eq(kbSpaces.projectId, run.projectId)))
      .limit(1)
  )[0];
  const timeoutMin = resourceNumber(profile.resources, "timeout_min", 60);
  // Point the agent's SDKs directly at the gateway service. Its routes are
  // /anthropic/v1/* and /openai/v1/*, so the base URL is {gateway}/anthropic
  // and the SDK appends /v1/messages (Anthropic) or /v1/chat/completions.
  const gatewayBase = config.sandboxGatewayUrl.replace(/\/$/, "");
  const bundle: RunBundle = {
    runId: run.id,
    mode: run.mode,
    engine: normalizeEngine(agent.engine || run.engine),
    contract,
    skills,
    engineConfig: objectOrEmpty(agent.model),
    repo: repo
      ? {
          cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
          branch: repo.defaultBranch,
          installationTokenRef: repo.installationId,
        }
      : { cloneUrl: null, branch: null, installationTokenRef: null },
    provisionCmd:
      stringField(profile.setup, "provision_cmd") ?? stringField(profile.setup, "provisionCmd"),
    // Acceptance gates: a sandbox profile's setup.check_cmds is an explicit
    // platform-level override; otherwise fall back to the project's own configured
    // checks (projects.settings.check_cmds — what kickstart detects, the web project
    // page shows, and the repo lane runs), so gates configured for a project also
    // run in the platform lane instead of silently doing nothing.
    checkCmds: resolveCheckCmds(profile, project?.settings),
    gatewayUrls: {
      anthropic: `${gatewayBase}/anthropic`,
      openai: `${gatewayBase}/openai`,
    },
    scope: objectOrEmpty(run.trigger),
    timeoutMin,
    harness: harnessFragmentForBundle({ space, config, runId: run.id }),
  };
  return { bundle, profile };
}

async function runUsesHarness(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  if (!run.agentDefId) return false;
  const agent = (
    await db.select().from(agentDefs).where(eq(agentDefs.id, run.agentDefId)).limit(1)
  )[0];
  return Boolean(agent?.harnessItemId);
}

async function activeRegistryContent(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
  itemId: string,
) {
  const row = (
    await db
      .select({ version: registryVersions })
      .from(registryVersions)
      .innerJoin(registryItems, eq(registryVersions.itemId, registryItems.id))
      .where(
        and(
          eq(registryItems.orgId, orgId),
          eq(registryItems.id, itemId),
          eq(registryVersions.status, "active"),
        ),
      )
      .orderBy(desc(registryVersions.version))
      .limit(1)
  )[0];
  if (!row) throw new Error("registry_contract_missing");
  return row.version.content;
}

async function activeSkills(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
  projectId: string,
) {
  const rows = await db
    .select({
      name: registryItems.name,
      projectId: registryItems.projectId,
      version: registryVersions.version,
      content: registryVersions.content,
    })
    .from(registryVersions)
    .innerJoin(registryItems, eq(registryVersions.itemId, registryItems.id))
    .where(
      and(
        eq(registryItems.orgId, orgId),
        eq(registryItems.kind, "skill"),
        eq(registryVersions.status, "active"),
        // Only this run's own scope: org-global skills (projectId null) plus the
        // run's project skills — NEVER other projects' skills (cross-project leak).
        or(isNull(registryItems.projectId), eq(registryItems.projectId, projectId)),
      ),
    );
  // One skill per name. A project-scoped skill overrides an org-global one of the
  // same name (project customization wins); within the same scope the highest
  // active version wins. Then stable order by name.
  const chosen = new Map<
    string,
    { name: string; scoped: boolean; version: number; content: string }
  >();
  for (const row of rows) {
    const scoped = row.projectId != null;
    const current = chosen.get(row.name);
    const wins =
      !current ||
      (scoped && !current.scoped) ||
      (scoped === current.scoped && row.version > current.version);
    if (wins)
      chosen.set(row.name, { name: row.name, scoped, version: row.version, content: row.content });
  }
  return [...chosen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, content }) => ({ name, content }));
}

// Revoke a run's least-privilege credentials — the run-scoped virtual key (LLM
// gateway) and platform key (kb/tasks). Shared by every terminal path so a
// failed/timed-out run never leaves a live key behind.
async function revokeRunKeys(db: ReturnType<typeof createDb>["db"], sandbox: RunSandboxState) {
  const now = new Date();
  if (sandbox.virtualKeyId) {
    // Guard on isNull so a re-revoke is a no-op and we only push-invalidate the
    // gateway cache the first time a key actually flips to revoked.
    const revoked = await db
      .update(virtualKeys)
      .set({ revokedAt: now })
      .where(and(eq(virtualKeys.id, sandbox.virtualKeyId), isNull(virtualKeys.revokedAt)))
      .returning({ prefix: virtualKeys.prefix });
    // Push-invalidate the gateway's key cache so a revoked run key stops working
    // immediately, not after its cache TTL. Best-effort: the gateway's TTL +
    // per-key expiry remain the backstop if the notify (or its LISTEN) is missed.
    for (const row of revoked) {
      await db
        .execute(sql`select pg_notify('facility_key_revoked', ${row.prefix})`)
        .catch(() => undefined);
    }
  }
  if (sandbox.platformKeyId) {
    await db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.id, sandbox.platformKeyId), isNull(apiKeys.revokedAt)));
  }
}

async function failRun(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
  runId: string,
  message: string,
  kind: string,
) {
  // Claim the failure atomically: only a non-terminal run transitions, so a
  // concurrent finish/cancel/fail cannot be clobbered and cleanup runs once.
  const [failed] = await db
    .update(runs)
    .set({ status: "failed", error: message, endedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.id, runId),
        notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      ),
    )
    .returning({ projectId: runs.projectId, sandbox: runs.sandbox });
  if (!failed) return; // already terminal — another path handled it.
  // Reclaim the run's credentials + sandbox so a failed run can't keep calling
  // the gateway or the platform API.
  await revokeRunKeys(db, readSandbox(failed.sandbox));
  // Route through raisePlatformIssue so the run failure is canonical severity,
  // carries its projectId (so it surfaces in project health), and dedups on
  // repeated failures instead of violating the org+fingerprint unique index.
  await raisePlatformIssue(db, {
    orgId,
    projectId: failed.projectId ?? null,
    fingerprint: `run_failure:${runId}:${kind}`,
    kind: "run_failure",
    severity: "error",
    title: kind,
    bodyMd: message,
  });
  await appendRunEvents(db, orgId, runId, [
    { type: "result", data: { status: "failed", kind, error: message } },
  ]);
}

async function loadRun(db: ReturnType<typeof createDb>["db"], orgId: string, runId: string) {
  return (
    await db
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
      .limit(1)
  )[0];
}

async function gatewayAggregate(db: ReturnType<typeof createDb>["db"], runId: string) {
  const usage = (
    await db
      .select({
        inputTokens: sql<number>`coalesce(sum(${llmRequests.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${llmRequests.outputTokens}), 0)`,
        cacheRead: sql<number>`coalesce(sum(${llmRequests.cacheRead}), 0)`,
        cacheWrite: sql<number>`coalesce(sum(${llmRequests.cacheWrite}), 0)`,
        costCents: sql<number>`floor(coalesce(sum(${llmRequests.costCents}), 0) + 0.5)::bigint`,
      })
      .from(llmRequests)
      .where(eq(llmRequests.runId, runId))
  )[0];
  const events = await db.execute(sql`
    select
      count(*)::int as event_count,
      count(*) filter (where type = 'check')::int as check_count
    from run_events
    where run_id = ${runId}
  `);
  const eventRow = (events as unknown as Array<{ event_count: number; check_count: number }>)[0];
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    cacheRead: Number(usage?.cacheRead ?? 0),
    cacheWrite: Number(usage?.cacheWrite ?? 0),
    costCents: Number(usage?.costCents ?? 0),
    eventCount: Number(eventRow?.event_count ?? 0),
    checkCount: Number(eventRow?.check_count ?? 0),
  };
}

function normalizeDriver(value: string): SandboxDriverName {
  if (value === "aws") return "aws";
  return "docker";
}

function normalizeEngine(value: string): RunnerEngine {
  if (value === "claude_code" || value === "claude") return "claude_code";
  if (value === "byo") return "byo";
  return "codex";
}

function resourceNumber(value: unknown, key: string, fallback: number) {
  const candidate = objectOrEmpty(value)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
}

function stringField(value: unknown, key: string) {
  const candidate = objectOrEmpty(value)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function arrayField(value: unknown, key: string) {
  const candidate = objectOrEmpty(value)[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
}

// Resolve the run's acceptance-gate commands: a sandbox profile's explicit
// setup.check_cmds override wins; otherwise the project's own configured checks
// (settings.check_cmds). Empty when neither is set.
export function resolveCheckCmds(profile: { setup: unknown }, projectSettings: unknown): string[] {
  const profileChecks = arrayField(profile.setup, "check_cmds");
  return profileChecks.length > 0 ? profileChecks : arrayField(projectSettings, "check_cmds");
}

function command(value: unknown) {
  const candidate = objectOrEmpty(value).cmd;
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : undefined;
}

function modelNames(value: Record<string, unknown>) {
  const model = value.model;
  return typeof model === "string" ? [model] : undefined;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
