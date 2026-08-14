import {
  allowedModelsForEngine,
  type FacilityReceipt,
  FacilityReceiptSchema,
  generateApiKey,
  hashKey,
  newId,
  receiptContentDigest,
  seal,
  sealFacilityReceipt,
  verifyFacilityReceipt,
} from "@facility/core";
import {
  actionTypes,
  agentDefs,
  apiKeys,
  conversationMessages,
  conversations,
  createDb,
  ghIssues,
  githubInstallations,
  insertAuditEvent,
  kbSpaces,
  llmRequests,
  outcomes,
  projects,
  proposalEvents,
  proposals,
  providerCredentials,
  registryItems,
  registryVersions,
  repos,
  roles,
  runDeliveries,
  runEvents,
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
import { pullRequestBodyForIssue } from "../github/closing-issues.js";
import {
  type GithubRunProgressPhase,
  progressCommentId,
  renderGithubRunProgress,
} from "../github/run-progress.js";
import {
  type SecurityReport,
  SecurityReportSchema,
  sanitizeSecurityReport,
  syncSecurityFindings,
} from "../github/security-findings.js";
import { harnessFragmentForBundle, validateProjectKb } from "../harness.js";
import {
  assertPreviewProvisioningAvailable,
  createPreviewRecord,
  previewAccessUrl,
} from "../previews.js";
import type { AppConfig } from "../types.js";
import { raisePlatformIssue, resolvePlatformIssue } from "../watchtower/issues.js";
import { sandboxCachePartition, sandboxNamespace } from "./cache.js";
import { nestedDockerEnabled, provisioningDepth } from "./capabilities.js";
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
type FinishRunDeps = {
  config?: AppConfig;
  githubClientFactory?: GithubClientFactory;
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>;
};
type DispatchRunDeps = {
  sandboxDriver?: (name: SandboxDriverName) => Promise<SandboxDriver>;
};

const RESUME_FALLBACK_SCOPE_MAX_BYTES = 32 * 1024;

export async function dispatchRun(config: AppConfig, job: DispatchJob, deps: DispatchRunDeps = {}) {
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

    const { bundle, profile, agentPermissions } = await buildRunBundle(db, run, config);
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
      allowedModels: allowedModelsForEngine(bundle.engine, bundle.engineConfig),
    });
    // Track the moment it exists — before any further step that could throw.
    createdKeys.virtualKeyId = virtualKey.id;

    // Run-scoped platform key: the agent's OWN declared permissions (what the
    // web/API editor shows) clamped to a run-safe ceiling — so editing an
    // agent's permissions actually changes what its run can do, and a run key
    // can never carry org-admin/destructive scopes regardless of the agent def.
    // Pinned to the run's project; revoked when the run ends.
    const harnessRoleId = await ensureRunAgentRole(
      db,
      run.orgId,
      agentPermissions,
      Boolean(bundle.harness),
    );
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
      // Same lifecycle as the virtual key: bound to the run and revoked on every
      // terminal boundary. It deliberately has no wall-clock expiry because a
      // healthy run has no time limit; terminal cleanup remains the security boundary.
      runId: run.id,
    });
    createdKeys.platformKeyId = platformKey.id;

    const runnerToken = `frt_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const driverName = normalizeDriver(profile.driver);
    const nestedDocker = nestedDockerEnabled(profile.setup);
    const provisioning = provisioningDepth(profile.setup);
    const driver = await (deps.sandboxDriver ?? sandboxDriver)(driverName);
    // A provider launch starts the runner command before launch() returns. Fast
    // providers (notably Vercel Sandbox) can therefore reach /hello before we
    // receive their provider ref. Persist the runner credential and one-shot
    // bundle first so authentication is ready when the command starts.
    const [runnerTokenHash, sealedVirtualKey, sealedPlatformKey] = await Promise.all([
      hashKey(runnerToken),
      seal(virtualKey.secret, config.secretMasterKey),
      seal(platformKey.secret, config.secretMasterKey),
    ]);
    const preparedSandbox: RunSandboxState = {
      driver: driver.name,
      image: profile.image,
      runnerTokenHash,
      virtualKeyId: virtualKey.id,
      sealedVirtualKey,
      platformKeyId: platformKey.id,
      sealedPlatformKey,
      projectId: run.projectId,
      bundle,
    };
    const [prepared] = await db
      .update(runs)
      .set({ sandbox: preparedSandbox, updatedAt: new Date() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "provisioning")))
      .returning({ id: runs.id });
    if (!prepared) {
      await revokeRunKeys(db, createdKeys);
      return;
    }
    const launchSpec: LaunchSpec = {
      runId: run.id,
      namespace: sandboxNamespace(config),
      kind: "run",
      cachePartition: sandboxCachePartition(config.secretMasterKey, run.orgId, run.projectId),
      image: profile.image,
      env: {
        FACILITY_API_URL: config.sandboxApiUrl,
        RUN_ID: run.id,
        RUNNER_TOKEN: runnerToken,
        ...(driverName === "aws" || driverName === "vercel"
          ? { FACILITY_SANDBOX_NESTED_DOCKER: nestedDocker ? "1" : "0" }
          : {}),
      },
      cpu: resourceNumber(profile.resources, "cpu", 2),
      memoryMb: resourceNumber(profile.resources, "memory_mb", 4096),
      timeoutMin: bundle.timeoutMin,
      cmd: command(profile.setup),
      network: {
        ...objectOrEmpty(profile.network),
        // Provider firewalls need the two control-plane callbacks even when a
        // profile otherwise uses the standard restricted package/GitHub set.
        allowed_domains: [
          ...arrayField(profile.network, "allowed_domains"),
          new URL(config.sandboxApiUrl).hostname,
          new URL(config.sandboxGatewayUrl).hostname,
        ],
      },
    };
    const launched = await driver.launch(launchSpec);
    launchedSandbox = { driver, ref: launched.ref };
    // Attach the provider ref only if the run is still active. If cancellation
    // raced provisioning, tear down the newly launched sandbox; cancelRun has
    // already revoked the credentials persisted above.
    const [attached] = await db
      .update(runs)
      .set({
        // /hello may have already marked virtualKeyRevealedAt while launch()
        // was returning. Merge only provider-owned fields so that one-shot
        // credential claim can never be overwritten and replayed.
        sandbox: sql`${runs.sandbox} || ${JSON.stringify({
          ref: launched.ref,
          launchedAt: new Date().toISOString(),
        })}::jsonb`,
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
      {
        type: "sandbox",
        data: {
          driver: driver.name,
          ref: launched.ref,
          provisioning,
          ...(driverName === "aws" || driverName === "vercel"
            ? { nested_docker: nestedDocker }
            : {}),
        },
      },
    ]);
    await updateGithubRunProgress(db, run.id, "provisioning", { config }).catch(() => undefined);
  } catch (error) {
    await failRun(db, job.orgId, job.runId, errorMessage(error), "provision_failed").catch(
      () => undefined,
    );
    await updateGithubRunProgress(db, job.runId, "failed", { config }).catch(() => undefined);
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
    status: "succeeded" | "failed" | "canceled";
    receipt?: Record<string, unknown>;
    error?: string;
    git?: {
      branch?: string;
      headSha?: string;
      changed: boolean;
      pushError?: string;
      pullRequestTitle?: string;
      pullRequestBody?: string;
    };
    engineSessionId?: string;
    securityReport?: unknown;
  },
  deps?: FinishRunDeps,
) {
  if (terminalStatus(run.status)) return run;
  // A harness run that succeeds must leave the KB valid. If the checkpoint
  // fails, the run is a FAILURE — but resources must still be reclaimed, so we
  // downgrade status here and fall through to cleanup rather than throwing and
  // leaking the sandbox + virtual key (finding #3).
  let { status } = input;
  let { error } = input;
  let securityReport: SecurityReport | undefined;
  if (status === "succeeded" && isSecurityMode(run.mode)) {
    const parsed = SecurityReportSchema.safeParse(input.securityReport);
    if (parsed.success) securityReport = sanitizeSecurityReport(parsed.data);
    else {
      status = "failed";
      error = "security_report_invalid";
    }
  }
  const deliveryError = status === "succeeded" ? platformDeliveryFailure(run, input.git) : null;
  if (deliveryError) {
    status = "failed";
    error = deliveryError;
  }
  if (status === "succeeded" && (await runUsesHarness(db, run))) {
    const checkpoint = await validateProjectKb(db, run.orgId, run.projectId);
    if (!checkpoint.ok) {
      status = "failed";
      error = `kb_checkpoint_failed:${checkpoint.errors.map((e) => e.code).join(",")}`;
    }
  }
  const persistedGh =
    input.git?.branch && isBuilderMode(run.mode)
      ? {
          ...objectOrEmpty(run.gh),
          branch: input.git.branch,
          ...(input.git.headSha ? { headSha: input.git.headSha } : {}),
        }
      : run.gh;
  let deliveryPlan: Awaited<ReturnType<typeof prepareRunDelivery>> | null = null;
  let deliveryPreparationError: string | null = null;
  if (status === "succeeded" && input.git?.branch && isBuilderMode(run.mode)) {
    try {
      deliveryPlan = await prepareRunDelivery(db, { ...run, gh: persistedGh }, input.git);
    } catch (prepareError) {
      deliveryPreparationError = errorMessage(prepareError);
      status = "failed";
      error = `delivery_repo_unresolvable:${deliveryPreparationError}`;
    }
  }
  const sandbox = readSandbox(run.sandbox);
  const aggregate = await gatewayAggregate(db, run.id);
  let receipt = await canonicalRunReceipt(db, run, input.receipt, aggregate, status);
  const claimed = await db.transaction(async (tx) => {
    const terminal = (
      await tx
        .update(runs)
        .set({
          status,
          receipt,
          error,
          gh: persistedGh,
          engineSessionId: input.engineSessionId,
          endedAt: new Date(),
          sandbox: { ...sandbox, finishedAt: new Date().toISOString() },
          updatedAt: new Date(),
        })
        // The terminal status and durable delivery intent are one commit. A
        // process crash can therefore never strand a successfully pushed
        // branch without the metadata needed to publish its pull request.
        .where(and(eq(runs.id, run.id), notInArray(runs.status, [...TERMINAL_RUN_STATUSES])))
        .returning()
    )[0];
    if (!terminal) return null;
    if (status === "succeeded" && deliveryPlan) {
      await tx.insert(runDeliveries).values(deliveryPlan);
    }
    return terminal;
  });
  if (!claimed) return run;
  if (sandbox.driver && sandbox.ref) {
    const driver = await sandboxDriver(sandbox.driver);
    const destroyed = await driver
      .destroy(sandbox.ref)
      .then(() => true)
      .catch(() => false);
    if (destroyed) await markSandboxDestroyed(db, run.id);
  }
  await revokeRunKeys(db, sandbox);
  if (status === "succeeded" && deliveryPlan) {
    await deps?.enqueue?.("deliveries.deliver", { runId: run.id }).catch(() => undefined);
  } else if (deliveryPreparationError) {
    await appendRunEvents(db, run.orgId, run.id, [
      {
        type: "artifact_error",
        data: { kind: "delivery_repo_unresolvable", error: deliveryPreparationError },
      },
    ]);
    await raisePlatformIssue(db, {
      orgId: run.orgId,
      projectId: run.projectId,
      kind: "delivery_repo_unresolvable",
      severity: "error",
      fingerprint: `delivery_repo_unresolvable:${run.id}`,
      title: "Run delivery repository is unavailable",
      bodyMd: `Run ${run.id} pushed ${input.git?.branch}, but Facility could not bind the delivery to its tenant-scoped repository.\n\n${deliveryPreparationError}`,
    });
  }
  if (
    status === "succeeded" &&
    input.git?.changed === true &&
    input.git.branch &&
    repairPullRequestMode(run.mode)
  ) {
    await recordRunPullRequestUpdate(db, claimed, input.git.branch, input.git.headSha);
  }
  if (status === "succeeded" && isArchitectMode(run.mode)) {
    try {
      await openArchitectPlanAcceptance(db, claimed, receipt, deps);
    } catch (planError) {
      const message = errorMessage(planError);
      status = "failed";
      error = `plan_publication_failed:${message}`;
      receipt = await canonicalRunReceipt(db, run, input.receipt, aggregate, status);
      await db
        .update(runs)
        .set({ status, receipt, error, updatedAt: new Date() })
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
      await appendRunEvents(db, run.orgId, run.id, [
        { type: "artifact_error", data: { kind: "plan_publication_failed", error: message } },
      ]);
      await raisePlatformIssue(db, {
        orgId: run.orgId,
        projectId: run.projectId,
        kind: "plan_publication_failed",
        severity: "error",
        fingerprint: `plan_publication_failed:${run.id}`,
        title: "Failed to publish architect plan",
        bodyMd: `Architect run ${run.id} completed, but Facility could not publish its plan and human approval gate.\n\n${message}`,
      });
    }
  }
  if (status === "succeeded" && securityReport) {
    try {
      const sync = await publishSecurityFindings(db, claimed, securityReport, deps);
      await appendRunEvents(db, run.orgId, run.id, [
        {
          type: "security_findings",
          data: {
            report: securityReport,
            reported: securityReport.findings.length,
            eligible: sync.eligible,
            issues: sync.synced.map((issue) => ({
              number: issue.number,
              url: issue.url,
              created: issue.created,
            })),
          },
        },
      ]);
    } catch (syncError) {
      const message = errorMessage(syncError);
      status = "failed";
      error = `security_issue_sync_failed:${message}`;
      receipt = await canonicalRunReceipt(db, run, input.receipt, aggregate, status);
      await db
        .update(runs)
        .set({ status, receipt, error, updatedAt: new Date() })
        .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
      await appendRunEvents(db, run.orgId, run.id, [
        { type: "artifact_error", data: { kind: "security_issue_sync_failed", error: message } },
      ]);
      await raisePlatformIssue(db, {
        orgId: run.orgId,
        projectId: run.projectId,
        kind: "security_issue_sync_failed",
        severity: "error",
        fingerprint: `security_issue_sync_failed:${run.id}`,
        title: "Failed to synchronize security findings",
        bodyMd: `Security run ${run.id} completed its audit, but Facility could not synchronize qualifying findings to GitHub.\n\n${message}`,
      });
    }
  }
  await appendRunEvents(db, run.orgId, run.id, [{ type: "result", data: { status, error } }]);
  await updateGithubRunProgress(db, run.id, status, deps).catch(() => undefined);
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "run.finished",
    target: { type: "run", id: run.id },
    payload: {
      status,
      error,
      receipt_sha256: receipt.integrity?.payload_sha256 ?? receiptContentDigest(receipt),
    },
  });
  await finishConversationTurn(db, claimed, input.engineSessionId).catch(
    async (conversationError) => {
      const message = errorMessage(conversationError);
      await appendRunEvents(db, run.orgId, run.id, [
        { type: "artifact_error", data: { kind: "conversation_finish_failed", error: message } },
      ]).catch(() => undefined);
      await raisePlatformIssue(db, {
        orgId: run.orgId,
        projectId: run.projectId,
        kind: "conversation_finish_failed",
        severity: "error",
        fingerprint: `conversation_finish_failed:${run.id}`,
        title: "Failed to finalize conversation turn",
        bodyMd: `Run ${run.id} finished, but Facility could not append the conversation reply.\n\n${message}`,
      }).catch(() => undefined);
    },
  );
  return { ...claimed, status, receipt, error };
}

export async function finishConversationTurn(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  engineSessionId: string | undefined,
) {
  const trigger = objectOrEmpty(run.trigger);
  if (trigger.type !== "conversation") return;
  const conversationId =
    typeof trigger.conversationId === "string" ? trigger.conversationId : undefined;
  if (!conversationId) return;
  const conversation = (
    await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, run.orgId),
          eq(conversations.projectId, run.projectId),
          run.agentDefId ? eq(conversations.agentDefId, run.agentDefId) : sql`false`,
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1)
  )[0];
  if (!conversation) throw new Error("conversation_not_found");
  // Only the run that owns the running turn may finalize it — the conversation
  // pins its owning run at dispatch. A run carrying a forged/foreign
  // conversationId (different pinned run) must not append a reply or unlock it.
  if (conversation.lastRunId !== run.id) return;
  const reply = await lastAssistantText(db, run);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(seq), 0)` })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
    const seq = Number(rows[0]?.max ?? 0) + 1;
    await tx.insert(conversationMessages).values({
      id: newId("evt"),
      orgId: run.orgId,
      conversationId,
      seq,
      role: "agent",
      body: reply ?? "(no reply captured - see the session transcript)",
      runId: run.id,
    });
    await tx
      .update(conversations)
      .set({
        lastRunId: run.id,
        engineSessionId: engineSessionId ?? run.engineSessionId ?? conversation.engineSessionId,
        status: "idle",
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.orgId, run.orgId), eq(conversations.id, conversationId)));
  });
}

