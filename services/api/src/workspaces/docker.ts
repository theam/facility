import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import Docker from "dockerode";
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

const WORKSPACE_LABEL = "facility.workspace.id";
const KIND_LABEL = "facility.workload.kind";
const KIND = "workspace-v2";

export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  readonly provider = "docker" as const;

  constructor(private readonly docker = new Docker()) {}

  async create(input: CreateWorkspace): Promise<WorkspaceHandle> {
    assertWorkspaceId(input.id);
    const ports = validateWorkspacePorts(input.ports);
    const gatewayPorts = previewGatewayPorts(ports);
    const names = dockerNames(input.id);
    const existing = await this.inspectContainer(names.container);
    if (existing) {
      this.assertOwned(existing, input.id, names.volume);
      if (!existing.State?.Running) await this.docker.getContainer(existing.Id).start();
      await this.waitUntilReady(this.docker.getContainer(existing.Id));
      return this.handle(input, existing.Id, names);
    }

    await this.ensureImage(input.image);
    await this.ensureNetwork(names.network, input.id);
    await this.docker.createVolume({
      Name: names.volume,
      Labels: { [WORKSPACE_LABEL]: input.id, [KIND_LABEL]: KIND },
    });
    const container = await this.docker.createContainer({
      name: names.container,
      Image: input.image,
      User: "root",
      Entrypoint: ["sh", "-lc"],
      Cmd: [workspaceBootstrapCommand(input)],
      WorkingDir: "/workspace",
      Env: Object.entries({
        ...persistentWorkspaceEnvironment(),
        ...(input.environment ?? {}),
      }).map(([key, value]) => `${key}=${value}`),
      Labels: { [WORKSPACE_LABEL]: input.id, [KIND_LABEL]: KIND },
      ExposedPorts: Object.fromEntries(
        gatewayPorts.map(({ gatewayPort }) => [`${gatewayPort}/tcp`, {}]),
      ),
      HostConfig: {
        Init: true,
        AutoRemove: false,
        Privileged: true,
        NetworkMode: names.network,
        Memory: Math.max(512, input.resources?.memoryMb ?? 4_096) * 1024 * 1024,
        NanoCpus: Math.max(0.5, input.resources?.cpu ?? 2) * 1_000_000_000,
        PidsLimit: 4_096,
        Mounts: [{ Type: "volume", Source: names.volume, Target: "/workspace", ReadOnly: false }],
        PortBindings: Object.fromEntries(
          gatewayPorts.map(({ gatewayPort }) => [
            `${gatewayPort}/tcp`,
            [{ HostIp: "127.0.0.1", HostPort: "" }],
          ]),
        ),
      },
    });
    try {
      await container.start();
      await this.waitUntilReady(container);
    } catch (error) {
      await container.remove({ force: true, v: false }).catch(() => undefined);
      throw error;
    }
    return this.handle(input, container.id, names);
  }

  async wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle> {
    const names = this.assertLocator(workspace);
    const existing = await this.inspectContainer(names.container);
    if (!existing) return this.create(workspace);
    this.assertOwned(existing, workspace.id, names.volume);
    if (!existing.State?.Running) await this.docker.getContainer(existing.Id).start();
    return this.handle(workspace, existing.Id, names);
  }

  async exec(
    workspace: WorkspaceLocator,
    command: WorkspaceCommand,
  ): Promise<WorkspaceCommandResult> {
    const handle = await this.wake(workspace);
    const container = this.docker.getContainer(handle.computeRef);
    const startedAt = performance.now();
    const execution = await container.exec({
      Cmd: [command.command, ...(command.args ?? [])],
      AttachStdin: command.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: "node",
      WorkingDir: workspaceCwd(command.cwd),
      Env: Object.entries({
        ...persistentWorkspaceEnvironment(),
        ...(workspace.environment ?? {}),
        ...(command.env ?? {}),
      }).map(([key, value]) => `${key}=${value}`),
    });
    const stream = await execution.start({
      hijack: command.stdin !== undefined,
      stdin: command.stdin !== undefined,
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk: Buffer) =>
      command.onOutput?.({ stream: "stdout", data: chunk.toString("utf8") }),
    );
    stderr.on("data", (chunk: Buffer) =>
      command.onOutput?.({ stream: "stderr", data: chunk.toString("utf8") }),
    );
    const stdoutPromise = readableToString(stdout);
    const stderrPromise = readableToString(stderr);
    this.docker.modem.demuxStream(stream, stdout, stderr);
    if (command.stdin !== undefined && "end" in stream && typeof stream.end === "function") {
      stream.end(command.stdin);
    }

    let timedOut = false;
    let canceled = command.signal?.aborted ?? false;
    const cancel = () => {
      canceled = true;
      void this.terminateExecution(container, execution);
    };
    command.signal?.addEventListener("abort", cancel, { once: true });
    if (canceled) cancel();
    const timeout = command.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void this.terminateExecution(container, execution);
        }, command.timeoutMs)
      : undefined;
    try {
      await waitForStream(stream);
      stdout.end();
      stderr.end();
      const [out, err, details] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        execution.inspect(),
      ]);
      if (canceled) {
        throw new WorkspaceRuntimeError(
          "workspace_command_canceled",
          "workspace command was canceled",
        );
      }
      if (timedOut) {
        throw new WorkspaceRuntimeError(
          "workspace_command_timeout",
          `workspace command timed out after ${command.timeoutMs}ms`,
        );
      }
      return {
        exitCode: details.ExitCode ?? 1,
        stdout: out,
        stderr: err,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      command.signal?.removeEventListener("abort", cancel);
    }
  }

  async expose(workspace: WorkspaceLocator, ports: CreateWorkspace["ports"] = []) {
    validateWorkspacePorts(ports);
    const handle = await this.wake(workspace);
    return this.endpoints(handle.computeRef, ports);
  }

  async inspect(workspace: WorkspaceLocator): Promise<WorkspaceInspection> {
    const names = this.assertLocator(workspace);
    const [container, volumeExists] = await Promise.all([
      this.inspectContainer(names.container),
      this.volumeExists(names.volume),
    ]);
    if (!volumeExists) {
      return {
        id: workspace.id,
        provider: this.provider,
        state: "destroyed",
        volumeRef: names.volume,
        endpoints: [],
      };
    }
    if (!container) {
      return {
        id: workspace.id,
        provider: this.provider,
        state: "sleeping",
        volumeRef: names.volume,
        endpoints: [],
      };
    }
    this.assertOwned(container, workspace.id, names.volume);
    const running = Boolean(container.State?.Running);
    return {
      id: workspace.id,
      provider: this.provider,
      state: running ? "running" : "sleeping",
      computeRef: container.Id,
      volumeRef: names.volume,
      endpoints: running ? await this.endpoints(container.Id, workspace.ports ?? []) : [],
    };
  }

  async suspend(workspace: WorkspaceLocator): Promise<void> {
    const names = this.assertLocator(workspace);
    const current = await this.inspectContainer(names.container);
    if (!current) return;
    this.assertOwned(current, workspace.id, names.volume);
    if (!current.State?.Running) return;
    await this.docker
      .getContainer(current.Id)
      .stop({ t: 20 })
      .catch((error) => {
        if (!isDockerNotFound(error) && !isAlreadyStopped(error)) throw error;
      });
  }

  async destroy(workspace: WorkspaceLocator): Promise<void> {
    const names = this.assertLocator(workspace);
    const current = await this.inspectContainer(names.container);
    if (current) {
      this.assertOwned(current, workspace.id, names.volume);
      await this.docker
        .getContainer(current.Id)
        .remove({ force: true, v: false })
        .catch((error) => {
          if (!isDockerNotFound(error) && !isRemovalInProgress(error)) throw error;
        });
    }
    await this.docker
      .getVolume(names.volume)
      .remove()
      .catch((error) => {
        if (!isDockerNotFound(error)) throw error;
      });
    await this.docker
      .getNetwork(names.network)
      .remove()
      .catch((error) => {
        if (!isDockerNotFound(error)) throw error;
      });
  }

  /** Test hook that removes compute without touching the named workspace volume. */
  async replaceCompute(workspace: WorkspaceLocator): Promise<void> {
    const names = this.assertLocator(workspace);
    const current = await this.inspectContainer(names.container);
    if (!current) return;
    this.assertOwned(current, workspace.id, names.volume);
    await this.docker.getContainer(current.Id).remove({ force: true, v: false });
  }

  private async endpoints(containerId: string, ports: CreateWorkspace["ports"] = []) {
    const details = await this.docker.getContainer(containerId).inspect();
    const gatewayPorts = previewGatewayPorts(ports);
    return gatewayPorts.map<PreviewEndpoint>(({ port, gatewayPort }) => {
      const binding = details.NetworkSettings?.Ports?.[`${gatewayPort}/tcp`]?.[0];
      if (!binding?.HostPort) {
        throw new WorkspaceRuntimeError(
          "workspace_port_unavailable",
          `Docker did not publish service ${port.service} on port ${port.port}`,
        );
      }
      return { ...port, url: `http://127.0.0.1:${binding.HostPort}` };
    });
  }

  private handle(
    input: CreateWorkspace,
    containerId: string,
    names: ReturnType<typeof dockerNames>,
  ): WorkspaceHandle {
    return {
      ...input,
      provider: this.provider,
      externalRef: names.container,
      volumeRef: names.volume,
      computeRef: containerId,
      state: "running",
    };
  }

  private assertLocator(workspace: WorkspaceLocator) {
    const names = dockerNames(assertWorkspaceId(workspace.id));
    if (workspace.externalRef !== names.container || workspace.volumeRef !== names.volume) {
      throw new WorkspaceRuntimeError(
        "workspace_reference_invalid",
        "Docker workspace references do not match the Facility identity",
      );
    }
    return names;
  }

  private assertOwned(
    container: Docker.ContainerInspectInfo,
    workspaceId: string,
    volumeName: string,
  ) {
    const labels = container.Config?.Labels ?? {};
    const volume = container.Mounts?.find((mount) => mount.Destination === "/workspace");
    if (
      labels[WORKSPACE_LABEL] !== workspaceId ||
      labels[KIND_LABEL] !== KIND ||
      volume?.Name !== volumeName
    ) {
      throw new WorkspaceRuntimeError(
        "workspace_ownership_mismatch",
        "existing Docker resources are not owned by this Facility workspace",
      );
    }
  }

  private async inspectContainer(name: string): Promise<Docker.ContainerInspectInfo | undefined> {
    try {
      return await this.docker.getContainer(name).inspect();
    } catch (error) {
      if (isDockerNotFound(error)) return undefined;
      throw error;
    }
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
    );
  }

  private async ensureNetwork(name: string, workspaceId: string): Promise<void> {
    try {
      const existing = await this.docker.getNetwork(name).inspect();
      if (
        existing.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        existing.Labels?.[KIND_LABEL] !== KIND
      ) {
        throw new WorkspaceRuntimeError(
          "workspace_ownership_mismatch",
          "existing Docker network is not owned by this Facility workspace",
        );
      }
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
      await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Labels: { [WORKSPACE_LABEL]: workspaceId, [KIND_LABEL]: KIND },
      });
    }
  }

  private async terminateExecution(container: Docker.Container, execution: Docker.Exec) {
    const details = await execution.inspect().catch(() => undefined);
    if (!details?.Pid) return;
    const killer = await container.exec({
      Cmd: ["kill", "-TERM", String(details.Pid)],
      AttachStdout: false,
      AttachStderr: false,
    });
    await killer.start({}).catch(() => undefined);
  }

  private async waitUntilReady(container: Docker.Container) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await container.inspect();
      if (!state.State.Running) {
        throw new WorkspaceRuntimeError(
          "workspace_initialize_failed",
          `workspace bootstrap exited with status ${state.State.ExitCode}`,
        );
      }
      const probe = await container.exec({
        Cmd: [
          "sh",
          "-lc",
          "test -f /workspace/.facility/runtime-ready && docker info >/dev/null 2>&1",
        ],
        AttachStdout: false,
        AttachStderr: false,
        User: "root",
      });
      await probe.start({ Detach: true });
      let details = await probe.inspect();
      while (details.Running) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        details = await probe.inspect();
      }
      if (details.ExitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new WorkspaceRuntimeError(
      "workspace_initialize_failed",
      "workspace bootstrap did not become ready",
    );
  }
}

