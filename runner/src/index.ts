#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import {
  appendFile,
  chmod,
  chown,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { runObjectiveText } from "@facility/run-objective";
import {
  parseClaudeSessionId,
  parseClaudeStreamJsonLine,
  parseCodexJsonlLine,
  parseCodexSessionId,
} from "./parsers.js";
import { RunPhaseRecorder } from "./phases.js";
import { sandboxRuntimeEvent } from "./runtime.js";
import {
  type PreparedSecuritySweepEvidence,
  prepareSecuritySweepEvidence,
  verifySecuritySweepEvidence,
} from "./security-sweep.js";
import type { RunBundle, RunEvent } from "./types.js";

const workRoot = "/work";
const runtimeRoot = join(workRoot, ".facility-runtime");
const steerFile = join(runtimeRoot, "STEERING.md");
const transcriptFile = join(runtimeRoot, "engine.stream.jsonl");
const sessionStateDir = join(workRoot, ".claude");
const sessionStateArchive = join(runtimeRoot, "claude-session-state.tgz");
const resumeStateDir = join(workRoot, ".facility-resume");
const resumeManifestFile = "manifest.json";
const resumePatchFile = "tracked.patch";
const resumeFilesDir = "files";
const engineStderrFile = join(runtimeRoot, "engine.stderr.log");
const DELIVERY_CLI = "/usr/local/bin/facility-delivery";
const AGENT_PROGRESS_MAX_BYTES = 16 * 1024;
const SECURITY_REPORT_MAX_BYTES = 256 * 1024;
const SECURITY_EVIDENCE_MAX_BYTES = 256 * 1024;
const SESSION_STATE_MAX_BYTES = 200 * 1024 * 1024;
const SESSION_CHECKPOINT_INTERVAL_MS = 60_000;
const RATE_LIMIT_RETRY_LIMIT = 8;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const GIT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const EVENT_BATCH_MAX = 50;
// Fastify's JSON body limit is 1 MiB. Leave room for envelope overhead and
// future schema fields while retaining the old ability to send one large line.
const EVENT_BATCH_MAX_BYTES = 900 * 1024;
const EVENT_BATCH_FLUSH_MS = 100;
const PRIVATE_REGISTRY_INSTALL_COMMANDS = new Set([
  "npm ci",
  "pnpm install --frozen-lockfile",
  "yarn install --immutable",
]);
let engineSessionId: string | null = null;
let engineTerminalError: string | null = null;
let requestSessionCheckpoint: (() => void) | null = null;
let activeEngineChild: ReturnType<typeof spawn> | null = null;
let clearInterruptEscalation: (() => void) | null = null;
let interruptRequested = false;
let engineEventTransportDegraded = false;

// Secret values injected into the run (virtual key, platform key, runner token,
// repo clone token) that must never surface in captured check output persisted to
// run_events, which any runs:read principal can read. Populated as the workspace
// is prepared; redactSecrets() scrubs them from a check's stdout/stderr tail.
const secretsToRedact = new Set<string>();

export function redactSecrets(text: string, secrets: Iterable<string> = secretsToRedact): string {
  let out = text;
  for (const secret of secrets) {
    // Length guard so a short/empty value can't over-redact; real keys/tokens are
    // long. split/join replaces every occurrence without regex-escaping the secret.
    if (secret && secret.length >= 8) out = out.split(secret).join("«redacted»");
  }
  // Some repository setup tools generate credentials inside the sandbox, so
  // they are not present in Facility's injected-secret set. Supabase CLI is a
  // concrete example: `supabase start` prints publishable/secret keys and can
  // print legacy JWTs. Treat these credential shapes as secrets at the central
  // event boundary as well.
  return out
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g, "«redacted»")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "«redacted»")
    .replace(
      /((?:service[_ -]?role|anon|jwt secret|access key|secret key)\s*(?:key)?\s*[|│:]\s*)([^|│\r\n]+)/gi,
      "$1«redacted» ",
    );
}

async function main() {
  const startedAt = Date.now();
  const phases = new RunPhaseRecorder(emit);
  let bundle: RunBundle | null = null;
  let steerStop: (() => void) | undefined;
  let progressStop: (() => Promise<boolean>) | undefined;
  let checkpointStop: (() => Promise<void>) | undefined;
  let preparedSecuritySweep: PreparedSecuritySweepEvidence | null = null;
  let restoredSessionState = false;
  secretsToRedact.add(runnerToken());
  try {
    phases.start("bootstrap");
    const hello = await api<Record<string, unknown>>(`/internal/runs/${currentRunId()}/hello`, {
      method: "POST",
    });
    bundle = (await fetchJson(String(hello.bundleUrl), {
      headers: { authorization: `Bearer ${runnerToken()}` },
    })) as RunBundle;
    const activeBundle = bundle;
    await phases.finish({ outcome: "succeeded" });
    const runtimeEvent = sandboxRuntimeEvent();
    if (runtimeEvent) await emit([runtimeEvent]).catch(() => undefined);
    await phases.measure("workspace", () =>
      prepareWorkspace(activeBundle, String(hello.virtualKey), {
        platformKey: hello.platformKey ? String(hello.platformKey) : null,
        platformApiUrl: hello.platformApiUrl ? String(hello.platformApiUrl) : apiUrl(),
        projectId: hello.projectId ? String(hello.projectId) : "",
        repoToken: hello.repoToken ? String(hello.repoToken) : null,
      }),
    );
    await phases.measure("runner_runtime", async () => {
      await grantWorkspaceToUntrusted();
      await prepareRunnerRuntime();
    });
    restoredSessionState = await restoreSessionState(activeBundle);
    await recordWorkspaceProvenance(activeBundle);
    steerStop = startSteeringPoll();
    const packageInstallCmd = activeBundle.packageInstallCmd;
    if (packageInstallCmd) {
      const packageToken = hello.packageRegistryToken
        ? String(hello.packageRegistryToken).trim()
        : null;
      if (packageToken) secretsToRedact.add(packageToken);
      if (packageToken && !privateRegistryInstallCommand(packageInstallCmd)) {
        throw new Error("package_install_command_not_allowed_for_private_registry");
      }
      const installed = await phases.measure(
        "package_install",
        () =>
          runPackageInstall(
            packageInstallCmd,
            cwdFor(activeBundle),
            activeBundle.timeoutMin,
            packageToken,
          ),
        (code) => ({ outcome: code === 0 ? "succeeded" : "failed" }),
      );
      if (installed !== 0) {
        await postResult(bundle, "failed", startedAt, { code: "package_install_failed" });
        return;
      }
    } else {
      await phases.skip("package_install", "not_configured");
    }
    const provisionCmd = activeBundle.provisionCmd;
    if (provisionCmd) {
      const provision = await phases.measure(
        "provision",
        () => runShell(provisionCmd, cwdFor(activeBundle), "shell", activeBundle.timeoutMin),
        (code) => ({ outcome: code === 0 ? "succeeded" : "failed" }),
      );
      if (provision !== 0) {
        await postResult(bundle, "failed", startedAt, { code: "provision_failed" });
        return;
      }
    } else {
      await phases.skip("provision", "not_configured");
    }
    if (isSecurityMode(activeBundle.mode)) {
      preparedSecuritySweep = await preparePlatformSecuritySweepEvidence(
        activeBundle,
        hello.securitySweepEvidence,
      );
    }
    await writeFile(transcriptFile, "");
    const managedProgress = readOnlyEngineMode(activeBundle.mode)
      ? readOnlyEngineProgress(false)
      : null;
    if (managedProgress) {
      await emit([{ type: "agent_progress", data: { markdown: managedProgress } }]);
    }
    progressStop = startAgentProgressPoll(cwdFor(bundle));
    const stopProgress = progressStop;
    checkpointStop = startSessionCheckpointPoll(activeBundle);
    const stopCheckpoint = checkpointStop;
    const engineCode = await phases.measure(
      "agent",
      () => runEngine(activeBundle, restoredSessionState),
      (code) => ({
        outcome: interruptRequested ? "canceled" : code === 0 ? "succeeded" : "failed",
      }),
    );
    const captured = await phases.measure("result_capture", async () => {
      const agentProgressPublished = await stopProgress();
      progressStop = undefined;
      if (managedProgress) {
        await emit([
          {
            type: "agent_progress",
            data: { markdown: readOnlyEngineProgress(engineCode === 0) },
          },
        ]);
      }
      const progressPublished = managedProgress !== null || agentProgressPublished;
      const securityReport = isSecurityMode(activeBundle.mode)
        ? await readSecurityReport(
            join(cwdFor(activeBundle), ".agent-sdlc", "security-findings.json"),
          )
        : undefined;
      const securityReportConfigured =
        !isSecurityMode(activeBundle.mode) || securityReport !== null;
      const securityEvidenceConfigured =
        !isSecurityMode(activeBundle.mode) ||
        (preparedSecuritySweep !== null &&
          (await verifySecuritySweepEvidence(preparedSecuritySweep)));
      if (isSecurityMode(activeBundle.mode)) {
        await emit([
          {
            type: "check",
            data: {
              self_reported: false,
              name: "deterministic security evidence",
              status: securityEvidenceConfigured ? "passed" : "failed",
              ...(securityEvidenceConfigured ? {} : { reason: "security_evidence_invalid" }),
            },
          },
          {
            type: "check",
            data: {
              self_reported: false,
              name: "structured security findings",
              status: securityReportConfigured ? "passed" : "failed",
              ...(securityReportConfigured ? {} : { reason: "security_report_invalid" }),
            },
          },
        ]);
      }
      if (engineEventTransportDegraded) {
        await emit([
          {
            type: "artifact_error",
            data: { kind: "engine_events_degraded" },
          },
        ]).catch(() => undefined);
      }
      await uploadTranscript();
      await stopCheckpoint();
      checkpointStop = undefined;
      return {
        progressPublished,
        securityReport,
        securityReportConfigured,
        securityEvidenceConfigured,
      };
    });
    const {
      progressPublished,
      securityReport,
      securityReportConfigured,
      securityEvidenceConfigured,
    } = captured;
    if (interruptRequested) {
      await phases.skip("acceptance", "agent_canceled");
      await phases.skip("delivery", "agent_canceled");
      await postResult(bundle, "canceled", startedAt, "human_interrupt");
      return;
    }
    phases.start("acceptance");
    await emitChecks(cwdFor(bundle));
    const progressConfigured = !requiresAgentProgress(bundle.mode) || progressPublished;
    if (requiresAgentProgress(bundle.mode)) {
      await emit([
        {
          type: "check",
          data: {
            self_reported: false,
            name: "task-specific GitHub progress",
            status: progressConfigured ? "passed" : "failed",
            ...(progressConfigured ? {} : { reason: "agent_progress_missing" }),
          },
        },
      ]);
    }
    // GitHub-backed deliveries publish their signed branch first and let GitHub
    // Actions own acceptance. That preserves the work as a draft PR and lets a
    // CI-doctor iterate on the same branch instead of spending the sandbox's
    // lifetime duplicating CI before any reviewable artifact exists.
    const githubCi = githubCiOwnsAcceptance(bundle);
    const checksConfigured =
      githubCi || !requiresDelivery(bundle.mode) || bundle.checkCmds.length > 0;
    if (!checksConfigured) {
      await emit([
        {
          type: "check",
          data: {
            self_reported: false,
            name: "configured acceptance checks",
            status: "failed",
            reason: "checks_not_configured",
          },
        },
      ]);
    }
    // Acceptance checks prove changed work, so read-only modes (architect,
    // review, security-sweep, learning) skip them: those runs change nothing,
    // and running the project's checks would measure the repo's baseline — e.g.
    // an architect failing `npm test` on a repo whose bootstrap PR hasn't
    // merged yet. Every other mode keeps the gate: builder deliveries, repair
    // modes (address-review, ci-doctor — they push commits too), and custom/BYO
    // modes that use checks as generic acceptance.
    const readOnlyMode = readOnlyRepositoryMode(bundle.mode);
    if (githubCi && engineCode === 0) {
      await emit([
        {
          type: "check",
          data: {
            self_reported: false,
            name: "GitHub CI acceptance",
            status: "skipped",
            reason: "deferred_to_github",
            note: "The signed draft pull request is the durable CI boundary",
          },
        },
      ]);
    }
    if (readOnlyMode && bundle.checkCmds.length > 0 && engineCode === 0) {
      await emit([
        {
          type: "check",
          data: {
            self_reported: false,
            name: "configured acceptance checks",
            status: "passed",
            reason: "skipped_read_only_mode",
            note: "checks gate shipped changes; this run changes no code",
          },
        },
      ]);
    }
    const checksPassed =
      engineCode === 0 && checksConfigured && progressConfigured
        ? githubCi || readOnlyMode
          ? true
          : await runChecks(bundle, cwdFor(bundle))
        : false;
    await phases.finish({ outcome: checksPassed ? "succeeded" : "failed" });
    const engineAndChecksSucceeded =
      engineCode === 0 && checksPassed && securityReportConfigured && securityEvidenceConfigured;
    let delivery: {
      git: Awaited<ReturnType<typeof shipGitChanges>> | undefined;
      error: string | null;
    };
    if (engineAndChecksSucceeded) {
      delivery = await phases.measure(
        "delivery",
        async () => {
          await emit([{ type: "delivery", data: { status: "preparing" } }]);
          const git = await shipGitChanges(activeBundle);
          const error = deliveryFailure(activeBundle, git);
          await emit([deliveryStatusEvent(git, error)]);
          return { git, error };
        },
        ({ error }) => ({ outcome: error ? "failed" : "succeeded" }),
      );
    } else {
      await phases.skip("delivery", "run_preconditions_failed");
      delivery = { git: undefined, error: null };
    }
    const { git, error: deliveryError } = delivery;
    const succeeded = engineAndChecksSucceeded && deliveryError === null;
    await postResult(
      bundle,
      succeeded ? "succeeded" : "failed",
      startedAt,
      succeeded
        ? undefined
        : engineCode !== 0
          ? {
              code: engineCode,
              ...(engineTerminalError ? { engine_error: engineTerminalError } : {}),
            }
          : !checksConfigured
            ? { code: "checks_not_configured" }
            : !progressConfigured
              ? { code: "agent_progress_missing" }
              : !securityEvidenceConfigured
                ? { code: "security_evidence_invalid" }
                : !securityReportConfigured
                  ? { code: "security_report_invalid" }
                  : deliveryError
                    ? { code: deliveryError }
                    : { code: "checks_failed" },
      git,
      securityReport ?? undefined,
    );
  } catch (error) {
    await phases.fail().catch(() => undefined);
    await postResult(bundle, "failed", startedAt, { error: errorMessage(error) }).catch(
      () => undefined,
    );
    process.exitCode = 1;
  } finally {
    await progressStop?.().catch(() => false);
    await checkpointStop?.().catch(() => undefined);
    steerStop?.();
  }
}