async function lastAssistantText(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  const row = (
    await db
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.orgId, run.orgId),
          eq(runEvents.runId, run.id),
          eq(runEvents.type, "assistant"),
        ),
      )
      .orderBy(desc(runEvents.seq))
      .limit(1)
  )[0];
  const data = objectOrEmpty(row?.data);
  return typeof data.text === "string" && data.text.trim() ? data.text : null;
}

export async function updateGithubRunProgress(
  db: ReturnType<typeof createDb>["db"],
  runId: string,
  phase: GithubRunProgressPhase,
  deps?: Pick<FinishRunDeps, "config" | "githubClientFactory">,
) {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
  if (!run || !progressCommentId(run.gh)) return false;
  const repo = await repoForGithubRun(db, run);
  if (!repo?.installationId) return false;
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
  if (!installation || installation.suspendedAt) return false;
  const config = deps?.config;
  const factory =
    deps?.githubClientFactory ??
    (config?.githubAppId && config.githubAppPrivateKey ? createGithubClientFactory(config) : null);
  if (!factory) return false;
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  const proposal = isArchitectMode(run.mode)
    ? (
        await db
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(eq(proposals.orgId, run.orgId), eq(proposals.runId, run.id)))
          .orderBy(desc(proposals.createdAt))
          .limit(1)
      )[0]
    : undefined;
  const finalText = phase === "succeeded" ? await lastAssistantText(db, run) : null;
  const agentProgress = await lastAgentProgress(db, run);
  const commentId = progressCommentId(run.gh);
  if (!commentId) return false;
  await client.updateIssueComment(
    commentId,
    renderProgressForRun(run, phase, {
      finalText,
      agentProgress,
      proposalId: proposal?.id,
      error: phase === "failed" ? run.error : null,
    }),
  );
  return true;
}

