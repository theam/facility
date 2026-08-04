export type SandboxDriverName = "docker" | "aws";

export type LaunchSpec = {
  runId: string;
  image: string;
  env: Record<string, string>;
  cpu: number;
  memoryMb: number;
  timeoutMin: number;
  cmd?: string[];
  network?: Record<string, unknown>;
  servicePort?: number;
};

export class SandboxLaunchError extends Error {
  constructor(
    message: string,
    readonly ref: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxLaunchError";
  }
}

export interface SandboxDriver {
  name: SandboxDriverName;
  launch(spec: LaunchSpec): Promise<{ ref: string; endpoint?: string }>;
  status(ref: string): Promise<"starting" | "running" | "exited" | "lost">;
  logs(ref: string, afterLine?: number): AsyncIterable<string>;
  stop(ref: string, opts?: { kill?: boolean }): Promise<void>;
  destroy(ref: string): Promise<void>;
}

export async function sandboxDriver(name: SandboxDriverName): Promise<SandboxDriver> {
  if (name === "docker") {
    const { DockerSandboxDriver } = await import("./docker.js");
    return new DockerSandboxDriver();
  }
  const { AwsSandboxDriver } = await import("./aws.js");
  return new AwsSandboxDriver();
}

export async function previewSandboxDriver(name: SandboxDriverName): Promise<SandboxDriver> {
  if (name === "docker") return sandboxDriver(name);
  const { AwsPreviewSandboxDriver } = await import("./aws-preview.js");
  return new AwsPreviewSandboxDriver();
}