export async function prepareWorkspace(
  bundle: RunBundle,
  virtualKey: string,
  platform: {
    platformKey: string | null;
    platformApiUrl: string;
    projectId: string;
    repoToken: string | null;
  },
  root = workRoot,
) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "contract.md"), bundle.contract);
  const cwd = cwdFor(bundle, root);
  // Deduplicate by target filename: bundle assembly already sends one active
  // version per skill, but a duplicate name would otherwise write the same file
  // twice (order-dependent last-write-wins). Keep the last occurrence, once.
  const skillsByFile = new Map(bundle.skills.map((skill) => [safeName(skill.name), skill]));
  const harnessFiles = Object.keys(bundle.harness?.files ?? {});
  for (const relativePath of harnessFiles) safeRepositoryPath(relativePath);
  if (bundle.repo.cloneUrl) {
    // Inject a token for private clones (x-access-token is how both PATs and
    // GitHub App installation tokens authenticate to github.com over HTTPS).
    const cloneUrl =
      platform.repoToken && bundle.repo.cloneUrl.startsWith("https://github.com/")
        ? bundle.repo.cloneUrl.replace(
            "https://github.com/",
            `https://x-access-token:${platform.repoToken}@github.com/`,
          )
        : bundle.repo.cloneUrl;
    await runCommand(
      "git",
      ["clone", "--branch", bundle.repo.branch ?? "main", cloneUrl, repoDirFor(root)],
      root,
    );
    if (bundle.resume?.branch) {
      await checkoutResumeBranch(repoDirFor(root), bundle.resume.branch);
    }
    if (bundle.repo.expectedHeadSha) {
      if (!/^[0-9a-f]{40}$/i.test(bundle.repo.expectedHeadSha)) {
        throw new Error("repository_expected_head_sha_invalid");
      }
      const actualHeadSha = (await gitOutput(repoDirFor(root), ["rev-parse", "HEAD"])).trim();
      if (actualHeadSha !== bundle.repo.expectedHeadSha) {
        // Admission evaluated a different tree. Stop before provisioning, the
        // model, or a contents-write token; the newer head will emit its own CI
        // completion signal and receive a fresh deterministic decision.
        throw new Error("repository_head_sha_mismatch");
      }
    }
    // Provisioning and live-agent metadata must never leak into the delivered
    // diff. The runner owns these paths even when a repository has no
    // .gitignore (a common case for small/new projects).
    await appendFile(
      join(cwd, ".git", "info", "exclude"),
      [
        "",
        "node_modules/",
        ".agent-sdlc/progress.md",
        ".agent-sdlc/checks.jsonl",
        ".agent-sdlc/delivery.json",
        ".agent-sdlc/security-findings.json",
        ".facility-sweep/",
        ...[...skillsByFile.keys()].flatMap((fileBase) => [
          `.claude/skills/${fileBase}/`,
          `.agents/skills/${fileBase}/`,
        ]),
        ...harnessFiles,
        "",
      ].join("\n"),
    );
  } else {
    await mkdir(scratchDirFor(root), { recursive: true });
    await runCommand("git", ["init"], scratchDirFor(root)).catch(() => undefined);
  }
  for (const root of [join(cwd, ".claude", "skills"), join(cwd, ".agents", "skills")]) {
    await mkdir(root, { recursive: true });
    for (const [fileBase, skill] of skillsByFile) {
      const skillDir = join(root, fileBase);
      const skillPath = join(skillDir, "SKILL.md");
      if (await pathExists(skillPath)) {
        // Existing repositories own their checked-in agent behavior. A
        // project/org Facility skill may supplement it under another name, but
        // must never overwrite a repository skill with the same name.
        continue;
      }
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, materializedSkillContent(skill.name, skill.content));
    }
  }
  if (bundle.harness?.files) {
    for (const [relativePath, content] of Object.entries(bundle.harness.files)) {
      const path = join(cwd, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  process.env.ANTHROPIC_BASE_URL = bundle.gatewayUrls.anthropic;
  process.env.OPENAI_BASE_URL = bundle.gatewayUrls.openai;
  if (bundle.anthropicAuthMode === "oauth") {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = virtualKey;
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = virtualKey;
  }
  process.env.OPENAI_API_KEY = virtualKey;
  // Platform key for KB/task writes (Project Owner / learning agents).
  process.env.FACILITY_PROJECT_ID = platform.projectId;
  const deliveryKind = agentDeliveryKind(bundle.mode);
  if (deliveryKind) {
    process.env.FACILITY_DELIVERY_KIND = deliveryKind;
    process.env.FACILITY_DELIVERY_REPOSITORY = cwd;
    process.env.FACILITY_DELIVERY_BASE_BRANCH = bundle.repo.branch ?? "main";
  } else {
    delete process.env.FACILITY_DELIVERY_KIND;
    delete process.env.FACILITY_DELIVERY_REPOSITORY;
    delete process.env.FACILITY_DELIVERY_BASE_BRANCH;
  }
  if (platform.platformKey) process.env.FACILITY_PLATFORM_KEY = platform.platformKey;
  // Register every injected secret for redaction from captured check output.
  for (const secret of [virtualKey, platform.platformKey, platform.repoToken]) {
    if (secret) secretsToRedact.add(secret);
  }
}

export async function preparedWorkspaceBaseSha(bundle: RunBundle, root = workRoot) {
  if (!bundle.repo.cloneUrl) return null;
  const baseSha = (await gitOutput(cwdFor(bundle, root), ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("workspace_base_sha_invalid");
  return baseSha.toLowerCase();
}

export async function recordWorkspaceProvenance(bundle: RunBundle, root = workRoot) {
  const baseSha = await preparedWorkspaceBaseSha(bundle, root);
  if (!baseSha) return null;
  return api<{ baseSha: string }>(`/internal/runs/${currentRunId()}/workspace`, {
    method: "POST",
    body: JSON.stringify({ baseSha }),
  });
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runEngine(bundle: RunBundle, restoredSessionState: boolean) {
  if (interruptRequested) return 130;
  if (bundle.engine === "claude_code") {
    await trustClaudeWorkspace(cwdFor(bundle));
    const args = buildClaudeCodeArgs(bundle, restoredSessionState);
    addModelFlags(args, bundle.engineConfig);
    return runJsonProcess(
      "claude",
      args,
      cwdFor(bundle),
      parseClaudeStreamJsonLine,
      parseClaudeSessionId,
    );
  }
  if (bundle.engine === "codex") {
    return runJsonProcess(
      "codex",
      buildCodexArgs(bundle),
      cwdFor(bundle),
      parseCodexJsonlLine,
      parseCodexSessionId,
      composedPrompt(bundle),
    );
  }
  const cmd = typeof bundle.engineConfig.cmd === "string" ? bundle.engineConfig.cmd : "printf ''";
  return runShell(cmd, cwdFor(bundle), "assistant");
}

function startSteeringPoll() {
  let stopped = false;
  void (async () => {
    let afterId: string | undefined;
    while (!stopped) {
      const query = afterId ? `?afterId=${encodeURIComponent(afterId)}` : "";
      const messages = await api<Array<{ id: string; body: string; kind?: string }>>(
        `/internal/runs/${currentRunId()}/steer${query}`,
      );
      for (const message of messages) {
        afterId = message.id;
        await handleControlMessage(message, {
          appendSteer: async (body) => {
            await appendFile(steerFile, `\n\n## ${new Date().toISOString()}\n${body}\n`);
          },
          emit,
          interrupt: async () => {
            interruptRequested = true;
            if (activeEngineChild && !clearInterruptEscalation) {
              clearInterruptEscalation = terminateChild(activeEngineChild);
            }
          },
        });
      }
    }
  })().catch(() => undefined);
  return () => {
    stopped = true;
  };
}

async function runJsonProcess(
  command: string,
  args: string[],
  cwd: string,
  parse: (line: string) => RunEvent | null,
  parseSessionId: (line: string) => string | null,
  stdin?: string,
) {
  const child = spawn(command, args, {
    cwd,
    env: engineEnv(),
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...untrustedSpawnIdentity(),
  });
  if (stdin !== undefined && child.stdin) {
    // Large learning packets exceed the OS argv limit. Stream the prompt so
    // the same bounded packet can reach Codex without truncation or E2BIG.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  }
  activeEngineChild = child;
  const stdout = child.stdout;
  const stderrStream = child.stderr;
  if (!stdout || !stderrStream) {
    child.kill();
    throw new Error("engine_stdio_unavailable");
  }
  const stderr = createWriteStream(engineStderrFile, { flags: "a" });
  stderrStream.pipe(stderr);
  const rl = createInterface({ input: stdout });
  for await (const line of rl) {
    await appendFile(transcriptFile, `${redactSecrets(line)}\n`);
    if (!engineSessionId) {
      const sessionId = parseSessionId(line);
      if (sessionId) {
        engineSessionId = sessionId;
        requestSessionCheckpoint?.();
        if (
          !(await emitEngineEventsBestEffort(
            [{ type: "session", data: { engine_session_id: sessionId } }],
            emit,
          ))
        ) {
          engineEventTransportDegraded = true;
        }
      }
    }
    const event = parse(line);
    const terminalError = engineResultError(event);
    if (terminalError) engineTerminalError = terminalError;
    if (event && !(await emitEngineEventsBestEffort([event], emit))) {
      engineEventTransportDegraded = true;
    }
  }
  const code = await exitCode(child);
  if (activeEngineChild === child) activeEngineChild = null;
  clearInterruptEscalation?.();
  clearInterruptEscalation = null;
  if (interruptRequested) return 130;
  return code;
}

export function engineResultError(event: RunEvent | null) {
  if (event?.type !== "engine_result") return null;
  const data = event.data ?? {};
  const subtype = typeof data.subtype === "string" ? data.subtype : null;
  if (data.is_error !== true && !subtype?.startsWith("error_")) return null;
  const errors = Array.isArray(data.errors)
    ? data.errors.filter((value): value is string => typeof value === "string")
    : [];
  const reason =
    errors[0] ??
    (typeof data.terminal_reason === "string" ? data.terminal_reason : null) ??
    subtype;
  return reason ? `engine_${reason}` : "engine_failed";
}

function startAgentProgressPoll(cwd: string) {
  const path = join(cwd, ".agent-sdlc", "progress.md");
  let stopped = false;
  let published = false;
  let last = "";
  let active = Promise.resolve();
  const poll = async () => {
    const markdown = await readAgentProgress(path);
    if (!markdown || markdown === last) return;
    last = markdown;
    published = true;
    await emit([{ type: "agent_progress", data: { markdown } }]);
  };
  const schedule = () => {
    active = active.then(poll).catch(() => undefined);
  };
  schedule();
  const timer = setInterval(() => {
    if (!stopped) schedule();
  }, 1_500);
  return async () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
      await active;
      await poll().catch(() => undefined);
    }
    return published;
  };
}

export async function readAgentProgress(path: string) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > AGENT_PROGRESS_MAX_BYTES) return null;
  const markdown = (await readFile(path, "utf8")).trim();
  return markdown || null;
}

export async function readSecurityReport(path: string): Promise<Record<string, unknown> | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size <= 0 || info.size > SECURITY_REPORT_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isSecurityReport(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function preparePlatformSecuritySweepEvidence(bundle: RunBundle, raw: unknown) {
  if (!bundle.repo.cloneUrl) throw new Error("security_sweep_repository_unavailable");
  const cwd = cwdFor(bundle);
  const [owner, repo] = githubRepositoryName(bundle.repo.cloneUrl).split("/");
  if (!owner || !repo) throw new Error("security_sweep_repository_unavailable");
  const ref = bundle.repo.branch;
  if (!ref) throw new Error("security_sweep_ref_unavailable");
  const headSha = (await gitOutput(cwd, ["rev-parse", "HEAD"])).trim();
  const [workflowPermissions, guards, weekDiff] = await Promise.all([
    collectWorkflowPermissions(cwd),
    collectGuardEvidence(cwd, bundle.timeoutMin),
    gitOutput(cwd, ["log", "--since=8 days ago", "--name-only", "--pretty=format:%h %s"]),
  ]);
  return prepareSecuritySweepEvidence({
    cwd,
    raw,
    expected: { runId: bundle.runId, owner, repo, ref, headSha },
    local: {
      workflowPermissions: boundedEvidenceText(workflowPermissions),
      guards,
      weekDiff: boundedEvidenceText(weekDiff),
    },
  });
}

async function collectWorkflowPermissions(cwd: string) {
  const directory = join(cwd, ".github", "workflows");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const permissionLine =
    /^\s*(?:permissions:|(?:actions|attestations|checks|contents|deployments|id-token|issues|packages|pull-requests|security-events|statuses):)/;
  const inventory: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const body = await readCappedUtf8(join(directory, entry.name), SECURITY_EVIDENCE_MAX_BYTES);
    body.split(/\r?\n/).forEach((line, index) => {
      if (permissionLine.test(line)) inventory.push(`${entry.name}:${index + 1}:${line}`);
    });
  }
  return inventory.length ? `${inventory.join("\n")}\n` : "";
}

async function collectGuardEvidence(cwd: string, timeoutMin: number) {
  if (!(await pathExists(join(cwd, "guards", "run.mjs")))) {
    return { unavailable: true, source: "guards", reason: "not_configured" };
  }
  const result = await runCheckCommand(
    "node guards/run.mjs --json",
    cwd,
    Math.min(timeoutMin, 10),
    SECURITY_EVIDENCE_MAX_BYTES,
  );
  if (result.code !== 0) {
    return {
      unavailable: true,
      source: "guards",
      reason: "command_failed",
      exitCode: result.code,
    };
  }
  try {
    const parsed = JSON.parse(result.tail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { unavailable: true, source: "guards", reason: "malformed_output" };
  } catch {
    return { unavailable: true, source: "guards", reason: "malformed_output" };
  }
}

function boundedEvidenceText(value: string) {
  const encoded = Buffer.from(value);
  if (encoded.length <= SECURITY_EVIDENCE_MAX_BYTES) return value;
  const suffix = "\n[truncated]\n";
  const prefixBytes = SECURITY_EVIDENCE_MAX_BYTES - Buffer.byteLength(suffix);
  let bounded = encoded.subarray(0, prefixBytes).toString("utf8");
  while (Buffer.byteLength(bounded) > prefixBytes) {
    bounded = bounded.slice(0, -1);
  }
  return `${bounded}${suffix}`;
}

function isSecurityReport(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (report.schema !== "facility.security.findings.v1" || !Array.isArray(report.findings)) {
    return false;
  }
  if (report.findings.length > 20) return false;
  return report.findings.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const finding = value as Record<string, unknown>;
    return (
      typeof finding.fingerprint === "string" &&
      /^[a-z0-9][a-z0-9._:/-]*$/i.test(finding.fingerprint) &&
      typeof finding.title === "string" &&
      ["low", "medium", "high", "critical"].includes(String(finding.severity)) &&
      ["low", "medium", "high"].includes(String(finding.confidence)) &&
      typeof finding.actionable === "boolean" &&
      typeof finding.risk === "string" &&
      Array.isArray(finding.locations) &&
      finding.locations.length > 0 &&
      finding.locations.every((location) => typeof location === "string") &&
      typeof finding.smallest_fix === "string" &&
      Array.isArray(finding.evidence)
    );
  });
}

async function uploadTranscript() {
  const size = await stat(transcriptFile)
    .then((info) => info.size)
    .catch(() => 0);
  if (size === 0) return;
  try {
    await api(
      `/internal/runs/${currentRunId()}/transcript`,
      {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      () => createReadStream(transcriptFile) as unknown as RequestInit["body"],
    );
  } catch {
    await emit([{ type: "artifact_error", data: { kind: "transcript_upload_failed" } }]).catch(
      () => undefined,
    );
  }
}

type WorkspaceCheckpointManifest = {
  version: 1;
  baseBranch: string;
  baseSha: string;
  branch: string;
  files: string[];
};

async function workspacePatch(cwd: string, baseBranch: string) {
  return gitOutput(cwd, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    `origin/${baseBranch}`,
    "--",
  ]);
}

export async function createWorkspaceCheckpoint(
  cwd: string,
  destination: string,
  baseBranch: string,
) {
  existingGithubBranch(baseBranch);
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, resumeFilesDir), { recursive: true });
  const baseSha = (await gitOutput(cwd, ["rev-parse", `origin/${baseBranch}`])).trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("resume_workspace_base_invalid");
  const branch =
    (await gitOutput(cwd, ["branch", "--show-current"])).trim() || existingGithubBranch(baseBranch);
  existingGithubBranch(branch);
  const patch = await workspacePatch(cwd, baseBranch);
  await writeFile(join(destination, resumePatchFile), patch, { mode: 0o600 });

  const untracked = (await gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const managedCandidates = [...FACILITY_MANAGED_REPOSITORY_FILES];
  const managedPresence = await Promise.all(
    managedCandidates.map((path) => pathExists(join(cwd, path))),
  );
  const managed = managedCandidates.filter((_, index) => managedPresence[index]);
  const files = [...new Set([...untracked, ...managed])].sort();
  for (const relativePath of files) {
    safeRepositoryPath(relativePath);
    const source = join(cwd, relativePath);
    const target = join(destination, resumeFilesDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }
  const manifest: WorkspaceCheckpointManifest = {
    version: 1,
    baseBranch,
    baseSha,
    branch,
    files,
  };
  await writeFile(join(destination, resumeManifestFile), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

export async function restoreWorkspaceCheckpoint(
  cwd: string,
  source: string,
  expectedBaseBranch: string,
) {
  const manifestPath = join(source, resumeManifestFile);
  if (!(await pathExists(manifestPath))) return false;
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const root = objectValue(parsed);
  if (
    !hasExactObjectKeys(parsed, ["version", "baseBranch", "baseSha", "branch", "files"]) ||
    root.version !== 1 ||
    root.baseBranch !== expectedBaseBranch ||
    typeof root.baseSha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(root.baseSha) ||
    typeof root.branch !== "string" ||
    !Array.isArray(root.files) ||
    !root.files.every((path) => typeof path === "string")
  ) {
    throw new Error("resume_workspace_manifest_invalid");
  }
  const currentBaseSha = (
    await gitOutput(cwd, ["rev-parse", `origin/${expectedBaseBranch}`])
  ).trim();
  const branch = existingGithubBranch(root.branch);
  const currentBranch = (await gitOutput(cwd, ["branch", "--show-current"])).trim();
  if (branch !== currentBranch) await gitOutput(cwd, ["checkout", "-B", branch]);
  const patchPath = join(source, resumePatchFile);
  const patch = await readFile(patchPath, "utf8");
  const existingPatch = await workspacePatch(cwd, expectedBaseBranch);
  if (existingPatch.trim() && patch !== existingPatch) throw new Error("resume_workspace_conflict");
  const files = root.files as string[];
  for (const relativePath of files) {
    safeRepositoryPath(relativePath);
    const checkpointFile = join(source, resumeFilesDir, relativePath);
    if (!(await pathExists(checkpointFile))) throw new Error("resume_workspace_file_missing");
  }

  const applyCheckpoint = async (includePatch = true) => {
    // The lifecycle process extracts the checkpoint as root, while every Git
    // command runs as the untrusted workspace user. Feed the already-read patch
    // through stdin so a root-owned 0600 archive entry cannot make a valid
    // checkpoint unreadable to `git apply`.
    if (includePatch && patch.trim()) {
      await gitOutput(cwd, ["apply", "--binary", "-"], false, GIT_COMMAND_TIMEOUT_MS, patch);
    }
    for (const relativePath of files) {
      const checkpointFile = join(source, resumeFilesDir, relativePath);
      const target = join(cwd, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await cp(checkpointFile, target, { recursive: true, preserveTimestamps: true });
    }
  };

  if (currentBaseSha === root.baseSha) {
    await applyCheckpoint(patch !== existingPatch);
  } else {
    if (existingPatch.trim()) throw new Error("resume_workspace_conflict");
    const currentHead = (await gitOutput(cwd, ["rev-parse", "HEAD"])).trim();
    try {
      await gitOutput(cwd, ["cat-file", "-e", `${root.baseSha}^{commit}`]);
    } catch {
      await gitOutput(cwd, ["fetch", "origin", root.baseSha], true);
    }
    await gitOutput(cwd, ["checkout", "--detach", root.baseSha]);
    try {
      await applyCheckpoint();
      await grantPathToUntrusted(cwd);
      await gitOutput(cwd, ["add", "-A"]);
      const staged = (
        await gitOutput(cwd, ["status", "--porcelain", "--untracked-files=all"])
      ).trim();
      if (!staged) {
        await gitOutput(cwd, ["checkout", "-B", branch, currentHead]);
        await grantPathToUntrusted(cwd);
        return true;
      }
      await gitOutput(cwd, [
        "-c",
        "user.name=Facility checkpoint",
        "-c",
        "user.email=checkpoint@facility.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        "chore: restore Facility checkpoint",
      ]);
      const checkpointCommit = (await gitOutput(cwd, ["rev-parse", "HEAD"])).trim();
      await gitOutput(cwd, ["checkout", "-B", branch, currentHead]);
      try {
        await gitOutput(cwd, ["cherry-pick", "--no-commit", checkpointCommit]);
      } catch (error) {
        const conflicts = (await gitOutput(cwd, ["diff", "--name-only", "--diff-filter=U"]))
          .split("\n")
          .filter(Boolean);
        // Conflicts are durable, useful continuation state. Leave the index and
        // worktree intact so the resumed agent can reconcile upstream changes
        // instead of silently losing either side of the checkpoint.
        if (conflicts.length === 0) throw error;
      }
    } catch (error) {
      const head = (await gitOutput(cwd, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      if (
        head !== currentHead &&
        !(await gitOutput(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim()
      ) {
        await gitOutput(cwd, ["checkout", "-B", branch, currentHead]).catch(() => undefined);
      }
      throw error;
    }
  }

  for (const relativePath of files) {
    const target = join(cwd, relativePath);
    if (!(await pathExists(target))) {
      throw new Error("resume_workspace_file_missing");
    }
  }
  // Node's lifecycle process performs the copies above and therefore owns new
  // untracked files. Return the repository to the engine identity before
  // Claude resumes, including recursively copied directories.
  await grantPathToUntrusted(cwd);
  return true;
}

async function restoreSessionState(bundle: RunBundle) {
  if (bundle.engine !== "claude_code" || !bundle.resume) return false;
  try {
    const response = await fetch(`${apiUrl()}/internal/runs/${currentRunId()}/session-state`, {
      headers: { authorization: `Bearer ${runnerToken()}` },
    });
    if (!response.ok) {
      throw new Error(`session state restore failed ${response.status}`);
    }
    await writeFile(sessionStateArchive, Buffer.from(await response.arrayBuffer()));
    await rm(sessionStateDir, { recursive: true, force: true });
    await rm(resumeStateDir, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true });
    await runCommand("tar", ["-xzf", sessionStateArchive, "-C", workRoot], workRoot);
    if (bundle.repo.cloneUrl && agentDeliveryKind(bundle.mode)) {
      const restoredWorkspace = await restoreWorkspaceCheckpoint(
        cwdFor(bundle),
        resumeStateDir,
        bundle.repo.branch ?? "main",
      );
      if (!restoredWorkspace) throw new Error("resume_workspace_checkpoint_missing");
    }
    return true;
  } catch (error) {
    await emit([
      {
        type: "artifact_error",
        data: { kind: "session_state_restore_failed", error: errorMessage(error) },
      },
    ]).catch(() => undefined);
    return false;
  }
}

async function uploadSessionState(bundle: RunBundle) {
  if (bundle.engine !== "claude_code") return;
  try {
    const archiveEntries = [".claude"];
    if (bundle.repo.cloneUrl && agentDeliveryKind(bundle.mode)) {
      await createWorkspaceCheckpoint(cwdFor(bundle), resumeStateDir, bundle.repo.branch ?? "main");
      archiveEntries.push(".facility-resume");
    }
    const size = await Promise.all(
      archiveEntries.map((entry) => directorySize(join(workRoot, entry)).catch(() => 0)),
    ).then((sizes) => sizes.reduce((total, entrySize) => total + entrySize, 0));
    if (size === 0) return;
    if (size > SESSION_STATE_MAX_BYTES) {
      await emit([
        { type: "artifact_error", data: { kind: "session_state_too_large", bytes: size } },
      ]).catch(() => undefined);
      return;
    }
    await rm(sessionStateArchive, { force: true });
    await runCommand(
      "tar",
      ["-czf", sessionStateArchive, "-C", workRoot, ...archiveEntries],
      workRoot,
    );
    const archiveSize = await stat(sessionStateArchive).then((info) => info.size);
    if (archiveSize > SESSION_STATE_MAX_BYTES) {
      await emit([
        {
          type: "artifact_error",
          data: { kind: "session_state_too_large", bytes: archiveSize },
        },
      ]).catch(() => undefined);
      return;
    }
    await api(
      `/internal/runs/${currentRunId()}/session-state`,
      {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      () => createReadStream(sessionStateArchive) as unknown as RequestInit["body"],
    );
  } catch (error) {
    await emit([
      {
        type: "artifact_error",
        data: { kind: "session_state_upload_failed", error: errorMessage(error) },
      },
    ]).catch(() => undefined);
  }
}

export function startSessionCheckpointPoll(
  bundle: RunBundle,
  intervalMs = SESSION_CHECKPOINT_INTERVAL_MS,
) {
  let stopped = false;
  let active = Promise.resolve();
  const checkpoint = async () => {
    // Claude does not create its session directory until it has started. Avoid
    // uploading a workspace-only archive that cannot be resumed as a session.
    if (!engineSessionId || !(await pathExists(sessionStateDir))) return;
    await uploadSessionState(bundle);
  };
  const schedule = () => {
    active = active.then(checkpoint).catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (!stopped) schedule();
  }, intervalMs);
  timer.unref();
  requestSessionCheckpoint = schedule;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (requestSessionCheckpoint === schedule) requestSessionCheckpoint = null;
    await active;
    await checkpoint().catch(() => undefined);
  };
}

export function buildClaudeCodeArgs(bundle: RunBundle, restoredSessionState: boolean) {
  const args =
    bundle.resume && restoredSessionState
      ? ["-p", resumeContinuationPrompt(bundle), "--resume", bundle.resume.sessionId]
      : ["-p", resumeRecoveryPrompt(bundle)];
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    readOnlyEngineMode(bundle.mode) ? "plan" : "bypassPermissions",
  );
  const deliveryPrompt = deliverySystemPrompt(bundle.mode);
  const deliverySettings = claudeDeliverySettings(bundle.mode);
  if (deliveryPrompt) args.push("--append-system-prompt", deliveryPrompt);
  if (deliverySettings) args.push("--settings", deliverySettings);
  return args;
}

export function deliverySystemPrompt(mode: string) {
  const kind = agentDeliveryKind(mode);
  if (!kind) return null;
  if (kind === "repair") {
    return `<facility_delivery>
Facility owns the signed commit and GitHub publication. Never run git push, create a pull request, or depend on gh authentication. If and only if you make repository changes, create the required receipt with the runner-owned command before stopping:

  facility-delivery write --branch "<existing PR branch>" --commit-message "fix: describe the correction"

Then run \`facility-delivery validate\`. Do not write .agent-sdlc/delivery.json by hand. A Stop hook validates the receipt and will return actionable feedback while you can still correct it.
</facility_delivery>`;
  }
  return `<facility_delivery>
Facility owns the signed commit, push, and draft pull request. Never run git push, create a pull request, or depend on gh authentication. After completing and verifying repository changes, create the required receipt with the runner-owned command before stopping:

  facility-delivery write --branch "feature/task-slug" --commit-message "feat: describe the change" --pr-title "feat: describe the change" --pr-body-file /tmp/facility-pr-body.md

The PR body file must contain the complete team-lead-ready description. Then run \`facility-delivery validate\`. Do not write .agent-sdlc/delivery.json by hand. A Stop hook validates the receipt and will return actionable feedback while you can still correct it.
</facility_delivery>`;
}

export function claudeDeliverySettings(mode: string) {
  if (!agentDeliveryKind(mode)) return null;
  return JSON.stringify({
    disableAllHooks: false,
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: DELIVERY_CLI,
              args: ["hook"],
              timeout: 10,
            },
          ],
        },
      ],
    },
  });
}