function dockerNames(id: string) {
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return {
    container: `facility-ws-${suffix}`,
    volume: `facility-ws-volume-${suffix}`,
    network: `facility-ws-network-${suffix}`,
  };
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
    "rm -f /workspace/.facility/runtime-ready",
    "mkdir -p /workspace/.facility/home /workspace/.facility/claude /workspace/.facility/codex /workspace/.facility/docker",
    "chown -R node:node /workspace",
    "rm -f /var/run/docker.sock",
    "dockerd --host=unix:///var/run/docker.sock --data-root=/workspace/.facility/docker --storage-driver=vfs >/workspace/.facility/dockerd.log 2>&1 &",
    "attempt=0; until docker info >/dev/null 2>&1; do attempt=$((attempt + 1)); test $attempt -lt 120; sleep 1; done",
    "chown root:node /var/run/docker.sock",
    "chmod 0660 /var/run/docker.sock",
    ...gatewayPorts.map(({ port, gatewayPort }) => {
      return `runuser --user node --preserve-environment -- sh -lc 'nohup facility-preview-gateway --listen ${gatewayPort} --target ${port.port} >>/workspace/.facility/preview-${gatewayPort}.log 2>&1 &'`;
    }),
    "touch /workspace/.facility/runtime-ready",
    "exec sleep infinity",
  ].join("\n");
}

function workspaceCwd(value = "/workspace"): string {
  const candidate = value.startsWith("/") ? value : `/workspace/${value}`;
  if (candidate !== "/workspace" && !candidate.startsWith("/workspace/")) {
    throw new WorkspaceRuntimeError(
      "workspace_path_invalid",
      "command cwd must be inside /workspace",
    );
  }
  return candidate;
}

function isDockerNotFound(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { statusCode?: number }).statusCode === 404,
  );
}

function isAlreadyStopped(error: unknown) {
  return String(
    (error as { reason?: string; message?: string })?.reason ?? (error as Error)?.message ?? "",
  ).includes("not running");
}

function isRemovalInProgress(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { statusCode?: number }).statusCode === 409 &&
      String((error as { message?: string }).message ?? "").includes("already in progress"),
  );
}

async function readableToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function waitForStream(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}
