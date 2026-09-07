import { PassThrough } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import {
  assertWorkspaceId,
  type CreateWorkspace,
  type PreviewEndpoint,
  persistentWorkspaceEnvironment,
  previewGatewayPorts,
  validateWorkspacePorts,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
  type WorkspaceHandle,
  type WorkspaceInspection,
  type WorkspaceLocator,
  type WorkspaceRuntime,
  WorkspaceRuntimeError,
} from "./runtime.js";

const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
// The command API has a five-hour ceiling even for a 24-hour persistent session.
const MAX_COMMAND_TIMEOUT_MS = 5 * 60 * 60 * 1_000;

export class VercelWorkspaceRuntime implements WorkspaceRuntime {
  readonly provider = "vercel" as const;

  constructor(
    private readonly credentials?: { token: string; teamId: string; projectId: string },
  ) {}

  async create(input: CreateWorkspace): Promise<WorkspaceHandle> {
    assertWorkspaceId(input.id);
    const ports = validateWorkspacePorts(input.ports);
    const gatewayPorts = previewGatewayPorts(ports);
    const bootstrapCommand = workspaceBootstrapCommand(input);
    let startedCompute = false;
    const onStarted = async () => {
      startedCompute = true;
    };
    const sandbox = await Sandbox.getOrCreate({
      ...this.credentials,
      name: input.id,
      onCreate: onStarted,
      onResume: onStarted,
      image: input.image,
      persistent: true,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
      timeout: SESSION_TIMEOUT_MS,
      resources: { vcpus: Math.max(1, Math.ceil(input.resources?.cpu ?? 2)) },
      ports: gatewayPorts.map(({ gatewayPort }) => gatewayPort),
      env: { ...persistentWorkspaceEnvironment(), ...(input.environment ?? {}) },
      tags: { facility: "workspace" },
      resume: true,
    });
    return this.initializeAndHandle(sandbox, input, bootstrapCommand, () => startedCompute);
  }

  async wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle> {
    const bootstrapCommand = workspaceBootstrapCommand(workspace);
    let startedCompute = false;
    const sandbox = await this.get(workspace, true, async () => {
      startedCompute = true;
    });
    return this.initializeAndHandle(sandbox, workspace, bootstrapCommand, () => startedCompute);
  }