export function resumeContinuationPrompt(bundle: RunBundle) {
  if (!bundle.resume) return composedPrompt(bundle);
  const priorPrompt = composedPrompt({
    ...bundle,
    scope: bundle.resume.fallbackScope ?? bundle.scope,
    resume: undefined,
  });
  return `${priorPrompt}\n\n## Restored continuation\nFacility restored both the prior Claude session and its governed workspace checkpoint from run ${bundle.resume.sessionStateFrom}. Re-read the original objective and approved plan above; they remain authoritative even if the conversation was compacted. Inspect the restored worktree before changing it, continue rather than restarting completed work, and re-run relevant verification before delivery. The repository base may have advanced since the checkpoint. Inspect \`git status\` first; if Facility replayed the checkpoint with conflicts, resolve every conflict while preserving both the completed work and compatible upstream changes before continuing.\n\n## Resume instruction\n${bundle.resume.prompt}`;
}

export function resumeRecoveryPrompt(bundle: RunBundle) {
  const fallbackScope = bundle.resume?.fallbackScope;
  if (!fallbackScope) return composedPrompt(bundle);
  const priorPrompt = composedPrompt({ ...bundle, scope: fallbackScope, resume: undefined });
  return `${priorPrompt}\n\n## Resume recovery\nThe prior Claude session or governed workspace checkpoint from run ${bundle.resume?.sessionStateFrom} was unavailable. Continue from the governed objective above without assuming unrecorded prior work.\n\n## Resume instruction\n${bundle.resume?.prompt}`;
}

