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

export class VercelWorkspaceRuntime implements WorkspaceRuntime {
  readonly provider = "vercel" as const;

  constructor(
    private readonly credentials?: { token: string; teamId: string; projectId: string },
  ) {}

  async create(input: CreateWorkspace): Promise<WorkspaceHandle> {
    assertWorkspaceId(input.id);
    const ports = validateWorkspacePorts(input.ports);
    const gatewayPorts = previewGatewayPorts(ports);
    const sandbox = await Sandbox.getOrCreate({
      ...this.credentials,
      name: input.id,
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
    await initializeSandbox(sandbox, input);
    return this.handle(input, sandbox);
  }

  async wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle> {
    const sandbox = await this.get(workspace, true);
    await initializeSandbox(sandbox, workspace);
    return this.handle(workspace, sandbox);
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
      timeoutMs: command.timeoutMs,
      detached: true,
    });
    let canceled = command.signal?.aborted ?? false;
    const cancel = () => {
      canceled = true;
      void running.kill("SIGTERM").catch(() => undefined);
    };
    command.signal?.addEventListener("abort", cancel, { once: true });
    if (canceled) cancel();
    const logs = (async () => {
      for await (const log of running.logs()) {
        if (log.stream === "stdout") stdoutStream.write(log.data);
        else stderrStream.write(log.data);
      }
    })();
    const result = await (async () => {
      const finished = await running.wait();
      await logs;
      return finished;
    })().finally(() => {
      command.signal?.removeEventListener("abort", cancel);
      stdoutStream.end();
      stderrStream.end();
    });
    if (canceled) {
      throw new WorkspaceRuntimeError(
        "workspace_command_canceled",
        "workspace command was canceled",
      );
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

  private get(workspace: WorkspaceLocator, resume: boolean) {
    assertWorkspaceId(workspace.id);
    if (workspace.externalRef !== workspace.id) {
      throw new WorkspaceRuntimeError(
        "workspace_reference_invalid",
        "Vercel workspace reference does not match its Facility identity",
      );
    }
    return Sandbox.get({ ...this.credentials, name: workspace.externalRef, resume });
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

  private endpoints(sandbox: Sandbox, ports: CreateWorkspace["ports"] = []): PreviewEndpoint[] {
    const gatewayPorts = previewGatewayPorts(ports);
    return gatewayPorts.map(({ port, gatewayPort }) => ({
      ...port,
      url: `https://${sandbox.domain(gatewayPort)}`,
    }));
  }
}

async function initializeSandbox(sandbox: Sandbox, input: CreateWorkspace) {
  const result = await sandbox.runCommand({
    cmd: "sh",
    args: ["-lc", workspaceBootstrapCommand(input)],
    sudo: true,
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
    "chown -R node:node /workspace",
    "if ! docker info >/dev/null 2>&1; then rm -f /var/run/docker.sock; nohup dockerd --host=unix:///var/run/docker.sock --data-root=/workspace/.facility/docker --storage-driver=vfs >/workspace/.facility/dockerd.log 2>&1 & fi",
    "attempt=0; until docker info >/dev/null 2>&1; do attempt=$((attempt + 1)); test $attempt -lt 120; sleep 1; done",
    "chown root:node /var/run/docker.sock",
    "chmod 0660 /var/run/docker.sock",
    ...gatewayPorts.map(({ port, gatewayPort }) => {
      return `runuser --user node --preserve-environment -- sh -lc 'pid_file=/workspace/.facility/preview-${gatewayPort}.pid; if test -f "$pid_file"; then kill "$(cat "$pid_file")" >/dev/null 2>&1 || true; fi; nohup facility-preview-gateway --listen ${gatewayPort} --target ${port.port} >>/workspace/.facility/preview-${gatewayPort}.log 2>&1 & echo $! > "$pid_file"'`;
    }),
  ].join("\n");
}

function isVercelNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return value.code === "not_found" || value.status === 404 || value.statusCode === 404;
}