  async exec(
    workspace: WorkspaceLocator,
    command: WorkspaceCommand,
  ): Promise<WorkspaceCommandResult> {
    if (command.stdin !== undefined) {
      throw new WorkspaceRuntimeError(
        "workspace_stdin_unsupported",
        "Vercel workspace commands do not support stdin; pass data as an argument or file",
      );
    }
    const sandbox = await this.get(workspace, true);
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    stdoutStream.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      command.onOutput?.({ stream: "stdout", data: chunk.toString("utf8") });
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      command.onOutput?.({ stream: "stderr", data: chunk.toString("utf8") });
    });
    const running = await sandbox.asUser("node").runCommand({
      cmd: command.command,
      args: command.args,
      cwd: command.cwd ?? "/workspace",
      env: { ...persistentWorkspaceEnvironment(), ...(command.env ?? {}) },
      timeoutMs:
        command.timeoutMs === undefined
          ? undefined
          : Math.min(command.timeoutMs, MAX_COMMAND_TIMEOUT_MS),
      detached: true,
    });
    const observation = new AbortController();
    let canceled = command.signal?.aborted ?? false;
    const cancel = () => {
      canceled = true;
      observation.abort();
      void running.kill("SIGTERM").catch(() => undefined);
    };
    command.signal?.addEventListener("abort", cancel, { once: true });
    if (canceled) cancel();
    const logs = (async () => {
      for await (const log of running.logs({ signal: observation.signal })) {
        if (log.stream === "stdout") stdoutStream.write(log.data);
        else stderrStream.write(log.data);
      }
    })();
    const completion = (async () => {
      // Metadata reads do not reliably include an exit status. Bound each wait
      // on this original command so no HTTP request lasts for the whole agent run.
      while (true) {
        const timeout = AbortSignal.timeout(30_000);
        try {
          return await running.wait({
            signal: AbortSignal.any([observation.signal, timeout]),
          });
        } catch (error) {
          if (timeout.aborted && !observation.signal.aborted) continue;
          throw error;
        }
      }
    })();
    let result: Awaited<typeof completion>;
    try {
      [result] = await Promise.all([completion, logs]);
      if (canceled) throw new Error("command canceled");
    } catch (error) {
      if (canceled) {
        throw new WorkspaceRuntimeError(
          "workspace_command_canceled",
          "workspace command was canceled",
        );
      }
      throw error;
    } finally {
      observation.abort();
      command.signal?.removeEventListener("abort", cancel);
      stdoutStream.end();
      stderrStream.end();
    }
    return {
      exitCode: result.exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      durationMs: result.durationMs ?? 0,
    };
  }

  async expose(workspace: WorkspaceLocator, ports: CreateWorkspace["ports"] = []) {
    const sandbox = await this.get(workspace, true);
    return this.endpoints(sandbox, validateWorkspacePorts(ports));
  }

  async inspect(workspace: WorkspaceLocator): Promise<WorkspaceInspection> {
    try {
      const sandbox = await this.get(workspace, false);
      return {
        id: workspace.id,
        provider: this.provider,
        state: sandbox.status === "running" ? "running" : "sleeping",
        computeRef: sandbox.status === "running" ? sandbox.currentSession().sessionId : undefined,
        volumeRef: sandbox.currentSnapshotId ?? workspace.volumeRef,
        endpoints:
          sandbox.status === "running" ? this.endpoints(sandbox, workspace.ports ?? []) : [],
        usage: {
          activeCpuMs: sandbox.totalActiveCpuDurationMs,
          durationMs: sandbox.totalDurationMs,
          ingressBytes: sandbox.totalIngressBytes,
          egressBytes: sandbox.totalEgressBytes,
        },
      };
    } catch (error) {
      if (isVercelNotFound(error)) {
        return {
          id: workspace.id,
          provider: this.provider,
          state: "destroyed",
          volumeRef: workspace.volumeRef,
          endpoints: [],
        };
      }
      throw error;
    }
  }

  async suspend(workspace: WorkspaceLocator): Promise<void> {
    try {
      const sandbox = await this.get(workspace, false);
      if (sandbox.status !== "stopped") await sandbox.stop();
    } catch (error) {
      if (!isVercelNotFound(error)) throw error;
    }
  }

  async destroy(workspace: WorkspaceLocator): Promise<void> {
    try {
      const sandbox = await this.get(workspace, false);
      await sandbox.delete();
    } catch (error) {
      if (!isVercelNotFound(error)) throw error;
    }
  }

  private get(
    workspace: WorkspaceLocator,
    resume: boolean,
    onResume?: (sandbox: Sandbox) => Promise<void>,
  ) {
    assertWorkspaceId(workspace.id);
    if (workspace.externalRef !== workspace.id) {
      throw new WorkspaceRuntimeError(
        "workspace_reference_invalid",
        "Vercel workspace reference does not match its Facility identity",
      );
    }
    return Sandbox.get({
      ...this.credentials,
      name: workspace.externalRef,
      resume,
      ...(onResume ? { onResume } : {}),
    });
  }

  private handle(input: CreateWorkspace, sandbox: Sandbox): WorkspaceHandle {
    return {
      ...input,
      provider: this.provider,
      externalRef: sandbox.name,
      volumeRef: sandbox.currentSnapshotId ?? `vercel:${sandbox.name}`,
      computeRef: sandbox.currentSession().sessionId,
      state: sandbox.status === "running" ? "running" : "sleeping",
    };
  }

  private async initializeAndHandle(
    sandbox: Sandbox,
    input: CreateWorkspace,
    bootstrapCommand: string,
    startedCompute: () => boolean,
  ): Promise<WorkspaceHandle> {
    try {
      await initializeSandbox(
        sandbox,
        bootstrapCommand,
        input.environment?.FACILITY_PREVIEW_GATEWAY_TOKEN,
      );
      return this.handle(input, sandbox);
    } catch (initializationError) {
      // Preview and restore may wake an already-running workspace. Leave its active turn alone.
      if (!startedCompute()) throw initializationError;
      try {
        // Stop only compute this operation created or resumed; preserve the persistent disk.
        if (sandbox.status !== "stopped") await sandbox.stop();
      } catch (cleanupError) {
        throw new WorkspaceRuntimeError(
          "workspace_initialize_cleanup_failed",
          `Workspace ${input.id} initialization failed and compute could not be stopped; stop this sandbox by its workspace name before retrying`,
          { cause: new AggregateError([initializationError, cleanupError]) },
        );
      }
      throw initializationError;
    }
  }

  private endpoints(sandbox: Sandbox, ports: CreateWorkspace["ports"] = []): PreviewEndpoint[] {
    const gatewayPorts = previewGatewayPorts(ports);
    return gatewayPorts.map(({ port, gatewayPort }) => ({
      ...port,
      url: sandbox.domain(gatewayPort),
    }));
  }
}