export async function emitEngineEventsBestEffort(
  events: RunEvent[],
  send: (events: RunEvent[]) => Promise<unknown>,
) {
  try {
    await send(events);
    return true;
  } catch {
    // Stream events are live observability, not the execution boundary. The
    // complete local JSONL transcript and final /result remain authoritative.
    return false;
  }
}

type ControlMessage = { id: string; body: string; kind?: string };
type ControlHandlers = {
  appendSteer: (body: string) => Promise<void>;
  emit: (events: RunEvent[]) => Promise<void>;
  interrupt: () => Promise<void>;
};

export async function handleControlMessage(message: ControlMessage, handlers: ControlHandlers) {
  if (message.kind === "interrupt") {
    await handlers.emit([{ type: "status", data: { message: "human interrupt" } }]);
    await handlers.interrupt();
    await handlers.emit([{ type: "steer", data: { id: message.id, kind: "interrupt" } }]);
    return "interrupt";
  }
  await handlers.appendSteer(message.body);
  await handlers.emit([{ type: "steer", data: { id: message.id, applied: true } }]);
  return "steer";
}

export function terminateChild(
  child: Pick<ReturnType<typeof spawn>, "kill">,
  escalateMs = 15_000,
  setTimer: typeof setTimeout = setTimeout,
) {
  child.kill("SIGTERM");
  const timer = setTimer(() => child.kill("SIGKILL"), escalateMs);
  return () => clearTimeout(timer);
}

async function checkoutResumeBranch(cwd: string, branch: string) {
  try {
    await gitOutput(cwd, ["fetch", "origin", branch], true);
    await gitOutput(cwd, ["checkout", branch], true);
  } catch (error) {
    await emit([
      {
        type: "artifact_error",
        data: { kind: "resume_branch_missing", error: errorMessage(error) },
      },
    ]).catch(() => undefined);
  }
}

async function directorySize(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path);
  let total = 0;
  for (const entry of entries) {
    total += await directorySize(join(path, entry));
  }
  return total;
}

async function runShell(
  command: string,
  cwd: string,
  eventType: string,
  timeoutMin?: number,
  envOverrides?: NodeJS.ProcessEnv,
) {
  const child = spawn("sh", ["-c", command], {
    cwd,
    env: { ...engineEnv(), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
    ...untrustedSpawnIdentity(),
  });
  const clearTimers =
    timeoutMin === undefined ? () => undefined : armCommandTimeout(child, timeoutMin);
  const drains = [child.stdout, child.stderr].map((stream) => drainLineEvents(stream, eventType));
  const code = await exitCode(child);
  // Wait for both stream readers to finish draining before returning, so no
  // output line is emitted AFTER the caller records the run's result (a late
  // event would be dropped as post-terminal). Previously these loops were
  // fire-and-forget and could lose or reorder trailing output.
  await Promise.all(drains);
  clearTimers();
  return code;
}

export async function drainLineEvents(
  stream: NodeJS.ReadableStream,
  eventType: string,
  send: (events: RunEvent[]) => Promise<unknown> = emit,
  options: { batchSize?: number; maxBatchBytes?: number; flushMs?: number } = {},
) {
  const batchSize = options.batchSize ?? EVENT_BATCH_MAX;
  const maxBatchBytes = options.maxBatchBytes ?? EVENT_BATCH_MAX_BYTES;
  const flushMs = options.flushMs ?? EVENT_BATCH_FLUSH_MS;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid_event_batch_size");
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < 1)
    throw new Error("invalid_event_batch_max_bytes");
  if (!Number.isFinite(flushMs) || flushMs < 0) throw new Error("invalid_event_batch_flush_ms");

  const lines = createInterface({ input: stream });
  let buffered: RunEvent[] = [];
  // Opening and closing brackets are always present in the serialized array.
  let bufferedBytes = 2;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let activeDelivery: Promise<void> | undefined;
  let deliveryError: unknown;
  let suppressedContainerProgress = 0;

  const clearFlushTimer = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
  };
  const scheduleFlush = () => {
    if (flushTimer || activeDelivery || buffered.length === 0 || deliveryError) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      startDelivery();
    }, flushMs);
  };
  const startDelivery = () => {
    if (activeDelivery || buffered.length === 0 || deliveryError) return;
    clearFlushTimer();
    const batch = buffered;
    buffered = [];
    bufferedBytes = 2;
    const current = Promise.resolve().then(async () => {
      await send(batch);
    });
    activeDelivery = current;
    // Keep at most one active delivery and one bounded pending batch. A timer
    // must never snapshot another partial batch while the API is throttling.
    void current.then(
      () => {
        if (activeDelivery !== current) return;
        activeDelivery = undefined;
        if (buffered.length >= batchSize) startDelivery();
        else scheduleFlush();
      },
      (error: unknown) => {
        if (activeDelivery !== current) return;
        activeDelivery = undefined;
        deliveryError = error;
        clearFlushTimer();
        // Wake a reader waiting on more process output so the delivery failure
        // is surfaced even when the underlying stream remains open.
        lines.close();
      },
    );
  };
  const dispatchPending = async () => {
    clearFlushTimer();
    if (!activeDelivery) startDelivery();
    else {
      await activeDelivery;
      if (deliveryError) throw deliveryError;
      if (!activeDelivery && buffered.length > 0) startDelivery();
    }
  };
  const enqueue = async (event: RunEvent) => {
    const eventBytes = Buffer.byteLength(JSON.stringify(redactRunEvent(event)));
    const separatorBytes = buffered.length === 0 ? 0 : 1;
    if (buffered.length > 0 && bufferedBytes + separatorBytes + eventBytes > maxBatchBytes) {
      // Flush the existing batch before adding a line that would exceed the
      // request budget. A single large line is still sent on its own, as it
      // was before batching, because splitting one event would change it.
      await dispatchPending();
    }

    bufferedBytes += (buffered.length === 0 ? 0 : 1) + eventBytes;
    buffered.push(event);
    if (buffered.length >= batchSize || bufferedBytes >= maxBatchBytes) {
      // Preserve stream backpressure at one pending batch while the API is
      // throttling instead of chaining unbounded timer-created requests.
      await dispatchPending();
    } else {
      scheduleFlush();
    }
  };

  try {
    for await (const line of lines) {
      if (eventType === "shell" && isTransientContainerProgressLine(line)) {
        suppressedContainerProgress += 1;
        continue;
      }
      await enqueue({ type: eventType, data: { text: line } });
    }
    if (suppressedContainerProgress > 0) {
      await enqueue({
        type: eventType,
        data: {
          text: `[Facility] Suppressed ${suppressedContainerProgress} transient container download progress lines`,
        },
      });
    }
    clearFlushTimer();
    while (activeDelivery || buffered.length > 0) {
      if (deliveryError) throw deliveryError;
      if (!activeDelivery) startDelivery();
      if (activeDelivery) await activeDelivery;
    }
    if (deliveryError) throw deliveryError;
  } finally {
    clearFlushTimer();
    lines.close();
  }
}

export function isTransientContainerProgressLine(line: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI starts with ESC by definition.
  const plain = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return /^[a-f0-9]{12,64}\s+(?:Pulling fs layer|Waiting|Downloading(?:\s+.*)?|Verifying Checksum|Download complete|Extracting(?:\s+.*)?|Pull complete)\s*$/i.test(
    plain,
  );
}

export async function runPackageInstall(
  command: string,
  cwd: string,
  timeoutMin: number,
  packageToken: string | null,
  userConfigPath = join(workRoot, ".facility-package-npmrc"),
) {
  if (!packageToken) return runShell(command, cwd, "shell", timeoutMin);
  await writeFile(userConfigPath, privateRegistryNpmrc(packageToken), { mode: 0o600 });
  const identity = untrustedSpawnIdentity();
  if (identity.uid !== undefined && identity.gid !== undefined) {
    await chown(userConfigPath, identity.uid, identity.gid);
  }
  try {
    return await runShell(command, cwd, "shell", timeoutMin, {
      NODE_AUTH_TOKEN: packageToken,
      NPM_CONFIG_USERCONFIG: userConfigPath,
    });
  } finally {
    await rm(userConfigPath, { force: true });
  }
}

export function privateRegistryInstallCommand(command: string) {
  return PRIVATE_REGISTRY_INSTALL_COMMANDS.has(command.trim());
}

