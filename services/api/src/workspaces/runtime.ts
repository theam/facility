import { createHash } from "node:crypto";

export type WorkspaceProvider = "docker" | "vercel" | "fake";
export type WorkspaceState = "creating" | "running" | "sleeping" | "error" | "destroyed";

export type WorkspacePort = {
  service: string;
  port: number;
  protocol?: "http" | "https";
  websocket?: boolean;
};

export type CreateWorkspace = {
  id: string;
  image: string;
  environment?: Record<string, string>;
  ports?: WorkspacePort[];
  resources?: { cpu: number; memoryMb: number };
};

export type WorkspaceLocator = CreateWorkspace & {
  externalRef: string;
  volumeRef: string;
};

export type WorkspaceHandle = WorkspaceLocator & {
  provider: WorkspaceProvider;
  computeRef: string;
  state: Exclude<WorkspaceState, "creating" | "error" | "destroyed">;
};

export type WorkspaceCommand = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (output: WorkspaceCommandOutput) => void;
};

export type WorkspaceCommandOutput = { stream: "stdout" | "stderr"; data: string };

export type WorkspaceCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type PreviewEndpoint = WorkspacePort & { url: string };

export type WorkspaceInspection = {
  id: string;
  provider: WorkspaceProvider;
  state: WorkspaceState;
  computeRef?: string;
  volumeRef: string;
  endpoints: PreviewEndpoint[];
  usage?: {
    activeCpuMs?: number;
    durationMs?: number;
    ingressBytes?: number;
    egressBytes?: number;
  };
};

export type WorkspaceBackup = {
  format: "tar-gzip-base64";
  payload: string;
  sha256: string;
  createdAt: string;
};

export interface WorkspaceRuntime {
  readonly provider: WorkspaceProvider;
  create(input: CreateWorkspace): Promise<WorkspaceHandle>;
  wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle>;
  exec(workspace: WorkspaceLocator, command: WorkspaceCommand): Promise<WorkspaceCommandResult>;
  expose(workspace: WorkspaceLocator, ports: WorkspacePort[]): Promise<PreviewEndpoint[]>;
  inspect(workspace: WorkspaceLocator): Promise<WorkspaceInspection>;
  suspend(workspace: WorkspaceLocator): Promise<void>;
  destroy(workspace: WorkspaceLocator): Promise<void>;
}

/** Provider-independent, operator-controlled backup of the complete durable workspace volume. */
export async function exportWorkspaceBackup(
  runtime: WorkspaceRuntime,
  workspace: WorkspaceLocator,
): Promise<WorkspaceBackup> {
  const result = await runtime.exec(workspace, {
    command: "sh",
    args: [
      "-lc",
      "tar -C . --exclude='./.facility/docker' --exclude='./.facility/workspace.json' --exclude='./.facility/runtime-ready' -czf - . | base64 | tr -d '\\n'",
    ],
    timeoutMs: 30 * 60 * 1_000,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new WorkspaceRuntimeError(
      "workspace_backup_failed",
      result.stderr.trim() || "workspace backup command returned no data",
    );
  }
  const payload = result.stdout.trim();
  return {
    format: "tar-gzip-base64",
    payload,
    sha256: createHash("sha256").update(payload).digest("hex"),
    createdAt: new Date().toISOString(),
  };
}

/** Restores a validated Facility backup into a newly created workspace identity. */
export async function restoreWorkspaceBackup(
  runtime: WorkspaceRuntime,
  input: CreateWorkspace,
  backup: WorkspaceBackup,
): Promise<WorkspaceHandle> {
  if (
    backup.format !== "tar-gzip-base64" ||
    createHash("sha256").update(backup.payload).digest("hex") !== backup.sha256
  ) {
    throw new WorkspaceRuntimeError(
      "workspace_backup_invalid",
      "workspace backup format or checksum is invalid",
    );
  }
  const workspace = await runtime.create(input);
  try {
    const stagingPath = ".facility/restore/workspace.tar.gz.b64";
    const initialized = await runtime.exec(workspace, {
      command: "sh",
      args: ["-lc", `mkdir -p .facility/restore && : > ${stagingPath}`],
    });
    if (initialized.exitCode !== 0) {
      throw new WorkspaceRuntimeError(
        "workspace_restore_failed",
        initialized.stderr.trim() || "workspace restore staging could not be initialized",
      );
    }
    for (let offset = 0; offset < backup.payload.length; offset += 48_000) {
      const chunk = backup.payload.slice(offset, offset + 48_000);
      const appended = await runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", `printf '%s' "$FACILITY_WORKSPACE_BACKUP_CHUNK" >> ${stagingPath}`],
        env: { FACILITY_WORKSPACE_BACKUP_CHUNK: chunk },
      });
      if (appended.exitCode !== 0) {
        throw new WorkspaceRuntimeError(
          "workspace_restore_failed",
          appended.stderr.trim() || "workspace restore staging write failed",
        );
      }
    }
    const result = await runtime.exec(workspace, {
      command: "sh",
      args: [
        "-lc",
        [
          "set -eu",
          "archive=$(mktemp)",
          `trap 'rm -f "$archive"; rm -rf .facility/restore' EXIT`,
          `base64 -d < ${stagingPath} > "$archive"`,
          "tar -tzf \"$archive\" | awk 'BEGIN { ok=1 } /(^|\\/)\\.\\.(\\/|$)/ || /^\\// { ok=0 } END { exit ok ? 0 : 1 }'",
          'tar -C . -xzf "$archive"',
        ].join("\n"),
      ],
      timeoutMs: 30 * 60 * 1_000,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceRuntimeError(
        "workspace_restore_failed",
        result.stderr.trim() || "workspace restore command failed",
      );
    }
    return runtime.wake(workspace);
  } catch (error) {
    await runtime.destroy(workspace).catch(() => undefined);
    throw error;
  }
}