function renderProgressForRun(
  run: RunRow,
  phase: GithubRunProgressPhase,
  result: {
    finalText?: string | null;
    agentProgress?: string | null;
    proposalId?: string | null;
    error?: string | null;
  } = {},
) {
  const gh = objectOrEmpty(run.gh);
  const progress = objectOrEmpty(gh.progressComment);
  const trigger = objectOrEmpty(run.trigger);
  const requestTrigger =
    trigger.source === "plan_acceptance" ? objectOrEmpty(trigger.architectTrigger) : trigger;
  const request = objectOrEmpty(requestTrigger.request);
  const pr = objectOrEmpty(gh.pr);
  const prNumber = numberOrUndefined(pr.number);
  const prUrl = stringValue(pr.url);
  return renderGithubRunProgress({
    runId: run.id,
    mode: run.mode,
    command: stringValue(progress.command),
    phase,
    issueNumber: numberOrUndefined(gh.issueNumber) ?? 0,
    issueTitle: stringValue(request.title) ?? stringValue(progress.issueTitle),
    sender: stringValue(progress.sender),
    agentProgress: result.agentProgress,
    finalText: result.finalText,
    error: result.error,
    proposalId: result.proposalId,
    pullRequest: prNumber && prUrl ? { number: prNumber, url: prUrl } : null,
  });
}

async function openArchitectPlanAcceptance(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  receipt: FacilityReceipt,
  deps?: FinishRunDeps,
) {
  const gh = objectOrEmpty(run.gh);
  const issueNumber = numberOrUndefined(gh.issueNumber);
  if (!issueNumber) return;
  const repo = await repoForGithubRun(db, run);
  if (!repo) throw new Error("run_repo_missing");
  const plan = await lastAssistantText(db, run);
  if (!plan) throw new Error("architect_plan_missing");
  const actionType = (
    await db
      .select()
      .from(actionTypes)
      .where(and(eq(actionTypes.orgId, run.orgId), eq(actionTypes.name, "plan_acceptance")))
      .limit(1)
  )[0];
  if (!actionType) throw new Error("plan_acceptance_action_missing");
  const existing = (
    await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.orgId, run.orgId),
          eq(proposals.projectId, run.projectId),
          eq(proposals.runId, run.id),
          eq(proposals.actionTypeId, actionType.id),
        ),
      )
      .limit(1)
  )[0];
  const proposal =
    existing ??
    (
      await db
        .insert(proposals)
        .values({
          id: newId("prop"),
          orgId: run.orgId,
          projectId: run.projectId,
          runId: run.id,
          actionTypeId: actionType.id,
          payload: {
            architectRunId: run.id,
            issueNumber,
            repoId: repo.id,
            receiptSha256: receipt.integrity?.payload_sha256,
          },
          contextMd: plan,
          expiresAt: new Date(Date.now() + actionType.defaultTtlHours * 3_600_000),
        })
        .returning()
    )[0];
  if (!proposal) throw new Error("plan_acceptance_create_failed");
  if (!existing) {
    await db.insert(proposalEvents).values({
      orgId: run.orgId,
      proposalId: proposal.id,
      seq: 1,
      type: "open",
      actor: { type: "agent", id: run.id },
      data: { source: "architect_run" },
    });
  }
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
  if (!installation || installation.suspendedAt) throw new Error("run_installation_unavailable");
  const factory =
    deps?.githubClientFactory ??
    (deps?.config?.githubAppId && deps.config.githubAppPrivateKey
      ? createGithubClientFactory(deps.config)
      : null);
  if (!factory) throw new Error("github_app_unconfigured");
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  const body = renderProgressForRun(run, "succeeded", {
    finalText: plan,
    agentProgress: await lastAgentProgress(db, run),
    proposalId: proposal.id,
  });
  const commentId = progressCommentId(run.gh);
  if (commentId) {
    await client.updateIssueComment(commentId, body);
  } else {
    await client.createIssueComment(issueNumber, body);
  }
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "hitl.proposed",
    target: { type: "proposal", id: proposal.id },
    payload: { action_type: "plan_acceptance", issue: issueNumber },
  });
}

async function publishSecurityFindings(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  report: SecurityReport,
  deps?: FinishRunDeps,
) {
  const repo = await repoForGithubRun(db, run);
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
  if (!installation || installation.suspendedAt) throw new Error("run_installation_unavailable");
  const factory =
    deps?.githubClientFactory ??
    (deps?.config?.githubAppId && deps.config.githubAppPrivateKey
      ? createGithubClientFactory(deps.config)
      : null);
  if (!factory) throw new Error("github_app_unconfigured");
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  const result = await syncSecurityFindings(client, report, { runId: run.id });
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "system", id: "security-finding-sync" },
    action: "github.security_findings.synced",
    target: { type: "run", id: run.id },
    payload: {
      reported: report.findings.length,
      eligible: result.eligible,
      issues: result.synced.map((issue) => ({ number: issue.number, created: issue.created })),
    },
  });
  return result;
}

async function lastAgentProgress(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  const row = (
    await db
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.orgId, run.orgId),
          eq(runEvents.runId, run.id),
          eq(runEvents.type, "agent_progress"),
        ),
      )
      .orderBy(desc(runEvents.seq))
      .limit(1)
  )[0];
  const data = objectOrEmpty(row?.data);
  return typeof data.markdown === "string" && data.markdown.trim() ? data.markdown : null;
}

async function repoForGithubRun(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  const gh = objectOrEmpty(run.gh);
  const owner = stringValue(gh.owner);
  const name = stringValue(gh.repo);
  return (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, run.orgId),
          eq(repos.projectId, run.projectId),
          ...(owner && name ? [eq(repos.owner, owner), eq(repos.name, name)] : []),
        ),
      )
      .orderBy(repos.createdAt)
      .limit(1)
  )[0];
}

async function prepareRunDelivery(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  git: {
    branch?: string;
    headSha?: string;
    changed: boolean;
    pushError?: string;
    pullRequestTitle?: string;
    pullRequestBody?: string;
  },
) {
  if (
    !git.branch ||
    !git.headSha ||
    !git.pullRequestTitle ||
    !git.pullRequestBody ||
    git.pushError
  ) {
    throw new Error("delivery_metadata_invalid");
  }
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
  const issueNumber = numberOrUndefined(gh.issueNumber);
  const mirroredIssue = issueNumber
    ? (
        await db
          .select({ number: ghIssues.number })
          .from(ghIssues)
          .where(and(eq(ghIssues.repoId, repo.id), eq(ghIssues.number, issueNumber)))
          .limit(1)
      )[0]
    : null;
  const pullRequestBody = mirroredIssue
    ? pullRequestBodyForIssue(
        git.pullRequestBody as string,
        issueNumber as number,
        repo.owner,
        repo.name,
      )
    : (git.pullRequestBody as string);
  return {
    runId: run.id,
    orgId: run.orgId,
    projectId: run.projectId,
    repoId: repo.id,
    owner: repo.owner,
    repoName: repo.name,
    headBranch: git.branch,
    expectedHeadSha: git.headSha,
    baseBranch: repo.defaultBranch,
    title: git.pullRequestTitle,
    body: pullRequestBody,
    issueNumber,
    // Use the application clock that will immediately evaluate eligibility.
    // A PostgreSQL default has microsecond precision, while JavaScript Date is
    // millisecond-only and can otherwise make a new row briefly look future-dated.
    nextAttemptAt: new Date(),
  } satisfies typeof runDeliveries.$inferInsert;
}