export function privateRegistryNpmrc(token: string) {
  if (!token || /[\r\n]/.test(token)) throw new Error("package_registry_token_invalid");
  return `//npm.pkg.github.com/:_authToken=${token}\n`;
}

// Cap the self-reported checks file read so a runaway/malicious agent can't OOM
// the runner with a giant checks.jsonl. 256KB is far more than any real check set.
const MAX_SELF_REPORTED_CHECKS_BYTES = 256 * 1024;

async function emitChecks(cwd: string) {
  const path = join(cwd, ".agent-sdlc", "checks.jsonl");
  let body = "";
  try {
    body = await readCappedUtf8(path, MAX_SELF_REPORTED_CHECKS_BYTES);
  } catch {
    return;
  }
  await emit(parseSelfReportedChecks(body));
}

// Read at most maxBytes of a file as utf8; if the cap is hit, drop the (possibly
// truncated) trailing partial line so parsing stays well-formed.
async function readCappedUtf8(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return bytesRead < maxBytes ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

// Parse the agent's self-reported checks.jsonl into `check` events. self_reported
// is forced true LAST so an agent-authored line can't spoof platform provenance by
// setting self_reported:false, and each line is isolated in its own try/catch so
// one malformed line can't throw out the whole batch (or abort before the
// platform-owned checks run).
export function parseSelfReportedChecks(body: string) {
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [{ type: "check", data: { ...JSON.parse(line), self_reported: true } }];
      } catch {
        return [];
      }
    });
}

// Run the platform-owned acceptance gates (bundle.checkCmds) after the engine.
// Each command's pass/fail is emitted as a `check` event (self_reported: false,
// distinct from the agent's own checks.jsonl) and the run fails if any command
// exits non-zero. Vacuously true when no checks are configured — runs without
// gates are unaffected.
async function runChecks(bundle: RunBundle, cwd: string) {
  let allPassed = true;
  for (const command of bundle.checkCmds) {
    const { code, tail } = await runCheckCommand(command, cwd, bundle.timeoutMin);
    if (code !== 0) allPassed = false;
    // Injected secrets in the captured output are scrubbed centrally in emit().
    await emit([{ type: "check", data: checkEvent(command, code, tail) }]);
  }
  return allPassed;
}

// Shape of a platform-check event. `status` uses the passed/failed vocabulary the
// web cockpit tones on; output is carried only for failures (capped) so a red
// gate is debuggable without bloating the event log with green checks' logs.
export function checkEvent(command: string, code: number, tail: string) {
  return {
    self_reported: false,
    command,
    status: code === 0 ? "passed" : "failed",
    exit_code: code,
    ...(code === 0 || !tail ? {} : { output: tail.slice(-2000) }),
  };
}

// Run one check command, capturing a bounded tail of combined stdout+stderr for
// failure diagnostics. The command runs in its own process group (detached) so a
// hung check's ENTIRE tree — `pnpm test` spawning node workers, etc. — is
// signalled at the timeout, not just the top `sh` (whose death would orphan the
// workers until the sandbox is reaped).
export async function runCheckCommand(
  command: string,
  cwd: string,
  timeoutMin: number,
  maxOutputBytes = 4_000,
) {
  const child = spawn("sh", ["-c", command], {
    cwd,
    env: engineEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    ...untrustedSpawnIdentity(),
  });
  const clearTimers = armProcessGroupTimeout(child, timeoutMin);
  let tail = "";
  const capture = (stream: NodeJS.ReadableStream | null) =>
    new Promise<void>((resolve) => {
      if (!stream) return resolve();
      stream.on("data", (chunk) => {
        tail = (tail + chunk.toString()).slice(-maxOutputBytes);
      });
      stream.on("end", resolve);
      stream.on("error", () => resolve());
    });
  const drains = [capture(child.stdout), capture(child.stderr)];
  const code = await exitCode(child);
  await Promise.all(drains);
  clearTimers();
  return { code, tail: tail.trim() };
}

async function postResult(
  bundle: RunBundle | null,
  status: "succeeded" | "failed" | "canceled",
  startedAt: number,
  error?: Record<string, unknown> | string,
  git?: Record<string, unknown>,
  securityReport?: Record<string, unknown>,
) {
  const stderrTail = await readFile(engineStderrFile, "utf8").catch(() => "");
  const activity = await runnerReceiptActivity(bundle, status);
  await api(`/internal/runs/${currentRunId()}/result`, {
    method: "POST",
    body: JSON.stringify({
      status,
      receipt: {
        provider: receiptProvider(bundle?.engine),
        mode: receiptMode(bundle?.mode),
        model: configuredModel(bundle?.engineConfig),
        result: status,
        activity,
        timing: {
          started_at: new Date(startedAt).toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
        },
      },
      error:
        typeof error === "string"
          ? error
          : error
            ? redactSecrets(`${JSON.stringify(error)} ${stderrTail.slice(-2000)}`)
            : undefined,
      git,
      engineSessionId: engineSessionId ?? undefined,
      securityReport,
    }),
  });
}

const FACILITY_MANAGED_REPOSITORY_FILES = new Set([
  ".agent-sdlc/progress.md",
  ".agent-sdlc/checks.jsonl",
  ".agent-sdlc/delivery.json",
  ".agent-sdlc/security-findings.json",
]);

export async function runnerReceiptActivity(
  bundle: RunBundle | null,
  status: "succeeded" | "failed" | "canceled",
  root = workRoot,
) {
  const fileChanges = bundle ? await receiptFileChangeCount(bundle, root).catch(() => 0) : 0;
  return {
    turns: 0,
    shell_commands: 0,
    file_changes: fileChanges,
    mcp_tool_calls: 0,
    web_searches: 0,
    tool_calls: 0,
    errors: status === "failed" ? 1 : 0,
  };
}