async function initializeSandbox(
  sandbox: Sandbox,
  bootstrapCommand: string,
  gatewayToken?: string,
) {
  // Inject the credential after sudo switches users; sudo: true discards the sandbox environment.
  const result = await sandbox.asUser("root").runCommand({
    cmd: "sh",
    args: ["-lc", bootstrapCommand],
    cwd: "/",
    env: gatewayToken === undefined ? {} : { FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
    timeoutMs: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new WorkspaceRuntimeError("workspace_initialize_failed", await result.stderr());
  }
}

function workspaceBootstrapCommand(input: CreateWorkspace) {
  const gatewayToken = input.environment?.FACILITY_PREVIEW_GATEWAY_TOKEN;
  if ((input.ports?.length ?? 0) > 0 && (!gatewayToken || gatewayToken.length < 32)) {
    throw new WorkspaceRuntimeError(
      "preview_gateway_token_missing",
      "workspace preview services require an internal gateway token",
    );
  }
  const gatewayPorts = previewGatewayPorts(input.ports);
  return [
    "set -eu",
    "mkdir -p /workspace/.facility/home /workspace/.facility/claude /workspace/.facility/codex /workspace/.facility/docker",
    // Reassign only the directories we create. Docker layers and volume files
    // retain the owners required by the containers stored in this workspace.
    "chown -h node:node /workspace /workspace/.facility /workspace/.facility/home /workspace/.facility/claude /workspace/.facility/codex",
    "chown -h root:root /workspace/.facility/docker",
    `if ! docker info >/dev/null 2>&1; then
  docker_running=0
  if test -r /var/run/docker.pid; then
    docker_pid="$(cat /var/run/docker.pid)"
    case "$docker_pid" in
      ''|*[!0-9]*) ;;
      *) if test "$(cat "/proc/$docker_pid/comm" 2>/dev/null || true)" = dockerd; then docker_running=1; fi ;;
    esac
  fi
  if test "$docker_running" = 0; then
    # Snapshots retain runc/containerd process state, but the resumed VM has no
    # corresponding processes. Keep execution state per boot and data persistent.
    docker_boot_id="$(cat /proc/sys/kernel/random/boot_id)"
    if test "\${#docker_boot_id}" -ne 36 || ! printf '%s\\n' "$docker_boot_id" | grep -Eq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'; then
      echo "Cannot start Docker without a valid kernel boot ID" >&2
      exit 1
    fi
    # A restored disk can contain a PID now owned by an unrelated process.
    # Remove only stale daemon artifacts; never signal that recycled PID.
    rm -f /var/run/docker.pid /var/run/docker.sock
    rm -rf /var/run/docker/containerd
    nohup dockerd --host=unix:///var/run/docker.sock --exec-root="/var/run/facility-docker-$docker_boot_id" --data-root=/workspace/.facility/docker --storage-driver=vfs >/workspace/.facility/dockerd.log 2>&1 &
  fi
fi`,
    `attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 120; then
    echo "Docker did not become ready within 120 seconds; inspect /workspace/.facility/dockerd.log" >&2
    exit 1
  fi
  sleep 1
done`,
    "chown root:node /var/run/docker.sock",
    "chmod 0660 /var/run/docker.sock",
    ...gatewayPorts.map(({ port, gatewayPort }) => {
      const gatewayCommand = `set -eu
pid_file=/workspace/.facility/preview-${gatewayPort}.pid
# A retained PID is only a hint: verify the full gateway invocation before signaling it.
node - "$pid_file" ${gatewayPort} ${port.port} <<'NODE'
const fs = require("node:fs");
try {
  const pid = fs.readFileSync(process.argv[2], "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(pid)) process.exit(0);
  const argv = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0");
  if (argv.length === 7 && argv[1] === "/usr/local/bin/facility-preview-gateway" &&
      argv[2] === "--listen" && argv[3] === process.argv[3] &&
      argv[4] === "--target" && argv[5] === process.argv[4] && argv[6] === "") {
    process.kill(Number(pid), "SIGTERM");
  }
} catch (error) {
  if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
}
NODE
nohup facility-preview-gateway --listen ${gatewayPort} --target ${port.port} >>/workspace/.facility/preview-${gatewayPort}.log 2>&1 &
pid=$!
echo "$pid" > "$pid_file"
attempt=0
until test "$(curl --silent --output /dev/null --write-out "%{http_code}" --max-time 1 http://127.0.0.1:${gatewayPort}/ || true)" = 401; do
  if ! kill -0 "$pid" 2>/dev/null || test "$attempt" -ge 50; then
    echo "Preview gateway on port ${gatewayPort} did not start" >&2
    kill "$pid" 2>/dev/null || true
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
kill -0 "$pid" 2>/dev/null || { echo "Preview gateway on port ${gatewayPort} exited during startup" >&2; exit 1; }
`;
      return `runuser --user node --preserve-environment -- sh -lc ${shellQuote(gatewayCommand)}`;
    }),
  ].join("\n");
}

function isVercelNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return value.code === "not_found" || value.status === 404 || value.statusCode === 404;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