export class RunDeliveryBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RunDeliveryBlockedError";
  }
}

export class RunDeliveryLeaseLostError extends Error {
  constructor() {
    super("run_delivery_lease_lost");
    this.name = "RunDeliveryLeaseLostError";
  }
}

export async function publishRunDelivery(
  db: ReturnType<typeof createDb>["db"],
  delivery: typeof runDeliveries.$inferSelect,
  deps: FinishRunDeps & { config: AppConfig },
) {
  const run = (
    await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, delivery.runId),
          eq(runs.orgId, delivery.orgId),
          eq(runs.projectId, delivery.projectId),
        ),
      )
      .limit(1)
  )[0];
  if (run?.status !== "succeeded") {
    throw new RunDeliveryBlockedError("run_scope_or_status_mismatch");
  }
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.id, delivery.repoId),
          eq(repos.orgId, delivery.orgId),
          eq(repos.projectId, delivery.projectId),
        ),
      )
      .limit(1)
  )[0];
  if (!repo) throw new RunDeliveryBlockedError("repo_scope_mismatch");
  if (
    repo.owner !== delivery.owner ||
    repo.name !== delivery.repoName ||
    repo.defaultBranch !== delivery.baseBranch
  ) {
    throw new RunDeliveryBlockedError("repo_binding_mismatch");
  }
  if (!repo.installationId) throw new RunDeliveryBlockedError("run_repo_missing_installation");
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, delivery.orgId),
          eq(githubInstallations.id, repo.installationId),
        ),
      )
      .limit(1)
  )[0];
  if (!installation) throw new RunDeliveryBlockedError("run_installation_missing");
  if (installation.suspendedAt) {
    throw new RunDeliveryBlockedError("run_installation_suspended");
  }
  const factory =
    deps.githubClientFactory ??
    (deps.config.githubAppId && deps.config.githubAppPrivateKey
      ? createGithubClientFactory(deps.config)
      : null);
  if (!factory) throw new Error("github_app_unconfigured");
  const client = new FacilityGithubClient(await factory(installation.installationId), {
    owner: repo.owner,
    repo: repo.name,
    defaultBranch: repo.defaultBranch,
  });
  let remoteHead: string;
  try {
    remoteHead = await client.getRef(delivery.headBranch);
  } catch (refError) {
    if (githubStatus(refError) === 404) {
      throw new RunDeliveryBlockedError("head_branch_missing");
    }
    throw refError;
  }
  if (remoteHead !== delivery.expectedHeadSha) {
    throw new RunDeliveryBlockedError("head_sha_mismatch");
  }

  const gh = objectOrEmpty(run.gh);
  const storedPrNumber = numberOrUndefined(objectOrEmpty(gh.pr).number);
  let pr: { number: number; url: string; headRef: string; headSha: string; baseRef: string };
  if (storedPrNumber) {
    pr = await client.getPullRequestDeliveryRef(storedPrNumber);
    assertDeliveryPullRequest(pr, delivery);
  } else {
    const open = await client.listOpenPullRequestsForHead(delivery.headBranch, delivery.baseBranch);
    const exact = open.find(
      (candidate) =>
        candidate.headRef === delivery.headBranch &&
        candidate.baseRef === delivery.baseBranch &&
        candidate.headSha === delivery.expectedHeadSha,
    );
    const drifted = open.find(
      (candidate) =>
        candidate.headRef === delivery.headBranch && candidate.baseRef === delivery.baseBranch,
    );
    if (exact) pr = exact;
    else if (drifted) throw new RunDeliveryBlockedError("existing_pr_head_sha_mismatch");
    else {
      try {
        const created = await client.createPullRequest({
          head: delivery.headBranch,
          base: delivery.baseBranch,
          title: delivery.title,
          body: delivery.body,
          draft: true,
        });
        pr = await client.getPullRequestDeliveryRef(created.number);
        assertDeliveryPullRequest(pr, delivery);
      } catch (createError) {
        if (githubStatus(createError) !== 422) throw createError;
        const afterConflict = await client.listOpenPullRequestsForHead(
          delivery.headBranch,
          delivery.baseBranch,
        );
        const adopted = afterConflict.find(
          (candidate) =>
            candidate.headRef === delivery.headBranch &&
            candidate.baseRef === delivery.baseBranch &&
            candidate.headSha === delivery.expectedHeadSha,
        );
        if (!adopted) throw new RunDeliveryBlockedError("github_pr_validation_failed");
        pr = adopted;
      }
    }
  }

  await db.transaction(async (tx) => {
    const fresh = (
      await tx
        .select({ gh: runs.gh })
        .from(runs)
        .where(
          and(
            eq(runs.id, delivery.runId),
            eq(runs.orgId, delivery.orgId),
            eq(runs.projectId, delivery.projectId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (!fresh) throw new RunDeliveryBlockedError("run_scope_mismatch");
    const finalized = await tx
      .update(runDeliveries)
      .set({
        status: "delivered",
        prNumber: pr.number,
        prUrl: pr.url,
        blockedReason: null,
        error: null,
        deliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runDeliveries.runId, delivery.runId),
          eq(runDeliveries.orgId, delivery.orgId),
          eq(runDeliveries.projectId, delivery.projectId),
          eq(runDeliveries.status, "delivering"),
          eq(runDeliveries.updatedAt, delivery.updatedAt),
        ),
      )
      .returning({ runId: runDeliveries.runId });
    if (!finalized.length) throw new RunDeliveryLeaseLostError();
    await tx
      .update(runs)
      .set({
        gh: {
          ...objectOrEmpty(fresh.gh),
          branch: delivery.headBranch,
          headSha: delivery.expectedHeadSha,
          pr: { number: pr.number, url: pr.url },
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runs.id, delivery.runId),
          eq(runs.orgId, delivery.orgId),
          eq(runs.projectId, delivery.projectId),
        ),
      );
    await tx
      .insert(outcomes)
      .values({
        id: newId("evt"),
        orgId: delivery.orgId,
        projectId: delivery.projectId,
        runId: delivery.runId,
        repo: `${repo.owner}/${repo.name}`,
        prNumber: pr.number,
        agentLane: run.engine,
        openedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [outcomes.orgId, outcomes.repo, outcomes.prNumber],
        set: { runId: delivery.runId, updatedAt: new Date() },
      });
  });

  const githubLogin = githubLoginForRun(run);
  let assignmentSkipReason: string | null = null;
  if (githubLogin) {
    try {
      const assigned = await client.assignIssue(pr.number, githubLogin);
      if (!assigned) assignmentSkipReason = "github_rejected";
    } catch (error) {
      assignmentSkipReason = errorMessage(error);
    }
  } else {
    const createdBy = objectOrEmpty(run.createdBy);
    if (createdBy.type === "user" || createdBy.type === "github") {
      assignmentSkipReason = "missing_github_login";
    }
  }
  if (assignmentSkipReason) {
    await recordGithubAssignmentSkipped(
      db,
      run,
      pr.number,
      githubLogin,
      assignmentSkipReason,
    ).catch(() => undefined);
  }
  if (delivery.issueNumber) {
    // New platform-lane runs have a live progress comment that is updated at
    // the terminal transition. Keep a short fallback for older/manual runs.
    if (!progressCommentId(run.gh)) {
      await client
        .createIssueComment(delivery.issueNumber, `Facility opened PR #${pr.number}: ${pr.url}`)
        .catch(() => undefined);
    }
  }
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "github.pr.created",
    target: { type: "run", id: run.id },
    payload: { runId: run.id, branch: delivery.headBranch, pr, draft: true },
  }).catch(() => undefined);
  await requestConfiguredPreview(
    db,
    run,
    repo,
    pr.number,
    delivery.expectedHeadSha,
    client,
    deps,
  ).catch(async (error) => {
    const message = errorMessage(error);
    await raisePlatformIssue(db, {
      orgId: run.orgId,
      projectId: run.projectId,
      kind: "preview_request_failed",
      severity: "error",
      fingerprint: `preview_request_failed:${run.id}`,
      title: "Failed to request the configured protected preview",
      bodyMd: `Run ${run.id} delivered PR #${pr.number}, but Facility could not request its SSO-protected preview.\n\n${message}`,
    }).catch(() => undefined);
  });
  await updateGithubRunProgress(db, run.id, "succeeded", deps).catch(() => undefined);
  await resolvePlatformIssue(
    db,
    run.orgId,
    `pr_delivery_pending:${run.id}`,
    `Pull request #${pr.number} was delivered successfully`,
    { projectId: run.projectId },
  ).catch(() => undefined);
  return pr;
}