async function receiptFileChangeCount(bundle: RunBundle, root: string) {
  const mode = normalizedMode(bundle.mode);
  if (!bundle.repo.cloneUrl || (!requiresDelivery(bundle.mode) && !repairRepositoryMode(mode))) {
    return 0;
  }

  const cwd = cwdFor(bundle, root);
  const baseRef = `origin/${bundle.repo.branch ?? "main"}`;
  const [tracked, untracked] = await Promise.all([
    gitOutput(cwd, ["diff", "--name-only", "-z", "--no-renames", baseRef, "--"]),
    gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  const changedPaths = new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
  for (const path of changedPaths) {
    if (facilityManagedRepositoryFile(bundle, path)) changedPaths.delete(path);
  }
  return changedPaths.size;
}

function facilityManagedRepositoryFile(bundle: RunBundle, path: string) {
  if (
    FACILITY_MANAGED_REPOSITORY_FILES.has(path) ||
    path.startsWith(".facility-sweep/") ||
    path.startsWith("node_modules/")
  ) {
    return true;
  }
  if (Object.hasOwn(bundle.harness?.files ?? {}, path)) return true;
  return bundle.skills.some((skill) => {
    const fileBase = safeName(skill.name);
    return (
      path === `.claude/skills/${fileBase}/SKILL.md` ||
      path === `.agents/skills/${fileBase}/SKILL.md`
    );
  });
}

export function requiresDelivery(mode: string) {
  return mode === "builder" || mode.endsWith("-builder");
}

type AgentDeliveryKind = "builder" | "repair";

function agentDeliveryKind(mode: string): AgentDeliveryKind | null {
  if (requiresDelivery(mode)) return "builder";
  return repairRepositoryMode(normalizedMode(mode)) ? "repair" : null;
}

export function githubCiOwnsAcceptance(bundle: Pick<RunBundle, "mode" | "repo">): boolean {
  if (!bundle.repo.cloneUrl?.startsWith("https://github.com/")) return false;
  const mode = normalizedMode(bundle.mode);
  return requiresDelivery(bundle.mode) || repairRepositoryMode(mode);
}

export function deliveryStatusEvent(
  git: Record<string, unknown> | undefined,
  deliveryError: string | null,
): RunEvent {
  const pushError = typeof git?.pushError === "string" ? git.pushError : null;
  const error = pushError ?? deliveryError;
  return {
    type: "delivery",
    data: {
      status: error ? "failed" : "prepared",
      changed: git?.changed === true,
      ...(error ? { error } : {}),
    },
  };
}

function isSecurityMode(mode: string) {
  return ["security", "security_sweep"].includes(normalizedMode(mode));
}

export function requiresAgentProgress(mode: string) {
  const normalized = mode.replace(/^codex-/, "").replace(/-/g, "_");
  return [
    "architect",
    "builder",
    "review",
    "address_review",
    "ci_doctor",
    "security_sweep",
    "po",
    "learning",
  ].includes(normalized);
}

function readOnlyEngineMode(mode: string) {
  return normalizedMode(mode) === "architect";
}

export function readOnlyEngineProgress(completed: boolean) {
  return [
    "Preparing an implementation-ready plan from the repository in read-only mode.",
    "",
    "- [x] Prepare the isolated repository",
    `${completed ? "- [x]" : "- [ ]"} Inspect the relevant code and produce the plan`,
  ].join("\n");
}

export function deliveryFailure(
  bundle: Pick<RunBundle, "mode" | "repo">,
  git: Record<string, unknown> | undefined,
): string | null {
  const mode = normalizedMode(bundle.mode);
  if (readOnlyRepositoryMode(mode) && git?.changed === true) {
    return "repository_changes_not_allowed";
  }
  if (repairRepositoryMode(mode)) {
    if (git?.changed !== true) return null;
    if (typeof git.pushError === "string" && git.pushError) return "delivery_push_failed";
    if (typeof git.branch !== "string" || !git.branch) return "delivery_branch_missing";
    if (typeof git.headSha !== "string" || !git.headSha) return "delivery_commit_missing";
    return null;
  }
  if (!requiresDelivery(bundle.mode)) {
    return git?.changed === true ? "repository_changes_not_allowed" : null;
  }
  if (!bundle.repo.cloneUrl) return "delivery_repo_not_configured";
  if (git?.changed !== true) return "delivery_no_changes";
  if (typeof git.pushError === "string" && git.pushError) return "delivery_push_failed";
  if (typeof git.branch !== "string" || !git.branch) return "delivery_branch_missing";
  if (typeof git.headSha !== "string" || !git.headSha) return "delivery_commit_missing";
  if (typeof git.pullRequestTitle !== "string" || !git.pullRequestTitle.trim()) {
    return "delivery_pr_title_missing";
  }
  if (typeof git.pullRequestBody !== "string" || !git.pullRequestBody.trim()) {
    return "delivery_pr_body_missing";
  }
  return null;
}

export type ShipGitOptions = {
  root?: string;
  githubFetch?: typeof fetch;
};

export async function shipGitChanges(
  bundle: RunBundle,
  options: ShipGitOptions = {},
): Promise<Record<string, unknown> | undefined> {
  if (!bundle.repo.cloneUrl) return undefined;
  const cwd = cwdFor(bundle, options.root ?? workRoot);
  const baseBranch = bundle.repo.branch ?? "main";
  try {
    // Stage the final workspace snapshot so this captures both agent commits and
    // uncommitted work while respecting .git/info/exclude for runner-managed files.
    await gitOutput(cwd, ["add", "-A"]);
    const baseRef = `origin/${baseBranch}`;
    const changes = await collectGithubFileChanges(cwd, baseRef);
    if (changes.length === 0) return { changed: false };
    const mode = normalizedMode(bundle.mode);
    if (
      readOnlyRepositoryMode(mode) ||
      (!requiresDelivery(bundle.mode) && !repairRepositoryMode(mode))
    ) {
      throw new Error("repository_changes_not_allowed");
    }
    const delivery = repairRepositoryMode(mode)
      ? await readAgentUpdateMetadata(join(cwd, ".agent-sdlc", "delivery.json"))
      : await readAgentDeliveryMetadata(join(cwd, ".agent-sdlc", "delivery.json"));
    const currentBranch = (await gitOutput(cwd, ["branch", "--show-current"])).trim();
    if (
      (repairRepositoryMode(mode) &&
        (currentBranch !== baseBranch || delivery.branch !== baseBranch)) ||
      (!repairRepositoryMode(mode) &&
        currentBranch !== baseBranch &&
        currentBranch !== delivery.branch)
    ) {
      throw new Error(
        `agent_delivery_branch_mismatch: current ${currentBranch}, manifest ${delivery.branch}`,
      );
    }
    // Builders choose a new semantic branch. Repair agents must update the exact
    // existing PR branch, which may legitimately use a repository-specific name
    // that does not follow Facility's new-branch convention.
    const requestedBranch = repairRepositoryMode(mode)
      ? existingGithubBranch(delivery.branch)
      : semanticDeliveryBranch(delivery.branch, baseBranch);
    const baseSha = (await gitOutput(cwd, ["rev-parse", baseRef])).trim();
    const repo = githubRepositoryName(bundle.repo.cloneUrl);
    const runId = currentRunId();
    // Validate every signed-commit headline before asking the platform to mint
    // a short-lived contents-write token. The publishers repeat this check at
    // their public boundary, but the runner must fail locally before acquiring
    // privileged credentials for an undeliverable message.
    assertGithubCommitMessages(delivery.commitMessage, changes.length, runId);
    if (repairRepositoryMode(mode)) {
      await assertRepairDeliveryReleaseImpact(
        cwd,
        bundle.scope,
        baseRef,
        delivery.commitMessage,
        runId,
      );
    }
    const { token } = await api<{ token: string }>(`/internal/runs/${runId}/push-token`, {
      method: "POST",
    });
    secretsToRedact.add(token);
    const published = repairRepositoryMode(mode)
      ? await publishVerifiedGithubBranchUpdate({
          repo,
          token,
          branch: requestedBranch,
          expectedHeadSha: baseSha,
          commitMessage: delivery.commitMessage,
          changes,
          runId,
          fetchImpl: options.githubFetch,
        })
      : await publishVerifiedGithubChanges({
          repo,
          token,
          requestedBranch,
          baseSha,
          commitMessage: delivery.commitMessage,
          changes,
          runId,
          fetchImpl: options.githubFetch,
        });
    const pullRequest = requiresDelivery(bundle.mode)
      ? (delivery as AgentDeliveryMetadata).pullRequest
      : null;
    return {
      branch: published.branch,
      headSha: published.headSha,
      baseSha,
      changed: true,
      ...(pullRequest
        ? {
            pullRequestTitle: pullRequest.title,
            pullRequestBody: pullRequest.body,
          }
        : {}),
    };
  } catch (error) {
    const pushError = redactSecrets(errorMessage(error));
    await emit([{ type: "artifact_error", data: { kind: "git_push_failed", error: pushError } }]);
    return { changed: true, pushError };
  }
}

type GithubFileChange =
  | { kind: "addition"; path: string; contents: string }
  | { kind: "deletion"; path: string };

const SEMANTIC_BRANCH =
  /^(feature|fix|chore|ci|docs|refactor|perf|test|build|revert)\/[a-z0-9][a-z0-9._/-]*$/;
const CONVENTIONAL_SUBJECT =
  /^(?<prefix>(?<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\((?=\S)[^()\r\n]*[^\s()\r\n]\))?(?<breaking>!)?: )(?<summary>\S.*)$/;
const PATCH_COMMIT_TYPES = new Set(["feat", "fix", "perf", "revert"]);
const DELIVERY_IMPACT_RANK = { none: 0, patch: 1, minor: 2 } as const;
const GITHUB_CHANGE_BATCH = 100;
const GITHUB_COMMIT_HEADLINE_LIMIT = 120;

function hasForbiddenSubjectCharacters(subject: string) {
  return [...subject].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

function conventionalSubject(message: string) {
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  if (hasForbiddenSubjectCharacters(subject)) return null;
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  const prefix = match?.groups?.prefix;
  const type = match?.groups?.type;
  const summary = match?.groups?.summary;
  return prefix && type && summary
    ? { subject, prefix, type, breaking: match?.groups?.breaking === "!", summary }
    : null;
}

function hasConventionalSubject(message: string) {
  return conventionalSubject(message) !== null;
}

function hasBreakingFooter(message: string) {
  const blocks = message
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split(/\n[ \t]*\n+/);
  if (blocks.length < 2) return false;
  const lines = (blocks.at(-1) ?? "").split("\n");
  const trailer = /^(?:(?:[A-Za-z0-9-]+|BREAKING CHANGE): +\S|[A-Za-z0-9-]+ #\S)/;
  const breakingTrailer = /^BREAKING(?: |-)CHANGE: +\S/;
  if (!trailer.test(lines[0] ?? "")) return false;
  return lines.some((line) => breakingTrailer.test(line));
}

type DeliveryReleaseImpact = keyof typeof DELIVERY_IMPACT_RANK;

export function deliveryReleaseImpact(message: string): DeliveryReleaseImpact {
  const parsed = conventionalSubject(message);
  if (!parsed) throw new Error("agent_delivery_commit_not_conventional");
  if (parsed.breaking || hasBreakingFooter(message)) return "minor";
  return PATCH_COMMIT_TYPES.has(parsed.type) ? "patch" : "none";
}

function maximumDeliveryReleaseImpact(messages: string[]) {
  return messages.reduce<DeliveryReleaseImpact>((highest, message) => {
    const impact = deliveryReleaseImpact(message);
    return DELIVERY_IMPACT_RANK[impact] > DELIVERY_IMPACT_RANK[highest] ? impact : highest;
  }, "none");
}

function assertDeliveryReleaseImpact(commitMessage: string, pullRequestTitle: string) {
  // GitHub stores headline and body as one commit message separated by a
  // blank line. Classify that exact transported message, including Facility's
  // provenance paragraph, rather than the raw manifest text.
  const transported = githubCommitMessage(commitMessage, "", "release-impact-check");
  const commitImpact = deliveryReleaseImpact(`${transported.headline}\n\n${transported.body}`);
  const titleImpact = deliveryReleaseImpact(pullRequestTitle);
  if (commitImpact !== titleImpact) {
    throw new Error(
      `agent_delivery_release_impact_mismatch: commit ${commitImpact}, pull request title ${titleImpact}`,
    );
  }
}

async function assertRepairDeliveryReleaseImpact(
  cwd: string,
  scope: Record<string, unknown>,
  headRef: string,
  commitMessage: string,
  runId: string,
) {
  const pullRequest = objectValue(scope.pullRequest);
  const baseBranch = typeof pullRequest.base === "string" ? pullRequest.base.trim() : "";
  if (!baseBranch) throw new Error("agent_delivery_pr_base_missing");
  existingGithubBranch(baseBranch);
  const baseRef = `origin/${baseBranch}`;
  const output = await gitOutput(cwd, [
    "log",
    "-z",
    "--no-merges",
    "--format=%B",
    `${baseRef}..${headRef}`,
    "--",
  ]);
  const messages = output ? output.split("\0") : [];
  if (messages.at(-1) === "") messages.pop();
  if (messages.length === 0) throw new Error("agent_delivery_pr_range_empty");
  const currentImpact = maximumDeliveryReleaseImpact(messages);
  const transported = githubCommitMessage(commitMessage, "", runId);
  const addedImpact = deliveryReleaseImpact(`${transported.headline}\n\n${transported.body}`);
  const finalImpact =
    DELIVERY_IMPACT_RANK[addedImpact] > DELIVERY_IMPACT_RANK[currentImpact]
      ? addedImpact
      : currentImpact;
  const title = typeof pullRequest.title === "string" ? pullRequest.title : "";
  const titleImpact = title ? deliveryReleaseImpact(title) : null;
  if (titleImpact && titleImpact !== finalImpact) {
    throw new Error(
      `agent_delivery_release_impact_mismatch: pull request title ${titleImpact}, final PR range ${finalImpact}`,
    );
  }
  if (
    titleImpact === null &&
    DELIVERY_IMPACT_RANK[addedImpact] > DELIVERY_IMPACT_RANK[currentImpact]
  ) {
    throw new Error(
      `agent_delivery_release_impact_mismatch: repair commit ${addedImpact}, existing PR range ${currentImpact}, title unavailable`,
    );
  }
}

function githubCommitMessage(commitMessage: string, multipart: string, runId: string) {
  const parsed = conventionalSubject(commitMessage);
  if (!parsed) throw new Error("github_signed_delivery_commit_not_conventional");
  const availableSummaryCharacters =
    GITHUB_COMMIT_HEADLINE_LIMIT - [...parsed.prefix].length - [...multipart].length;
  if (availableSummaryCharacters < 1) {
    throw new Error("github_signed_delivery_commit_subject_too_long");
  }
  const summary = [...parsed.summary].slice(0, availableSummaryCharacters).join("").trimEnd();
  const headline = `${parsed.prefix}${summary}${multipart}`;
  if (!hasConventionalSubject(headline)) {
    throw new Error("github_signed_delivery_commit_subject_too_long");
  }
  const [, ...bodyLines] = commitMessage.split(/\r?\n/);
  if (bodyLines.length > 0 && !/^[ \t]*$/.test(bodyLines[0] ?? "")) {
    throw new Error("github_signed_delivery_commit_body_separator_invalid");
  }
  // Remove only the required structural separator. Preserve leading
  // indentation because stripping it can turn a code example into a trailer.
  const suppliedBody = bodyLines.slice(1).join("\n").trimEnd();
  return {
    headline,
    body: [`Delivered by Facility run ${runId}.`, suppliedBody].filter(Boolean).join("\n\n"),
  };
}

function assertGithubCommitMessages(commitMessage: string, changeCount: number, runId: string) {
  const batchCount = Math.ceil(changeCount / GITHUB_CHANGE_BATCH);
  for (let index = 0; index < batchCount; index += 1) {
    const multipart = batchCount > 1 ? ` (part ${index + 1}/${batchCount})` : "";
    githubCommitMessage(commitMessage, multipart, runId);
  }
}

export function semanticDeliveryBranch(current: string, base: string) {
  if (current !== base && SEMANTIC_BRANCH.test(current)) return current;
  throw new Error("agent_delivery_branch_not_semantic");
}

function existingGithubBranch(branch: string) {
  if (
    !branch ||
    branch.length > 255 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    [...branch].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    }) ||
    ["~", "^", ":", "?", "*", "[", "\\"].some((char) => branch.includes(char))
  ) {
    throw new Error("agent_delivery_branch_invalid");
  }
  return branch;
}

function normalizedMode(mode: string) {
  return mode.replace(/^codex-/, "").replace(/-/g, "_");
}

function repairRepositoryMode(mode: string) {
  return mode === "address_review" || mode === "ci_doctor";
}

export function readOnlyRepositoryMode(mode: string) {
  const normalized = normalizedMode(mode);
  return (
    normalized === "architect" ||
    normalized === "review" ||
    normalized === "security_sweep" ||
    normalized === "learning"
  );
}

export function parseGitNameStatus(raw: string) {
  const fields = raw.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) throw new Error("git_name_status_malformed");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index] ?? "", path: fields[index + 1] ?? "" });
  }
  return entries;
}

async function collectGithubFileChanges(cwd: string, baseRef: string) {
  const modeChanges = (await gitOutput(cwd, ["diff", "--cached", "--summary", baseRef, "--"]))
    .split("\n")
    .filter((line) => line.trim().startsWith("mode change"));
  if (modeChanges.length > 0) {
    throw new Error(`github_signed_delivery_mode_change_unsupported: ${modeChanges.join(", ")}`);
  }
  const raw = await gitOutput(cwd, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--no-renames",
    baseRef,
    "--",
  ]);
  const changes: GithubFileChange[] = [];
  for (const entry of parseGitNameStatus(raw)) {
    safeRepositoryPath(entry.path);
    if (entry.status.startsWith("D")) {
      changes.push({ kind: "deletion", path: entry.path });
      continue;
    }
    const path = join(cwd, entry.path);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`github_signed_delivery_symlink_unsupported: ${entry.path}`);
    }
    if (!metadata.isFile()) throw new Error(`github_signed_delivery_not_a_file: ${entry.path}`);
    changes.push({
      kind: "addition",
      path: entry.path,
      contents: (await readFile(path)).toString("base64"),
    });
  }
  return changes;
}

function safeRepositoryPath(path: string) {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`github_signed_delivery_invalid_path: ${path}`);
  }
}

function githubRepositoryName(cloneUrl: string) {
  const match = cloneUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("github_signed_delivery_requires_github_repo");
  return `${match[1]}/${match[2]}`;
}

export type AgentDeliveryMetadata = {
  branch: string;
  commitMessage: string;
  pullRequest: { title: string; body: string };
};

function hasExactObjectKeys(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export async function readAgentDeliveryMetadata(path: string): Promise<AgentDeliveryMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`agent_delivery_metadata_missing_or_invalid: ${errorMessage(error)}`);
  }
  const root = objectValue(parsed);
  const pullRequest = objectValue(root.pullRequest);
  if (
    !hasExactObjectKeys(parsed, ["branch", "commitMessage", "pullRequest"]) ||
    !hasExactObjectKeys(root.pullRequest, ["title", "body"])
  ) {
    throw new Error("agent_delivery_metadata_shape_invalid");
  }
  const branch = typeof root.branch === "string" ? root.branch.trim() : "";
  const commitMessage = typeof root.commitMessage === "string" ? root.commitMessage : "";
  const title = typeof pullRequest.title === "string" ? pullRequest.title : "";
  const body = typeof pullRequest.body === "string" ? pullRequest.body.trim() : "";
  if (!SEMANTIC_BRANCH.test(branch)) throw new Error("agent_delivery_branch_not_semantic");
  if (!hasConventionalSubject(commitMessage) || /(^|\n)Co-authored-by:/i.test(commitMessage)) {
    throw new Error("agent_delivery_commit_not_conventional");
  }
  if (
    hasForbiddenSubjectCharacters(title) ||
    !hasConventionalSubject(title) ||
    title.length > 256
  ) {
    throw new Error("agent_delivery_pr_title_not_conventional");
  }
  assertDeliveryReleaseImpact(commitMessage, title);
  if (!body || body.length > 60_000) throw new Error("agent_delivery_pr_body_invalid");
  return { branch, commitMessage, pullRequest: { title, body } };
}

