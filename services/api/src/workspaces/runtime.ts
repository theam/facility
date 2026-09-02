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