function assertDeliveryPullRequest(
  pr: { headRef: string; headSha: string; baseRef: string },
  delivery: typeof runDeliveries.$inferSelect,
) {
  const mismatch = runDeliveryRefMismatch(pr, delivery);
  if (mismatch) throw new RunDeliveryBlockedError(mismatch);
}

export function runDeliveryRefMismatch(
  actual: { headRef: string; headSha: string; baseRef: string },
  expected: { headBranch: string; expectedHeadSha: string; baseBranch: string },
) {
  if (actual.headRef !== expected.headBranch || actual.baseRef !== expected.baseBranch) {
    return "pull_request_ref_mismatch";
  }
  if (actual.headSha !== expected.expectedHeadSha) return "pull_request_head_sha_mismatch";
  return null;
}

function githubStatus(error: unknown) {
  const status = objectOrEmpty(error).status;
  return typeof status === "number" ? status : undefined;
}

function githubLoginForRun(run: RunRow) {
  const trigger = objectOrEmpty(run.trigger);
  if (typeof trigger.githubLogin === "string" && trigger.githubLogin) return trigger.githubLogin;
  const createdBy = objectOrEmpty(run.createdBy);
  if (createdBy.type !== "github") return null;
  if (typeof createdBy.id === "string" && createdBy.id) return createdBy.id;
  return typeof createdBy.login === "string" && createdBy.login ? createdBy.login : null;
}

async function recordGithubAssignmentSkipped(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  pullNumber: number,
  login: string | null,
  reason: string,
) {
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "github.assignment.skipped",
    target: { type: "pull_request", id: String(pullNumber) },
    payload: { runId: run.id, pullNumber, login, reason },
  });
}

async function recordRunPullRequestUpdate(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  branch: string,
  headSha?: string,
) {
  const gh = objectOrEmpty(run.gh);
  const expectedBranch = stringValue(gh.branch);
  if (!expectedBranch || branch !== expectedBranch) throw new Error("delivery_branch_mismatch");
  await db
    .update(runs)
    .set({ gh: { ...gh, branch, ...(headSha ? { headSha } : {}) }, updatedAt: new Date() })
    .where(and(eq(runs.orgId, run.orgId), eq(runs.id, run.id)));
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "github.pr.updated",
    target: { type: "run", id: run.id },
    payload: {
      runId: run.id,
      branch,
      headSha: headSha ?? null,
      pullRequest: numberOrUndefined(gh.issueNumber) ?? null,
    },
  });
}

async function requestConfiguredPreview(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  repo: typeof repos.$inferSelect,
  prNumber: number,
  commitSha: string | undefined,
  github: FacilityGithubClient,
  deps?: FinishRunDeps,
) {
  const answers = objectOrEmpty(repo.renderAnswers);
  const preview = objectOrEmpty(answers.preview);
  if (preview.enabled !== true) return;
  const config = deps?.config;
  if (!config) throw new Error("preview_platform_config_unavailable");
  assertPreviewProvisioningAvailable(config);
  if (!deps.enqueue) throw new Error("preview_queue_unavailable");
  const configuredImage = stringValue(preview.image);
  const port = numberOrUndefined(preview.port);
  if (!configuredImage || !port) throw new Error("preview_configuration_invalid");
  const image = previewImageForCommit(configuredImage, commitSha);
  const command = Array.isArray(preview.command)
    ? preview.command.filter((part): part is string => typeof part === "string")
    : undefined;
  const ttlHours = numberOrUndefined(preview.ttlHours) ?? 24;
  const readinessPath = stringValue(preview.readinessPath);
  const created = await createPreviewRecord(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    repoId: repo.id,
    runId: run.id,
    prNumber,
    commitSha,
    image,
    command,
    port,
    readinessPath,
    ttlHours: Math.min(168, ttlHours),
    driver: config.sandboxDriver,
    createdBy: { type: "agent", id: run.id },
  });
  if (!created) throw new Error("preview_record_create_failed");
  await deps.enqueue("previews.provision", { previewId: created.id });
  const previewUrl = previewAccessUrl(config, created.projectId, created.id);
  await github
    .createIssueComment(
      prNumber,
      `Facility protected preview requested: ${previewUrl}\n\nAccess requires your organization SSO session.`,
    )
    .catch(() => undefined);
  await insertAuditEvent(db, {
    orgId: run.orgId,
    projectId: run.projectId,
    actor: { type: "agent", id: run.id },
    action: "preview.requested",
    target: { type: "preview", id: created.id },
    payload: { runId: run.id, repoId: repo.id, prNumber, commitSha, auth_mode: "facility_session" },
  });
}

function previewImageForCommit(image: string, commitSha: string | undefined) {
  if (!commitSha) return image;
  return image
    .replace(/\$\{\{\s*steps\.delivery\.outputs\.head_sha\s*\}\}/g, commitSha)
    .replace(/\{\{\s*commit_sha\s*\}\}/g, commitSha);
}

export async function cancelRun(config: AppConfig, run: RunRow) {
  const sandbox = readSandbox(run.sandbox);
  let destroyed = false;
  if (sandbox.driver && sandbox.ref) {
    const driver = await sandboxDriver(sandbox.driver);
    await driver.stop(sandbox.ref).catch(() => undefined);
    destroyed = await driver
      .destroy(sandbox.ref)
      .then(() => true)
      .catch(() => false);
  }
  const { db, client } = createDb(config.databaseUrl);
  try {
    if (destroyed) await markSandboxDestroyed(db, run.id);
    await revokeRunKeys(db, sandbox);
    await updateGithubRunProgress(db, run.id, "canceled", { config }).catch(() => undefined);
  } finally {
    await client.end();
  }
}

const HARNESS_AGENT_PERMS = ["kb:read", "kb:write", "tasks:read", "tasks:write"];

// A run-scoped platform key may only ever carry these resources, no matter what
// an agent def declares. Destructive / tenant-admin scopes (members, roles,
// keys, providers, org, budget writes, audit envelopes) are NEVER run-mintable —
// so a compromised agent or an over-broad agent def can't escalate the tenant.
const RUN_SAFE_RESOURCES = new Set([
  "kb",
  "tasks",
  "hitl",
  "runs",
  "issues",
  "registry",
  "spend",
  "analytics",
  "sessions",
]);

/** Intersect an agent def's declared permissions with the run-safe ceiling. */
export function runSafePermissions(agentPermissions: string[], harnessEnabled = false): string[] {
  const safe = new Set<string>();
  for (const perm of agentPermissions) {
    if (perm === "*") continue; // wildcard is never run-mintable
    const [resource, action] = perm.split(":");
    if (!resource || !action) continue;
    if (!RUN_SAFE_RESOURCES.has(resource)) continue;
    // A run key gets kb/tasks read+write but only write-forward on hitl (propose,
    // never decide) — a run must not approve its own gate.
    if (resource === "hitl" && !["read", "write"].includes(action)) continue;
    safe.add(perm);
  }
  // Back-compat floor only for an explicitly harness-enabled agent. A builder
  // or custom agent with no declared permissions must not silently receive KB
  // read/write access merely because the project has a KB space.
  if (safe.size === 0 && harnessEnabled) return [...HARNESS_AGENT_PERMS];
  return [...safe].sort();
}

/**
 * Idempotently ensure the run-scoped role for an agent's clamped permission set.
 * Keyed by the permission fingerprint so distinct sets get distinct roles and an
 * edit to an agent's permissions takes effect on its next run — while identical
 * sets are deduped (no role-table churn per run).
 */
async function ensureRunAgentRole(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
  agentPermissions: string[],
  harnessEnabled: boolean,
): Promise<string> {
  const permissions = runSafePermissions(agentPermissions, harnessEnabled);
  const fingerprint = permissions.join(",") || "none";
  const name = `run-agent:${fingerprint}`;
  const existing = (
    await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const id = newId("key");
  await db
    .insert(roles)
    .values({
      id,
      orgId,
      name,
      description: "Run-scoped agent key (permissions clamped to the run-safe ceiling).",
      permissions,
    })
    .onConflictDoNothing();
  const row = (
    await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)))
      .limit(1)
  )[0];
  return row?.id ?? id;
}