export async function readAgentUpdateMetadata(
  path: string,
): Promise<Pick<AgentDeliveryMetadata, "branch" | "commitMessage">> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`agent_delivery_metadata_missing_or_invalid: ${errorMessage(error)}`);
  }
  const root = objectValue(parsed);
  if (!hasExactObjectKeys(parsed, ["branch", "commitMessage"])) {
    throw new Error("agent_delivery_metadata_shape_invalid");
  }
  const branch = typeof root.branch === "string" ? root.branch.trim() : "";
  const commitMessage = typeof root.commitMessage === "string" ? root.commitMessage : "";
  existingGithubBranch(branch);
  if (!hasConventionalSubject(commitMessage) || /(^|\n)Co-authored-by:/i.test(commitMessage)) {
    throw new Error("agent_delivery_commit_not_conventional");
  }
  return { branch, commitMessage };
}

export type AgentDeliveryWriteInput = {
  branch: string;
  commitMessage: string;
  pullRequest?: { title: string; body: string };
};

export async function writeAgentDeliveryReceipt(
  path: string,
  kind: AgentDeliveryKind,
  input: AgentDeliveryWriteInput,
) {
  const receipt =
    kind === "builder"
      ? {
          branch: input.branch,
          commitMessage: input.commitMessage,
          pullRequest: input.pullRequest,
        }
      : { branch: input.branch, commitMessage: input.commitMessage };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return kind === "builder" ? readAgentDeliveryMetadata(path) : readAgentUpdateMetadata(path);
}

function deliveryCliFlags(args: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`facility_delivery_argument_invalid: ${name ?? "missing"}`);
    }
    if (flags.has(name)) throw new Error(`facility_delivery_argument_duplicate: ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function requiredDeliveryFlag(flags: Map<string, string>, name: string) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`facility_delivery_argument_missing: ${name}`);
  return value;
}

async function deliveryTextFlag(flags: Map<string, string>, inlineName: string, fileName: string) {
  const inline = flags.get(inlineName);
  const file = flags.get(fileName);
  if (inline !== undefined && file !== undefined) {
    throw new Error(`facility_delivery_argument_conflict: ${inlineName}, ${fileName}`);
  }
  const value = file === undefined ? inline : await readFile(file, "utf8");
  if (!value?.trim()) throw new Error(`facility_delivery_argument_missing: ${inlineName}`);
  return value.trimEnd();
}

function facilityDeliveryEnvironment() {
  const kind = process.env.FACILITY_DELIVERY_KIND;
  if (kind !== "builder" && kind !== "repair") {
    throw new Error("facility_delivery_not_configured");
  }
  const cwd = process.env.FACILITY_DELIVERY_REPOSITORY;
  if (!cwd) throw new Error("facility_delivery_repository_missing");
  return { kind, cwd } as const;
}

async function repositoryHasChanges(cwd: string) {
  const baseBranch = process.env.FACILITY_DELIVERY_BASE_BRANCH ?? "main";
  const tracked = await gitOutput(cwd, ["diff", "--name-only", `origin/${baseBranch}`, "--"]);
  if (tracked.trim()) return true;
  const untracked = await gitOutput(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return Boolean(untracked.trim());
}

async function validateConfiguredDelivery() {
  const { kind, cwd } = facilityDeliveryEnvironment();
  const path = join(cwd, ".agent-sdlc", "delivery.json");
  return kind === "builder" ? readAgentDeliveryMetadata(path) : readAgentUpdateMetadata(path);
}

export async function deliveryHookDecision() {
  try {
    const { cwd } = facilityDeliveryEnvironment();
    if (!(await repositoryHasChanges(cwd))) return null;
    await validateConfiguredDelivery();
    return null;
  } catch (error) {
    return {
      decision: "block" as const,
      reason: `Facility cannot accept this delivery receipt (${errorMessage(error)}). Use the runner-owned \`facility-delivery write ...\` command shown in your system instructions, then run \`facility-delivery validate\`. Do not write .agent-sdlc/delivery.json by hand.`,
    };
  }
}

export async function deliveryCliMain(args: string[]) {
  const command = args[0];
  if (command === "validate") {
    await validateConfiguredDelivery();
    process.stdout.write("Facility delivery receipt is valid.\n");
    return;
  }
  if (command === "hook") {
    const decision = await deliveryHookDecision();
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
    return;
  }
  if (command !== "write") throw new Error("facility_delivery_usage: expected write or validate");
  const { kind, cwd } = facilityDeliveryEnvironment();
  const flags = deliveryCliFlags(args.slice(1));
  const branch = requiredDeliveryFlag(flags, "--branch");
  const commitMessage = await deliveryTextFlag(flags, "--commit-message", "--commit-message-file");
  const pullRequest =
    kind === "builder"
      ? {
          title: requiredDeliveryFlag(flags, "--pr-title"),
          body: await deliveryTextFlag(flags, "--pr-body", "--pr-body-file"),
        }
      : undefined;
  const allowed = new Set([
    "--branch",
    "--commit-message",
    "--commit-message-file",
    ...(kind === "builder" ? ["--pr-title", "--pr-body", "--pr-body-file"] : []),
  ]);
  const unknown = [...flags.keys()].find((name) => !allowed.has(name));
  if (unknown) throw new Error(`facility_delivery_argument_unknown: ${unknown}`);
  await writeAgentDeliveryReceipt(join(cwd, ".agent-sdlc", "delivery.json"), kind, {
    branch,
    commitMessage,
    pullRequest,
  });
  process.stdout.write("Facility delivery receipt written and validated.\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function publishVerifiedGithubChanges(input: {
  repo: string;
  token: string;
  requestedBranch: string;
  baseSha: string;
  commitMessage: string;
  changes: GithubFileChange[];
  runId: string;
  fetchImpl?: typeof fetch;
}) {
  assertGithubCommitMessages(input.commitMessage, input.changes.length, input.runId);
  const request = input.fetchImpl ?? fetch;
  const branch = await availableGithubBranch(
    request,
    input.repo,
    input.requestedBranch,
    input.runId,
    input.token,
  );
  await githubRequest(request, `https://api.github.com/repos/${input.repo}/git/refs`, input.token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: input.baseSha }),
  });
  const headSha = await commitVerifiedGithubChanges({
    ...input,
    request,
    branch,
    expectedHeadSha: input.baseSha,
  });
  return { branch, headSha };
}

export async function publishVerifiedGithubBranchUpdate(input: {
  repo: string;
  token: string;
  branch: string;
  expectedHeadSha: string;
  commitMessage: string;
  changes: GithubFileChange[];
  runId: string;
  fetchImpl?: typeof fetch;
}) {
  existingGithubBranch(input.branch);
  assertGithubCommitMessages(input.commitMessage, input.changes.length, input.runId);
  const request = input.fetchImpl ?? fetch;
  const headSha = await commitVerifiedGithubChanges({ ...input, request });
  return { branch: input.branch, headSha };
}

async function commitVerifiedGithubChanges(input: {
  repo: string;
  token: string;
  branch: string;
  expectedHeadSha: string;
  commitMessage: string;
  changes: GithubFileChange[];
  runId: string;
  request: typeof fetch;
}) {
  const batches = chunk(input.changes, GITHUB_CHANGE_BATCH);
  let expectedHeadOid = input.expectedHeadSha;
  for (const [index, changes] of batches.entries()) {
    const additions = changes
      .filter(
        (change): change is Extract<GithubFileChange, { kind: "addition" }> =>
          change.kind === "addition",
      )
      .map(({ path, contents }) => ({ path, contents }));
    const deletions = changes
      .filter(
        (change): change is Extract<GithubFileChange, { kind: "deletion" }> =>
          change.kind === "deletion",
      )
      .map(({ path }) => ({ path }));
    const multipart = batches.length > 1 ? ` (part ${index + 1}/${batches.length})` : "";
    const message = githubCommitMessage(input.commitMessage, multipart, input.runId);
    const data = await githubRequest<{
      data?: { createCommitOnBranch?: { commit?: { oid?: string } } };
      errors?: Array<{ message?: string }>;
    }>(input.request, "https://api.github.com/graphql", input.token, {
      method: "POST",
      body: JSON.stringify({
        query:
          "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        variables: {
          input: {
            branch: { repositoryNameWithOwner: input.repo, branchName: input.branch },
            expectedHeadOid,
            message,
            fileChanges: {
              ...(additions.length > 0 ? { additions } : {}),
              ...(deletions.length > 0 ? { deletions } : {}),
            },
          },
        },
      }),
    });
    if (data.errors?.length) {
      throw new Error(
        `github_signed_delivery_graphql_failed: ${data.errors.map((error) => error.message).join("; ")}`,
      );
    }
    const oid = data.data?.createCommitOnBranch?.commit?.oid;
    if (!oid) throw new Error("github_signed_delivery_missing_commit_oid");
    expectedHeadOid = oid;
  }
  return expectedHeadOid;
}

async function availableGithubBranch(
  request: typeof fetch,
  repo: string,
  requested: string,
  runId: string,
  token: string,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${runId.slice(-8)}${attempt === 1 ? "" : `-${attempt}`}`;
    const candidate = `${requested}${suffix}`;
    const response = await githubFetch(
      request,
      `https://api.github.com/repos/${repo}/git/ref/heads/${candidate
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      { headers: githubHeaders(token) },
    );
    if (response.status === 404) return candidate;
    if (!response.ok) {
      throw new Error(`github_ref_lookup_failed_${response.status}: ${await response.text()}`);
    }
  }
  throw new Error("github_semantic_branch_unavailable");
}

export async function githubRequest<T = Record<string, unknown>>(
  request: typeof fetch,
  url: string,
  token: string,
  init: RequestInit,
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
) {
  const response = await githubFetch(
    request,
    url,
    {
      ...init,
      headers: {
        ...githubHeaders(token),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`github_signed_delivery_http_${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function githubFetch(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return request(url, { ...init, signal });
}

function githubHeaders(token: string) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "facility-runner",
  };
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

export async function gitOutput(
  cwd: string,
  args: string[],
  trustedBootstrap = false,
  timeoutMs = GIT_COMMAND_TIMEOUT_MS,
  input?: string | Buffer,
) {
  const child = spawn("git", ["-c", `safe.directory=${cwd}`, ...args], {
    cwd,
    env: trustedBootstrap ? process.env : engineEnv(),
    // Always close a pipe for commands without input; this is equivalent to an
    // ignored stdin while keeping the child streams statically non-null.
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    ...(trustedBootstrap ? {} : untrustedSpawnIdentity()),
  });
  child.stdin.end(input);
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessGroup(child, "SIGTERM");
    killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 5_000);
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await exitCode(child);
  clearTimeout(timeout);
  if (timedOut) {
    if (killTimer) clearTimeout(killTimer);
    // The Git parent can exit on SIGTERM while an inherited process group
    // member ignores it. Escalate once more before returning so clearing the
    // grace timer cannot orphan that resistant descendant.
    signalProcessGroup(child, "SIGKILL");
    throw new Error(`git ${args[0] ?? "command"} timed out after ${timeoutMs}ms`);
  }
  if (killTimer) clearTimeout(killTimer);
  if (code !== 0) throw new Error(redactSecrets(`git ${args[0]} exited ${code}: ${stderr}`));
  return stdout;
}

// Recursively scrub injected secrets from every string in a value — the engine's
// parsed assistant/tool/result payloads are agent-influenced and carry the same
// injected env, so redaction must cover them, not just shell/check output.
export function redactEventData(
  value: unknown,
  secrets: Iterable<string> = secretsToRedact,
): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactEventData(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      // Redact the KEY too: an agent-influenced payload could carry an injected
      // secret as a property name, not just a value.
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        redactSecrets(k, secrets),
        redactEventData(v, secrets),
      ]),
    );
  }
  return value;
}

function redactRunEvent(event: RunEvent): RunEvent {
  return event.data
    ? { ...event, data: redactEventData(event.data) as Record<string, unknown> }
    : event;
}

async function emit(events: RunEvent[]) {
  if (events.length === 0) return;
  // Central redaction: every event that reaches run_events (readable by any
  // runs:read principal) is scrubbed here, regardless of which producer emitted it.
  const safe = events.map(redactRunEvent);
  await api(`/internal/runs/${currentRunId()}/events`, {
    method: "POST",
    body: JSON.stringify(safe),
  });
}

export { emit as emitRunEvents };

async function api<T>(
  path: string,
  init: RequestInit = {},
  bodyFactory?: () => RequestInit["body"],
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${runnerToken()}` };
  if (init.body) headers["content-type"] = "application/json";
  return fetchJson(
    `${apiUrl()}${path}`,
    {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    },
    bodyFactory,
  ) as Promise<T>;
}

export function retryAfterMs(value: string | null, now = Date.now()) {
  if (value) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
    if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s/.test(trimmed)) {
      const date = Date.parse(trimmed);
      if (Number.isFinite(date)) {
        return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
      }
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

export async function fetchJson(
  url: string,
  init: RequestInit = {},
  bodyFactory?: () => RequestInit["body"],
) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, bodyFactory ? { ...init, body: bodyFactory() } : init);
    if (response.ok) return response.json();
    const body = await response.text();
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRY_LIMIT) {
      throw new Error(`${url} failed ${response.status}: ${body}`);
    }
    // The global API limiter rejects the request before a route handler runs,
    // so replaying the runner's JSON request after Retry-After cannot duplicate
    // an accepted event or terminal result. Awaiting here applies backpressure
    // to noisy child processes instead of turning a temporary 429 into a crash.
    await new Promise((resolve) =>
      setTimeout(resolve, retryAfterMs(response.headers.get("retry-after"))),
    );
  }
}

