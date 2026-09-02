import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertWorkspaceId,
  type CreateWorkspace,
  type PreviewEndpoint,
  validateWorkspacePorts,
  type WorkspaceCommand,
  type WorkspaceCommandResult,
  type WorkspaceHandle,
  type WorkspaceInspection,
  type WorkspaceLocator,
  type WorkspaceRuntime,
  WorkspaceRuntimeError,
} from "./runtime.js";

type FakeRecord = {
  state: "running" | "sleeping" | "destroyed";
  generation: number;
  input: CreateWorkspace;
};

/** Deterministic local runtime for the default test suite. It never provides isolation. */
export class FakeWorkspaceRuntime implements WorkspaceRuntime {
  readonly provider = "fake" as const;
  private readonly records = new Map<string, FakeRecord>();

  constructor(readonly root = join(tmpdir(), "facility-fake-workspaces")) {}

  async create(input: CreateWorkspace): Promise<WorkspaceHandle> {
    assertWorkspaceId(input.id);
    validateWorkspacePorts(input.ports);
    const existing = this.records.get(input.id);
    if (existing && existing.state !== "destroyed") return this.handle(existing);

    const volumeRef = this.volumeRef(input.id);
    await mkdir(join(volumeRef, ".facility", "home"), { recursive: true });
    await mkdir(join(volumeRef, ".facility", "claude"), { recursive: true });
    await mkdir(join(volumeRef, ".facility", "codex"), { recursive: true });
    await writeFile(
      join(volumeRef, ".facility", "workspace.json"),
      `${JSON.stringify({ id: input.id, image: input.image, ports: input.ports ?? [] })}\n`,
      { flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const record: FakeRecord = { state: "running", generation: 1, input };
    this.records.set(input.id, record);
    return this.handle(record);
  }

  async wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle> {
    const record = await this.record(workspace);
    if (record.state === "destroyed") {
      throw new WorkspaceRuntimeError("workspace_destroyed", "workspace has been destroyed");
    }
    record.state = "running";
    return this.handle(record);
  }

  async exec(
    workspace: WorkspaceLocator,
    command: WorkspaceCommand,
  ): Promise<WorkspaceCommandResult> {
    const handle = await this.wake(workspace);
    const cwd = this.commandDirectory(handle.volumeRef, command.cwd);
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = command.timeoutMs
      ? setTimeout(() => controller.abort(), command.timeoutMs)
      : undefined;
    try {
      return await new Promise<WorkspaceCommandResult>((resolveResult, reject) => {
        const child = spawn(command.command, command.args ?? [], {
          cwd,
          env: {
            ...process.env,
            HOME: join(handle.volumeRef, ".facility", "home"),
            CLAUDE_CONFIG_DIR: join(handle.volumeRef, ".facility", "claude"),
            CODEX_HOME: join(handle.volumeRef, ".facility", "codex"),
            ...(handle.environment ?? {}),
            ...(command.env ?? {}),
          },
          signal: controller.signal,
          stdio: "pipe",
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          command.onOutput?.({ stream: "stdout", data: chunk.toString("utf8") });
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          command.onOutput?.({ stream: "stderr", data: chunk.toString("utf8") });
        });
        child.on("error", reject);
        child.on("close", (exitCode) =>
          resolveResult({
            exitCode: exitCode ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            durationMs: Math.round(performance.now() - startedAt),
          }),
        );
        if (command.stdin !== undefined) child.stdin.end(command.stdin);
        else child.stdin.end();
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new WorkspaceRuntimeError(
          "workspace_command_timeout",
          `workspace command timed out after ${command.timeoutMs}ms`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async expose(workspace: WorkspaceLocator, ports: CreateWorkspace["ports"] = []) {
    const record = await this.record(workspace);
    validateWorkspacePorts(ports);
    return this.endpoints(record, ports);
  }

  async inspect(workspace: WorkspaceLocator): Promise<WorkspaceInspection> {
    const record = this.records.get(workspace.id);
    if (!record) {
      try {
        await stat(workspace.volumeRef);
        return {
          id: workspace.id,
          provider: this.provider,
          state: "sleeping",
          volumeRef: workspace.volumeRef,
          endpoints: [],
        };
      } catch {
        return {
          id: workspace.id,
          provider: this.provider,
          state: "destroyed",
          volumeRef: workspace.volumeRef,
          endpoints: [],
        };
      }
    }
    return {
      id: workspace.id,
      provider: this.provider,
      state: record.state,
      computeRef: record.state === "destroyed" ? undefined : this.computeRef(workspace.id, record),
      volumeRef: workspace.volumeRef,
      endpoints: record.state === "running" ? this.endpoints(record) : [],
    };
  }

  async suspend(workspace: WorkspaceLocator): Promise<void> {
    const record = await this.record(workspace);
    if (record.state !== "destroyed") record.state = "sleeping";
  }

  async destroy(workspace: WorkspaceLocator): Promise<void> {
    const record = this.records.get(workspace.id);
    if (record) record.state = "destroyed";
    await rm(workspace.volumeRef, { force: true, recursive: true });
  }

  /** Simulates provider loss of compute while preserving the durable volume. */
  async replaceCompute(workspace: WorkspaceLocator): Promise<void> {
    const record = await this.record(workspace);
    record.generation += 1;
    record.state = "sleeping";
  }

  async read(workspace: WorkspaceLocator, path: string): Promise<string> {
    return readFile(this.commandDirectory(workspace.volumeRef, path), "utf8");
  }

  private async record(workspace: WorkspaceLocator): Promise<FakeRecord> {
    assertWorkspaceId(workspace.id);
    const record = this.records.get(workspace.id);
    if (record) return record;
    try {
      await stat(workspace.volumeRef);
    } catch (error) {
      throw new WorkspaceRuntimeError("workspace_not_found", "workspace does not exist", {
        cause: error,
      });
    }
    const recovered: FakeRecord = {
      state: "sleeping",
      generation: 2,
      input: {
        id: workspace.id,
        image: workspace.image,
        environment: workspace.environment,
        ports: workspace.ports,
        resources: workspace.resources,
      },
    };
    this.records.set(workspace.id, recovered);
    return recovered;
  }

  private handle(record: FakeRecord): WorkspaceHandle {
    const id = record.input.id;
    return {
      ...record.input,
      provider: this.provider,
      externalRef: id,
      volumeRef: this.volumeRef(id),
      computeRef: this.computeRef(id, record),
      state: record.state === "running" ? "running" : "sleeping",
    };
  }

  private volumeRef(id: string): string {
    return join(this.root, assertWorkspaceId(id));
  }

  private computeRef(id: string, record: FakeRecord): string {
    return `${id}:compute:${record.generation}`;
  }

  private endpoints(record: FakeRecord, ports = record.input.ports ?? []): PreviewEndpoint[] {
    if (record.state !== "running") return [];
    return ports.map((port) => ({
      ...port,
      url: `${port.protocol ?? "http"}://127.0.0.1:${port.port}`,
    }));
  }

  private commandDirectory(volumeRef: string, cwd = "."): string {
    if (isAbsolute(cwd)) {
      throw new WorkspaceRuntimeError(
        "workspace_path_invalid",
        "fake runtime command paths must be relative to the workspace",
      );
    }
    const candidate = resolve(volumeRef, cwd);
    const fromRoot = relative(resolve(volumeRef), candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new WorkspaceRuntimeError(
        "workspace_path_invalid",
        "workspace command path escapes the workspace volume",
      );
    }
    return candidate;
  }
}