export async function reconcileSandboxes(
  config: AppConfig,
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<unknown>,
) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    // Dispatch-loss backstop: run rows are committed BEFORE their pg-boss
    // enqueue (route + scheduler style), so a broker outage at that instant
    // strands a run in "queued" forever. Re-enqueue anything queued for >5
    // minutes — dispatchRun claims atomically, so duplicate deliveries are safe.
    if (enqueue) {
      const stuck = await db
        .select({ id: runs.id, orgId: runs.orgId })
        .from(runs)
        .where(and(eq(runs.status, "queued"), sql`${runs.queuedAt} < now() - interval '5 minutes'`))
        .limit(20);
      for (const run of stuck) {
        await enqueue("runs.dispatch", { runId: run.id, orgId: run.orgId }).catch(() => undefined);
      }
    }
    // The orphan-container sweep is docker-specific. Skip it gracefully when the
    // daemon isn't reachable (e.g. an aws-driver deployment has no local Docker)
    // so the driver-agnostic reconciliation below — timeout cost-cap backstop and
    // the orphaned-key sweep — still runs instead of the whole tick throwing.
    try {
      const docker = new DockerSandboxDriver();
      for (const container of await docker.listFacilityContainers(sandboxNamespace(config))) {
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
        // In-process assistant turns have no sandbox driver. They remain live
        // until an operator or policy boundary terminates them.
        if (sandbox.inline === true) {
          continue;
        }
        if (!sandbox.driver || !sandbox.ref) continue;
        const driver = await sandboxDriver(sandbox.driver);
        const status = await driver.status(sandbox.ref);
        if (status === "exited" || status === "lost") {
          await failRun(db, run.orgId, run.id, "sandbox_lost", "sandbox_lost");
          await updateGithubRunProgress(db, run.id, "failed", { config }).catch(() => undefined);
        }
      } catch {
        // Driver unreachable for this run; leave it for the next tick.
      }
    }

    // A provider delete can fail transiently after the terminal run state has
    // already committed (or the API can restart between those two operations).
    // Retry every unconfirmed terminal cleanup here. The durable marker makes
    // successful deletes one-shot while preserving idempotent recovery across
    // Docker, CodeBuild, and Vercel providers.
    const pendingTerminalCleanup = await db
      .select({ id: runs.id, sandbox: runs.sandbox })
      .from(runs)
      .where(
        and(
          inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
          sql`${runs.sandbox}->>'driver' is not null`,
          sql`${runs.sandbox}->>'ref' is not null`,
          sql`coalesce(${runs.sandbox}->>'lastStatus', '') <> 'destroyed'`,
        ),
      )
      .limit(20);
    for (const run of pendingTerminalCleanup) {
      try {
        const sandbox = readSandbox(run.sandbox);
        if (!sandbox.driver || !sandbox.ref) continue;
        const driver = await sandboxDriver(sandbox.driver);
        await driver.destroy(sandbox.ref);
        await markSandboxDestroyed(db, run.id);
      } catch {
        // A transient provider failure stays unmarked and retries next tick.
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
  // Clone the repo the run is ACTUALLY about: an issue/resume trigger records it
  // in run.gh (owner/repo). Only fall back to the project's oldest repo when the
  // trigger carries none — never an arbitrary first-repo pick, which would clone
  // repo A for an issue in repo B (and then finishRun would open the PR in B).
  const runGh = objectOrEmpty(run.gh);
  const ghOwner = typeof runGh.owner === "string" ? runGh.owner : null;
  const ghRepoName = typeof runGh.repo === "string" ? runGh.repo : null;
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
  const rawContract = await activeRegistryContent(db, run.orgId, agent.contractItemId);
  const skills = await activeSkills(db, run.orgId, run.projectId);
  const space = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, run.orgId), eq(kbSpaces.projectId, run.projectId)))
      .limit(1)
  )[0];
  const timeoutMin = resourceNumber(profile.resources, "timeout_min", 60);
  const { packageInstallCmd, provisionCmd } = resolveProvisioningCommands(
    profile,
    repo?.renderAnswers,
  );
  const checkCmds = resolveCheckCmds(profile, repo?.renderAnswers, project?.settings);
  const provisionSummary = [packageInstallCmd, provisionCmd].filter(Boolean).join(" && ") || null;
  const contract = renderRunContract(rawContract, provisionSummary, checkCmds);
  const githubBranch = typeof runGh.branch === "string" ? runGh.branch : null;
  const checkoutBranch = githubPullRequestMode(run.mode) && githubBranch ? githubBranch : null;
  const expectedHeadSha = repairExpectedHeadSha(run.mode, run.trigger);
  if (run.mode.replace(/^codex-/, "").replace(/-/g, "_") === "ci_doctor" && !expectedHeadSha) {
    throw new Error("ci_doctor_admitted_head_missing");
  }
  // Point the agent CLIs directly at the gateway service. Anthropic's SDK
  // appends /v1/messages, while Codex appends /responses to a provider base
  // URL that must already include /v1.
  const gatewayBase = config.sandboxGatewayUrl.replace(/\/$/, "");
  const engine = normalizeEngine(agent.engine || run.engine);
  const anthropicCredential =
    engine === "claude_code"
      ? (
          await db
            .select({ authMode: providerCredentials.authMode })
            .from(providerCredentials)
            .where(
              and(
                eq(providerCredentials.orgId, run.orgId),
                eq(providerCredentials.provider, "anthropic"),
              ),
            )
            .orderBy(providerCredentials.createdAt, providerCredentials.id)
            .limit(1)
        )[0]
      : undefined;
  const bundle: RunBundle = {
    runId: run.id,
    mode: run.mode,
    engine,
    contract,
    skills,
    engineConfig: resolveRepoEngineConfig(agent.name, agent.model, repo?.renderAnswers, engine),
    repo: repo
      ? {
          cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
          branch: checkoutBranch ?? repo.defaultBranch,
          expectedHeadSha,
          installationTokenRef: repo.installationId,
        }
      : { cloneUrl: null, branch: null, expectedHeadSha: null, installationTokenRef: null },
    packageInstallCmd,
    provisionCmd,
    // Acceptance gates: a sandbox profile's setup.check_cmds is an explicit
    // platform-level override; otherwise fall back to the project's own configured
    // checks (projects.settings.check_cmds — what kickstart detects, the web project
    // page shows, and the repo lane runs), so gates configured for a project also
    // run in the platform lane instead of silently doing nothing.
    checkCmds,
    gatewayUrls: {
      anthropic: `${gatewayBase}/anthropic`,
      openai: `${gatewayBase}/openai/v1`,
    },
    ...(engine === "claude_code"
      ? { anthropicAuthMode: anthropicCredential?.authMode === "oauth" ? "oauth" : "api_key" }
      : {}),
    scope: objectOrEmpty(run.trigger),
    timeoutMin,
    harness: harnessFragmentForBundle({
      space,
      harnessItemId: agent.harnessItemId,
      runId: run.id,
      mode: run.mode,
    }),
  };
  const resume = await resumeForRun(db, run);
  if (resume) bundle.resume = resume;
  return { bundle, profile, agentPermissions: agent.permissions ?? [] };
}

async function resumeForRun(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  const trigger = objectOrEmpty(run.trigger);
  if (trigger.type === "resume") {
    const parentId = typeof trigger.resumeOf === "string" ? trigger.resumeOf : undefined;
    if (!parentId) return null;
    const parent = await loadResumeParent(db, run, parentId);
    if (!parent?.engineSessionId) return null;
    return {
      sessionId: parent.engineSessionId,
      sessionStateFrom: parent.id,
      prompt: resumePrompt(trigger),
      ...resumeFallbackScope(parent),
      ...resumeBranch(parent),
    };
  }
  if (trigger.type === "conversation") {
    const conversationId =
      typeof trigger.conversationId === "string" ? trigger.conversationId : undefined;
    if (!conversationId) return null;
    const conversation = (
      await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.orgId, run.orgId),
            eq(conversations.projectId, run.projectId),
            run.agentDefId ? eq(conversations.agentDefId, run.agentDefId) : sql`false`,
            eq(conversations.id, conversationId),
          ),
        )
        .limit(1)
    )[0];
    const parentId =
      typeof trigger.resumeOf === "string" ? trigger.resumeOf : conversation?.lastRunId;
    if (!conversation?.engineSessionId || !parentId) return null;
    const parent = await loadResumeParent(db, run, parentId);
    if (!parent) return null;
    return {
      sessionId: conversation.engineSessionId,
      sessionStateFrom: parent.id,
      prompt: resumePrompt(trigger),
      ...resumeFallbackScope(parent),
      ...resumeBranch(parent),
    };
  }
  return null;
}