export function engineEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: "/work" };
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Registry credentials are granted only to the dedicated dependency-install
  // child. They must never reach provisioning scripts, checks, or the model.
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.npm_config_userconfig;
  // Never expose the runner's internal-lifecycle credential to the (untrusted)
  // engine or check commands. With RUNNER_TOKEN a compromised agent could call
  // /internal/runs/:id/{events,result} for its own run to forge platform-provenance
  // check events or post a fake `succeeded` result — bypassing the very acceptance
  // gates the runner enforces. The runner keeps its own RUNNER_TOKEN in its process
  // env for its api() calls; the child simply never inherits it. (The agent still
  // reaches the platform's v1 API via FACILITY_API_URL + FACILITY_PLATFORM_KEY,
  // which are separately authorized and cannot touch run lifecycle.)
  delete env.RUNNER_TOKEN;
  return env;
}

/**
 * Trust only Facility's ephemeral workspace so Claude Code honors the checked-in
 * project settings and guards without an interactive first-run dialog.
 *
 * Provisioning runs before the engine and is untrusted, so replace any path it
 * left behind with an exclusive, no-follow create. A raced path fails closed
 * instead of letting the lifecycle process overwrite a symlink target as root.
 */
export async function trustClaudeWorkspace(
  workspace: string,
  home = workRoot,
  identity = untrustedSpawnIdentity(),
) {
  const configPath = join(home, ".claude.json");
  const trustedWorkspace = await realpath(workspace);
  await rm(configPath, { force: true });
  const handle = await open(
    configPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(
      `${JSON.stringify({ projects: { [trustedWorkspace]: { hasTrustDialogAccepted: true } } })}\n`,
    );
    // Keep ownership and mode changes bound to the descriptor opened with
    // O_NOFOLLOW. A path-based chown/chmod after close would let an untrusted
    // background process swap in a symlink between those operations.
    if (identity.uid !== undefined && identity.gid !== undefined) {
      await handle.chown(identity.uid, identity.gid);
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return configPath;
}

export function untrustedSpawnIdentity(getuid: (() => number) | undefined = process.getuid): {
  uid?: number;
  gid?: number;
} {
  if (getuid?.() !== 0) return {};
  return {
    uid: Number(process.env.FACILITY_UNTRUSTED_UID ?? "1000"),
    gid: Number(process.env.FACILITY_UNTRUSTED_GID ?? "1000"),
  };
}

async function grantWorkspaceToUntrusted() {
  const identity = untrustedSpawnIdentity();
  if (identity.uid === undefined || identity.gid === undefined) return;
  const workspaceGid = identity.gid;
  await runCommand("chown", ["-R", `${identity.uid}:${workspaceGid}`, workRoot], workRoot);
  await runCommand("chmod", ["-R", "g+rwX", workRoot], workRoot);
  await runCommand("find", [workRoot, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], workRoot);
  // Keep the sticky workspace root owned by the lifecycle process. The agent
  // owns its children, but cannot rename or replace the root-owned runtime
  // directory created next to them.
  await chown(workRoot, 0, workspaceGid);
  await chmod(workRoot, 0o3770);
}

async function grantPathToUntrusted(path: string) {
  const identity = untrustedSpawnIdentity();
  if (identity.uid === undefined || identity.gid === undefined) return;
  await runCommand("chown", ["-R", `${identity.uid}:${identity.gid}`, path], dirname(path));
  await runCommand("chmod", ["-R", "u+rwX", path], dirname(path));
}

async function prepareRunnerRuntime() {
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(steerFile, "", { mode: 0o644 });
  if (process.getuid?.() === 0) {
    await chown(runtimeRoot, 0, 0);
    await chmod(runtimeRoot, 0o755);
    await chown(steerFile, 0, 0);
    await chmod(steerFile, 0o644);
  }
}

function cwdFor(bundle: RunBundle, root = workRoot) {
  return bundle.repo.cloneUrl ? repoDirFor(root) : scratchDirFor(root);
}

function repoDirFor(root: string) {
  return join(root, "repo");
}

function scratchDirFor(root: string) {
  return join(root, "scratch");
}

async function runCommand(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

export function exitCode(child: ReturnType<typeof spawn>) {
  // A stdout consumer can observe EOF after the child has already emitted
  // `close`. Subscribing only afterwards leaves the runner waiting forever and
  // prevents final checks/results (including the GitHub plan) from publishing.
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1)));
}

// Package installation and provisioning remain bounded setup commands. Agent
// execution deliberately does not use this timer.
function armCommandTimeout(child: ReturnType<typeof spawn>, timeoutMin: number) {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const termTimer = setTimeout(
    () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    },
    Math.max(1, timeoutMin - 2) * 60_000,
  );
  return () => {
    clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  };
}

// Like armCommandTimeout, but signals the child's whole PROCESS GROUP (negative
// pid) — the child must have been spawned `detached: true`. Used for checks so a
// hung command's descendants die with it instead of being orphaned. Falls back to
// signalling just the child if the group is already gone.
function armProcessGroupTimeout(child: ReturnType<typeof spawn>, timeoutMin: number) {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const termTimer = setTimeout(
    () => {
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 15_000);
    },
    Math.max(1, timeoutMin - 2) * 60_000,
  );
  return () => {
    clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  };
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

export function composedPrompt(bundle: RunBundle) {
  const harnessNote = bundle.harness?.files
    ? "\n\nProject harness/KB context is in ./harness/SESSION.md - read it first."
    : "";
  const steeringNote =
    "\n\nHuman steering may arrive in /work/.facility-runtime/STEERING.md while you work (it starts empty and is runner-owned). Re-read it after finishing each task or before major decisions; if it contains new instructions, follow them.";
  const conversationNote =
    bundle.scope.type === "conversation" && typeof bundle.scope.message === "string"
      ? `\n\n## Conversation\n${bundle.scope.message}`
      : "";
  const objective = runObjectiveText(bundle.scope);
  const objectiveNote =
    bundle.scope.type !== "conversation" && objective ? `\n\n## Run objective\n${objective}` : "";
  const progressNote =
    requiresAgentProgress(bundle.mode) && !readOnlyEngineMode(bundle.mode)
      ? `\n\n## Live GitHub progress\nBefore substantive work, create \`.agent-sdlc/progress.md\` with a short task-specific context and a Markdown checkbox list of the steps you decided this task needs. Update it whenever you start or finish a step so a reviewer can understand real progress from GitHub. Keep it accurate and concise; do not put secrets, generic lifecycle milestones, or the final response in it. Facility transports this file into the existing GitHub progress comment.`
      : "";
  const repositoryOutputNote = bundle.repo.cloneUrl
    ? `\n\n## Repository output\nYour final response may be published directly on GitHub. Refer to repository files with relative paths or inline code. Never emit sandbox-local paths such as \`/work/repo/...\`.`
    : "";
  const githubEventNote =
    bundle.scope.type === "github_event"
      ? `\n\n## GitHub event context\nTreat the Scope JSON below as the authoritative, platform-captured GitHub event packet. It includes the pull request or failure, review feedback, and—when Facility produced the branch—the original issue request, accepted plan, producing run, receipt checks, and successful follow-up repair history. A verified follow-up may legitimately extend the original plan when it implements explicit review feedback; judge the current diff against the full governed chain. Do not depend on \`gh\` or direct GitHub API access: the sandbox clone credential is intentionally contents-only, and Facility publishes your progress and final response through the installed GitHub App.`
      : "";
  const projectSkillsNote = bundle.skills.length
    ? `\n\n## Active project skills\nFacility materialized the following active registry skills for this run. Read and apply each relevant \`SKILL.md\`; these are managed inputs, so do not modify or commit them.\n${[
        ...new Map(bundle.skills.map((skill) => [safeName(skill.name), skill.name])).entries(),
      ]
        .map(
          ([fileBase, name]) =>
            `- ${name}: \`.agents/skills/${fileBase}/SKILL.md\` (also available at \`.claude/skills/${fileBase}/SKILL.md\`)`,
        )
        .join("\n")}`
    : "";
  const deliveryNote = requiresDelivery(bundle.mode)
    ? `\n\n## Agent-owned delivery\nFacility will create the signed commit, push, and draft pull request with the GitHub App after your engine exits. GitHub Actions is the authoritative acceptance boundary: do not duplicate the repository's full configured CI suite inside this sandbox. Run focused checks that help you iterate on the changed behavior, report their results accurately, and let the durable draft PR retain the work while CI and repair agents continue. You own the delivery metadata values, while the runner owns their machine-readable representation. Write the complete PR body to a temporary file, then run \`facility-delivery write --branch "feature/task-slug" --commit-message "feat: describe the change" --pr-title "feat: describe the change" --pr-body-file /tmp/facility-pr-body.md\` followed by \`facility-delivery validate\`. Do not write or commit \`.agent-sdlc/delivery.json\` by hand. The branch must be semantic; the commit and PR title must use Conventional Commits and have the same release impact. If the commit has a \`BREAKING CHANGE:\` footer, mark the PR title with \`!\` too. The PR body must be your complete team-lead-ready description. Do not require \`gh\`, a writable clone token, or a local signing key: Facility transports the validated metadata and fails closed if it is absent or invalid.`
    : "";
  const repairDeliveryNote = repairRepositoryMode(normalizedMode(bundle.mode))
    ? `\n\n## Agent-owned PR update\nIf and only if you make verified repository changes, run \`facility-delivery write --branch "<the existing PR branch>" --commit-message "<matching Conventional Commit type>: describe the correction"\` followed by \`facility-delivery validate\`. Do not write or commit \`.agent-sdlc/delivery.json\` by hand. Facility will add a signed commit to that same branch through the GitHub App. The branch must exactly match the checked-out PR branch. Choose a truthful Conventional Commit type whose release impact is no greater than the existing pull request range; do not add \`!\` or a \`BREAKING CHANGE:\` footer unless that range is already breaking. If a truthful message would raise the impact, leave the receipt absent and report that the PR title must be updated first. Do not run \`git push\`, create another branch or pull request, force-push, or depend on \`gh\`. If no code change is needed, do not create the receipt.`
    : "";
  return `${bundle.contract}\n\nScope:\n${JSON.stringify(bundle.scope, null, 2)}${harnessNote}${steeringNote}${conversationNote}${objectiveNote}${progressNote}${repositoryOutputNote}${githubEventNote}${projectSkillsNote}${deliveryNote}${repairDeliveryNote}`;
}

export function buildCodexArgs(bundle: RunBundle) {
  const provider = "facility_gateway";
  const providerBaseUrl = codexProviderBaseUrl(bundle.gatewayUrls.openai);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-s",
    readOnlyEngineMode(bundle.mode) ? "read-only" : "danger-full-access",
    "--config",
    `model_provider=${JSON.stringify(provider)}`,
    "--config",
    `model_providers.${provider}.name="Facility Gateway"`,
    "--config",
    `model_providers.${provider}.base_url=${JSON.stringify(providerBaseUrl)}`,
    "--config",
    `model_providers.${provider}.env_key="OPENAI_API_KEY"`,
    "--config",
    `model_providers.${provider}.wire_api="responses"`,
    "--config",
    `model_providers.${provider}.supports_websockets=false`,
  ];
  const model = configuredModel(bundle.engineConfig);
  if (model) args.push("--model", model);
  const effort = bundle.engineConfig.reasoning_effort ?? bundle.engineConfig.reasoningEffort;
  if (typeof effort === "string" && effort) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  // `codex exec -` reads the prompt from stdin. Keeping run scope out of argv
  // avoids E2BIG for the intentionally rich nightly learning packet.
  args.push("-");
  return args;
}

function codexProviderBaseUrl(value: string) {
  const base = value.replace(/\/$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function addModelFlags(args: string[], config: Record<string, unknown>) {
  const model = configuredModel(config);
  if (model) args.push("--model", model);
}

function configuredModel(config: Record<string, unknown> | undefined) {
  if (!config) return undefined;
  for (const candidate of [config.model, config.primary]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function receiptProvider(engine: RunBundle["engine"] | undefined) {
  if (engine === "claude_code") return "claude_code";
  if (engine === "codex") return "codex_cli";
  return "byo";
}

function receiptMode(mode: string | undefined) {
  const normalized = mode?.replace(/^codex-/, "").replace(/-/g, "_");
  return [
    "architect",
    "builder",
    "review",
    "address_review",
    "ci_doctor",
    "security_sweep",
    "po",
    "learning",
  ].includes(normalized ?? "")
    ? normalized
    : "custom";
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function materializedSkillContent(name: string, content: string) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("---\n") || trimmed.startsWith("---\r\n")) return content;
  return [
    "---",
    `name: ${JSON.stringify(safeName(name))}`,
    `description: ${JSON.stringify(`Project-managed Facility skill: ${name}`)}`,
    "---",
    "",
    content,
  ].join("\n");
}

function requiredEnv(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function apiUrl() {
  return requiredEnv("FACILITY_API_URL").replace(/\/$/, "");
}

function currentRunId() {
  return requiredEnv("RUN_ID");
}

function runnerToken() {
  return requiredEnv("RUNNER_TOKEN");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "delivery") {
    deliveryCliMain(process.argv.slice(3)).catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    main();
  }
}