export class WorkspaceRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceRuntimeError";
  }
}

export function assertWorkspaceId(id: string): string {
  if (!/^ws_[a-z0-9]{16,64}$/.test(id)) {
    throw new WorkspaceRuntimeError("workspace_id_invalid", "workspace id is invalid");
  }
  return id;
}

export function validateWorkspacePorts(ports: WorkspacePort[] = []): WorkspacePort[] {
  if (ports.length > 15) {
    throw new WorkspaceRuntimeError(
      "workspace_ports_invalid",
      "a workspace exposes at most 15 ports",
    );
  }
  const services = new Set<string>();
  const numbers = new Set<number>();
  for (const port of ports) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(port.service)) {
      throw new WorkspaceRuntimeError(
        "workspace_ports_invalid",
        `invalid workspace service name ${port.service}`,
      );
    }
    if (!Number.isInteger(port.port) || port.port < 1 || port.port > 65_535) {
      throw new WorkspaceRuntimeError(
        "workspace_ports_invalid",
        `invalid port for workspace service ${port.service}`,
      );
    }
    if (services.has(port.service) || numbers.has(port.port)) {
      throw new WorkspaceRuntimeError(
        "workspace_ports_invalid",
        "workspace service names and ports must be unique",
      );
    }
    services.add(port.service);
    numbers.add(port.port);
  }
  return ports;
}

export function persistentWorkspaceEnvironment(): Record<string, string> {
  return {
    HOME: "/workspace/.facility/home",
    CLAUDE_CONFIG_DIR: "/workspace/.facility/claude",
    CODEX_HOME: "/workspace/.facility/codex",
  };
}

export function previewGatewayPorts(
  ports: WorkspacePort[] = [],
): Array<{ port: WorkspacePort; gatewayPort: number }> {
  const validated = validateWorkspacePorts(ports);
  const occupied = new Set(validated.map((port) => port.port));
  let candidate = 65_535;
  return validated.map((port) => {
    while (candidate >= 1_024 && occupied.has(candidate)) candidate -= 1;
    if (candidate < 1_024) {
      throw new WorkspaceRuntimeError(
        "workspace_ports_invalid",
        "no unprivileged preview gateway port is available",
      );
    }
    const gatewayPort = candidate;
    occupied.add(gatewayPort);
    candidate -= 1;
    return { port, gatewayPort };
  });
}