async function loadResumeParent(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  parentId: string,
) {
  const parent = (
    await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, run.orgId),
          eq(runs.projectId, run.projectId),
          run.agentDefId ? eq(runs.agentDefId, run.agentDefId) : isNull(runs.agentDefId),
          eq(runs.id, parentId),
        ),
      )
      .limit(1)
  )[0];
  return parent ?? null;
}

function resumePrompt(trigger: Record<string, unknown>) {
  const message = trigger.message;
  return typeof message === "string" && message.trim() ? message : "Continue where you left off.";
}

export function boundedResumeFallbackScope(value: unknown): Record<string, unknown> | undefined {
  const scope = objectOrEmpty(value);
  try {
    return Buffer.byteLength(JSON.stringify(scope)) <= RESUME_FALLBACK_SCOPE_MAX_BYTES
      ? scope
      : undefined;
  } catch {
    return undefined;
  }
}

function resumeFallbackScope(parent: RunRow) {
  const fallbackScope = boundedResumeFallbackScope(
    resumeFallbackScopeValue(parent.trigger, parent.sandbox),
  );
  return fallbackScope ? { fallbackScope } : {};
}

export function resumeFallbackScopeValue(trigger: unknown, sandbox: unknown) {
  return readSandbox(sandbox).bundle?.resume?.fallbackScope ?? trigger;
}

