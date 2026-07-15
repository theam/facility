import { Readable } from "node:stream";
import Docker from "dockerode";
import type { LaunchSpec, SandboxDriver } from "./driver.js";

type ContainerSummary = {
  Id: string;
  Labels?: Record<string, string>;
};

export class DockerSandboxDriver implements SandboxDriver {
  readonly name = "docker" as const;
  private readonly docker: Docker;

  constructor(docker = new Docker()) {
    this.docker = docker;
  }

  /**
   * Whether an image is present on the daemon *without* pulling it — used by
   * `facility doctor` to flag a missing runner image before the first run tries
   * (and possibly fails) to pull it. Throws only on real daemon errors.
   */
  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  async launch(spec: LaunchSpec): Promise<{ ref: string }> {
    await this.ensureImage(spec.image);
    const network = dockerNetworkMode(spec.network);
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.cmd,
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      Labels: { "facility.run": spec.runId },
      HostConfig: {
        AutoRemove: false,
        Memory: Math.max(128, spec.memoryMb) * 1024 * 1024,
        NanoCpus: Math.max(0.1, spec.cpu) * 1_000_000_000,
        ReadonlyRootfs: true,
        Tmpfs: {
          // Owned by the non-root `node` user (uid 1000) the runner image runs
          // as — a root-owned tmpfs over /work would be unwritable to the agent.
          "/work": "rw,exec,nosuid,nodev,size=4g,uid=1000,gid=1000",
          "/tmp": "rw,exec,nosuid,nodev,size=512m",
          "/var/tmp": "rw,exec,nosuid,nodev,size=512m",
        },
        ...(network.hostConfig ?? {}),
        // Contain a rogue agent process: no privilege escalation, no Linux
        // capabilities, bounded process count, read-only rootfs, and a
        // profile-selected network posture.
        SecurityOpt: ["no-new-privileges"],
        CapDrop: ["ALL"],
        PidsLimit: 512,
        // Makes the API running on the host reachable from Linux CI as well as
        // Docker Desktop. It adds no capability beyond an unrestricted profile.
        ...(network.networkDisabled ? {} : { ExtraHosts: ["host.docker.internal:host-gateway"] }),
      },
      ...(network.networkDisabled ? { NetworkDisabled: true } : {}),
    });
    await container.start();
    return { ref: container.id };
  }

  async status(ref: string): Promise<"starting" | "running" | "exited" | "lost"> {
    try {
      const info = await this.docker.getContainer(ref).inspect();
      if (info.State?.Running) return "running";
      if (info.State?.Status === "created" || info.State?.Status === "restarting") {
        return "starting";
      }
      return "exited";
    } catch (error) {
      if (isDockerNotFound(error)) return "lost";
      throw error;
    }
  }

  async *logs(ref: string, afterLine = 0): AsyncIterable<string> {
    const streamOrBuffer = await this.docker.getContainer(ref).logs({
      stdout: true,
      stderr: true,
      follow: false,
      timestamps: false,
    });
    const text = Buffer.isBuffer(streamOrBuffer)
      ? streamOrBuffer.toString("utf8")
      : await readableToString(streamOrBuffer);
    let lineNo = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      lineNo += 1;
      if (lineNo > afterLine) yield line;
    }
  }

  async stop(ref: string, opts: { kill?: boolean } = {}): Promise<void> {
    const container = this.docker.getContainer(ref);
    try {
      if (opts.kill) {
        await container.kill();
      } else {
        await container.stop({ t: 10 });
      }
    } catch (error) {
      if (!isDockerNotFound(error) && !isAlreadyStopped(error)) throw error;
    }
  }

  async destroy(ref: string): Promise<void> {
    try {
      await this.docker.getContainer(ref).remove({ force: true, v: true });
    } catch (error) {
      // 404 (gone) and 409 (a concurrent removal already running) both mean the
      // container is on its way out — destroy is idempotent.
      if (!isDockerNotFound(error) && !isRemovalInProgress(error)) throw error;
    }
    await this.waitForRemoval(ref);
  }

  async listFacilityContainers(): Promise<Array<{ ref: string; runId: string }>> {
    const containers = (await this.docker.listContainers({
      all: true,
      filters: { label: ["facility.run"] },
    })) as ContainerSummary[];
    return containers.flatMap((container) => {
      const runId = container.Labels?.["facility.run"];
      return runId ? [{ ref: container.Id, runId }] : [];
    });
  }

  private async ensureImage(image: string) {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (!isDockerNotFound(error)) throw error;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
    });
  }

  private async waitForRemoval(ref: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await this.docker.getContainer(ref).inspect();
      } catch (error) {
        if (isDockerNotFound(error)) return;
        throw error;
      }
      await sleep(100);
    }
    throw new Error(`Docker container ${ref} was not removed before timeout`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerNetworkMode(network: Record<string, unknown> | undefined): {
  hostConfig?: { NetworkMode: string };
  networkDisabled?: boolean;
} {
  const egress = typeof network?.egress === "string" ? network.egress : "restricted";
  if (egress === "unrestricted") return {};
  if (egress === "none" || egress === "disabled") {
    return { hostConfig: { NetworkMode: "none" }, networkDisabled: true };
  }
  const configured = dockerNetworkName(network);
  if (configured) return { hostConfig: { NetworkMode: configured } };
  return { hostConfig: { NetworkMode: "none" }, networkDisabled: true };
}

function dockerNetworkName(network: Record<string, unknown> | undefined): string | undefined {
  const profileValue =
    stringValue(network?.docker_network) ??
    stringValue(network?.dockerNetwork) ??
    stringValue(network?.network_name) ??
    stringValue(network?.name);
  return profileValue ?? process.env.FACILITY_SANDBOX_DOCKER_NETWORK;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDockerNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: number }).statusCode === 404
  );
}

function isRemovalInProgress(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: number }).statusCode === 409 &&
    String((error as { reason?: string; message?: string }).message ?? "").includes(
      "already in progress",
    )
  );
}

function isAlreadyStopped(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    String(
      (error as { reason?: string; message?: string }).reason ?? (error as Error).message,
    ).includes("not running")
  );
}

async function readableToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