function resumeBranch(parent: RunRow) {
  const gh = objectOrEmpty(parent.gh);
  return typeof gh.branch === "string" && gh.branch.trim() ? { branch: gh.branch } : {};
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
export async function revokeRunKeys(
  db: ReturnType<typeof createDb>["db"],
  sandbox: RunSandboxState,
) {
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

async function markSandboxDestroyed(db: ReturnType<typeof createDb>["db"], runId: string) {
  await db
    .update(runs)
    .set({
      sandbox: sql`${runs.sandbox} || ${JSON.stringify({
        lastStatus: "destroyed",
        destroyedAt: new Date().toISOString(),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(runs.id, runId));
}

export async function failRun(
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
    .returning({ projectId: runs.projectId, sandbox: runs.sandbox, trigger: runs.trigger });
  if (!failed) return; // already terminal — another path handled it.
  // Reclaim the run's credentials + sandbox so a failed run can't keep calling
  // the gateway or the platform API.
  await revokeRunKeys(db, readSandbox(failed.sandbox));
  // A conversation turn holds its thread's "running" lock (new messages are
  // rejected while running). If the run failed BEFORE finishRun could release it
  // (bad image, provisioning error), the thread would deadlock forever — so free
  // it here too, recording the failure as the agent turn.
  await releaseConversationOnFailure(db, orgId, runId, failed.trigger, message).catch(
    () => undefined,
  );
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

/** Free a conversation's turn lock when its run failed before finishRun ran. */
async function releaseConversationOnFailure(
  db: ReturnType<typeof createDb>["db"],
  orgId: string,
  runId: string,
  trigger: unknown,
  message: string,
) {
  const t = objectOrEmpty(trigger);
  if (t.type !== "conversation") return;
  const conversationId = typeof t.conversationId === "string" ? t.conversationId : undefined;
  if (!conversationId) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);
    // Only release a thread still pinned to THIS run's turn — never clobber a
    // newer turn or a normal idle state.
    const conversation = (
      await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)))
        .limit(1)
    )[0];
    // Release ONLY a thread pinned to THIS run's turn and still running — never
    // a foreign conversation (forged trigger) or a newer turn.
    if (conversation?.status !== "running" || conversation.lastRunId !== runId) return;
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(seq), 0)` })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
    const seq = Number(rows[0]?.max ?? 0) + 1;
    await tx.insert(conversationMessages).values({
      id: newId("evt"),
      orgId,
      conversationId,
      seq,
      role: "system",
      body: `Turn failed: ${message}`,
      runId,
    });
    await tx
      .update(conversations)
      .set({ status: "idle", updatedAt: new Date() })
      .where(and(eq(conversations.orgId, orgId), eq(conversations.id, conversationId)));
  });
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
      count(*) filter (where type = 'check')::int as check_count,
      count(*) filter (where type = 'assistant')::int as turns,
      count(*) filter (where type = 'tool')::int as tool_calls,
      count(*) filter (
        where type = 'tool'
          and lower(coalesce(data->>'name', '')) in ('bash', 'shell', 'exec_command', 'terminal')
      )::int as shell_commands,
      count(*) filter (
        where type = 'tool'
          and lower(coalesce(data->>'name', '')) like '%mcp%'
      )::int as mcp_tool_calls,
      count(*) filter (
        where type = 'tool'
          and lower(coalesce(data->>'name', '')) in ('web_search', 'websearch', 'search_query')
      )::int as web_searches,
      count(*) filter (where type in ('artifact_error', 'engine_error'))::int as errors
    from run_events
    where run_id = ${runId}
  `);
  const checkEvents = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "check")))
    .orderBy(runEvents.seq)
    .limit(200);
  const eventRow = (
    events as unknown as Array<{
      event_count: number;
      check_count: number;
      turns: number;
      tool_calls: number;
      shell_commands: number;
      mcp_tool_calls: number;
      web_searches: number;
      errors: number;
    }>
  )[0];
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    cacheRead: Number(usage?.cacheRead ?? 0),
    cacheWrite: Number(usage?.cacheWrite ?? 0),
    costCents: Number(usage?.costCents ?? 0),
    eventCount: Number(eventRow?.event_count ?? 0),
    checkCount: Number(eventRow?.check_count ?? 0),
    activity: {
      turns: Number(eventRow?.turns ?? 0),
      shell_commands: Number(eventRow?.shell_commands ?? 0),
      mcp_tool_calls: Number(eventRow?.mcp_tool_calls ?? 0),
      web_searches: Number(eventRow?.web_searches ?? 0),
      tool_calls: Number(eventRow?.tool_calls ?? 0),
      errors: Number(eventRow?.errors ?? 0),
    },
    checks: checkEvents.map(({ data }) => receiptCheck(data)),
  };
}

async function canonicalRunReceipt(
  db: ReturnType<typeof createDb>["db"],
  run: RunRow,
  runnerReceipt: Record<string, unknown> | undefined,
  aggregate: Awaited<ReturnType<typeof gatewayAggregate>>,
  status: "succeeded" | "failed" | "canceled",
): Promise<FacilityReceipt> {
  const runner = objectOrEmpty(runnerReceipt);
  const runnerTiming = objectOrEmpty(runner.timing);
  const runnerActivity = objectOrEmpty(runner.activity);
  const gh = objectOrEmpty(run.gh);
  const endedAt = new Date();
  const startedAt = run.startedAt ?? run.queuedAt;
  const receipt = FacilityReceiptSchema.parse({
    schema: "facility.run.v1",
    run_id: run.id,
    project_id: run.projectId,
    agent_id: run.agentDefId ?? undefined,
    provider: receiptProvider(run.engine),
    model: stringValue(runner.model),
    mode: receiptMode(run.mode),
    result: status,
    usage: {
      input_tokens: aggregate.inputTokens,
      output_tokens: aggregate.outputTokens,
      cache_read: aggregate.cacheRead,
      cache_write: aggregate.cacheWrite,
      cost_cents: aggregate.costCents,
      cost_source: "gateway",
    },
    activity: {
      turns: Math.max(aggregate.activity.turns, nonnegativeInt(runnerActivity.turns)),
      shell_commands: Math.max(
        aggregate.activity.shell_commands,
        nonnegativeInt(runnerActivity.shell_commands),
      ),
      file_changes: nonnegativeInt(runnerActivity.file_changes),
      mcp_tool_calls: Math.max(
        aggregate.activity.mcp_tool_calls,
        nonnegativeInt(runnerActivity.mcp_tool_calls),
      ),
      web_searches: Math.max(
        aggregate.activity.web_searches,
        nonnegativeInt(runnerActivity.web_searches),
      ),
      tool_calls: Math.max(
        aggregate.activity.tool_calls,
        nonnegativeInt(runnerActivity.tool_calls),
      ),
      errors: Math.max(
        aggregate.activity.errors + (status === "failed" ? 1 : 0),
        nonnegativeInt(runnerActivity.errors),
      ),
    },
    github: {
      owner: stringValue(gh.owner),
      repo: stringValue(gh.repo),
      issue: integerValue(gh.issueNumber),
      pr: integerValue(objectOrEmpty(gh.pr).number),
    },
    timing: {
      started_at: stringValue(runnerTiming.started_at) ?? startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    },
    events: { count: aggregate.eventCount, checks: aggregate.checkCount },
    checks: aggregate.checks,
    checks_truncated: aggregate.checkCount > aggregate.checks.length,
  });
  return sealFacilityReceipt(receipt, await previousReceiptDigest(db, run));
}

async function previousReceiptDigest(db: ReturnType<typeof createDb>["db"], run: RunRow) {
  const candidates = await db
    .select({ receipt: runs.receipt })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, run.orgId),
        eq(runs.projectId, run.projectId),
        sql`${runs.id} <> ${run.id}`,
        sql`${runs.receipt} is not null`,
      ),
    )
    .orderBy(desc(runs.endedAt))
    .limit(100);
  for (const candidate of candidates) {
    const parsed = FacilityReceiptSchema.safeParse(candidate.receipt);
    if (parsed.success && verifyFacilityReceipt(parsed.data)) {
      return parsed.data.integrity?.payload_sha256 ?? null;
    }
  }
  return null;
}

export function platformDeliveryFailure(
  run: Pick<RunRow, "mode" | "gh">,
  git:
    | {
        branch?: string;
        headSha?: string;
        changed: boolean;
        pushError?: string;
        pullRequestTitle?: string;
        pullRequestBody?: string;
      }
    | undefined,
) {
  if (readOnlyRepositoryMode(run.mode) && git?.changed) return "repository_changes_not_allowed";
  if (repairPullRequestMode(run.mode)) {
    if (!git?.changed) return null;
    if (git.pushError) return "delivery_push_failed";
    if (!git.branch) return "delivery_branch_missing";
    if (!git.headSha) return "delivery_commit_missing";
    const expectedBranch = stringValue(objectOrEmpty(run.gh).branch);
    if (!expectedBranch || git.branch !== expectedBranch) return "delivery_branch_mismatch";
    return null;
  }
  if (!isBuilderMode(run.mode)) {
    return git?.changed ? "repository_changes_not_allowed" : null;
  }
  if (!git?.changed) return "delivery_no_changes";
  if (git.pushError) return "delivery_push_failed";
  if (!git.branch) return "delivery_branch_missing";
  if (!git.headSha) return "delivery_commit_missing";
  if (!git.pullRequestTitle) return "delivery_pr_title_missing";
  if (!git.pullRequestBody) return "delivery_pr_body_missing";
  return null;
}

function isBuilderMode(mode: string) {
  return mode === "builder" || mode.endsWith("-builder");
}

function isArchitectMode(mode: string) {
  return mode === "architect" || mode.endsWith("-architect");
}

function isSecurityMode(mode: string) {
  return ["security", "security_sweep"].includes(mode.replace(/^codex-/, "").replace(/-/g, "_"));
}

function repairPullRequestMode(mode: string) {
  return ["address_review", "ci_doctor"].includes(mode.replace(/^codex-/, "").replace(/-/g, "_"));
}

export function repairExpectedHeadSha(mode: string, trigger: unknown) {
  if (!repairPullRequestMode(mode)) return null;
  const runTrigger = objectOrEmpty(trigger);
  return (
    stringValue(objectOrEmpty(runTrigger.ciDoctor).admittedHeadSha) ||
    stringValue(objectOrEmpty(runTrigger.pullRequest).headSha) ||
    null
  );
}

function readOnlyRepositoryMode(mode: string) {
  return ["architect", "review", "security_sweep"].includes(
    mode.replace(/^codex-/, "").replace(/-/g, "_"),
  );
}

function githubPullRequestMode(mode: string) {
  return ["review", "address_review", "ci_doctor"].includes(mode.replace(/-/g, "_"));
}

function receiptProvider(engine: string): FacilityReceipt["provider"] {
  if (engine === "claude" || engine === "claude_code") return "claude_code";
  if (engine === "codex" || engine === "codex_cli") return "codex_cli";
  return "byo";
}

function receiptMode(mode: string): FacilityReceipt["mode"] {
  const normalized = mode.replace(/^codex-/, "").replace(/-/g, "_");
  if (normalized === "doctor") return "ci_doctor";
  if (normalized === "security") return "security_sweep";
  if (normalized === "project_owner") return "po";
  if (
    [
      "architect",
      "builder",
      "review",
      "address_review",
      "ci_doctor",
      "security_sweep",
      "po",
      "learning",
    ].includes(normalized)
  ) {
    return normalized as FacilityReceipt["mode"];
  }
  return "custom";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function integerValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function nonnegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function receiptCheck(value: unknown) {
  const data = objectOrEmpty(value);
  const rawStatus = typeof data.status === "string" ? data.status.trim().toLowerCase() : "unknown";
  const status = ["passed", "failed", "skipped"].includes(rawStatus) ? rawStatus : "unknown";
  const rawName = typeof data.command === "string" ? data.command : data.name;
  return {
    name: typeof rawName === "string" && rawName.trim() ? rawName : "unnamed check",
    status,
    source: data.self_reported === false ? "platform" : "agent",
    ...(typeof data.exit_code === "number" && Number.isInteger(data.exit_code)
      ? { exit_code: data.exit_code }
      : {}),
  };
}

function normalizeDriver(value: string): SandboxDriverName {
  if (value === "aws") return "aws";
  if (value === "vercel") return "vercel";
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
export function resolveCheckCmds(
  profile: { setup: unknown },
  renderAnswers: unknown,
  projectSettings: unknown,
): string[] {
  const profileChecks = arrayField(profile.setup, "check_cmds");
  if (profileChecks.length > 0) return profileChecks;
  const answers = objectOrEmpty(renderAnswers);
  if (Object.hasOwn(answers, "checkCmds")) return arrayField(answers, "checkCmds");
  if (Object.hasOwn(answers, "check_cmds")) return arrayField(answers, "check_cmds");
  return arrayField(projectSettings, "check_cmds");
}

export function resolveRepoEngineConfig(
  agentName: string,
  base: unknown,
  renderAnswers: unknown,
  engine?: RunBundle["engine"],
) {
  const config = objectOrEmpty(base);
  const models = objectOrEmpty(objectOrEmpty(renderAnswers).models);
  const codex = engine ? engine === "codex" : agentName.startsWith("codex-");
  const role = agentName.replace(/^codex-/, "");
  const override =
    role === "architect"
      ? stringValue(models[codex ? "codexPlan" : "plan"])
      : role === "builder"
        ? stringValue(models[codex ? "codexBuild" : "build"])
        : role === "review"
          ? stringValue(models[codex ? "codexReview" : "review"])
          : undefined;
  if (!override) return config;
  if (codex) {
    const { model: _incompatibleModel, ...compatible } = config;
    return { ...compatible, primary: override };
  }
  const { primary: _incompatiblePrimary, ...compatible } = config;
  return { ...compatible, model: override };
}

// The sandbox profile is an explicit platform override. Otherwise use the
// repository-specific command detected/confirmed during kickstart.
export function resolveProvisionCmd(profile: { setup: unknown }, renderAnswers: unknown) {
  return (
    stringField(profile.setup, "provision_cmd") ??
    stringField(profile.setup, "provisionCmd") ??
    stringField(renderAnswers, "provisionCmd") ??
    stringField(renderAnswers, "provision_cmd")
  );
}

// Dependency installation is a separate phase so a private-registry token can
// be scoped to that child process and never reach provisioning scripts, checks,
// or the model runtime.
export function resolvePackageInstallCmd(profile: { setup: unknown }, renderAnswers: unknown) {
  return (
    stringField(profile.setup, "package_install_cmd") ??
    stringField(profile.setup, "packageInstallCmd") ??
    stringField(renderAnswers, "packageInstallCmd") ??
    stringField(renderAnswers, "package_install_cmd")
  );
}

export function resolveProvisioningCommands(
  profile: { setup: unknown },
  renderAnswers: unknown,
): { packageInstallCmd: string | null; provisionCmd: string | null } {
  const depth = provisioningDepth(profile.setup);
  return {
    packageInstallCmd: depth === "none" ? null : resolvePackageInstallCmd(profile, renderAnswers),
    provisionCmd: depth === "full" ? resolveProvisionCmd(profile, renderAnswers) : null,
  };
}

// Seed contracts are also used by the repository lane, where these placeholders
// are rendered into workflow files. Resolve the same values for platform runs so
// agents never receive literal {{...}} instructions.
export function renderRunContract(
  contract: string,
  provisionCmd: string | null,
  checkCmds: string[],
) {
  return contract
    .replaceAll("{{PROVISION_CMD}}", provisionCmd ?? "No provision command is configured.")
    .replaceAll(
      "{{CHECKS_INLINE}}",
      checkCmds.length ? checkCmds.join(" && ") : "No checks configured.",
    );
}

function command(value: unknown) {
  const candidate = objectOrEmpty(value).cmd;
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : undefined;
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
