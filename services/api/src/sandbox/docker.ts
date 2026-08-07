import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import Docker from "dockerode";
import type { LaunchSpec, SandboxDriver } from "./driver.js";

type ContainerSummary = {
  Id: string;
  Labels?: Record<string, string>;
};

const NAMESPACE_LABEL = "facility.sandbox.namespace";
const KIND_LABEL = "facility.sandbox.kind";
const RUN_LABEL = "facility.sandbox.run";
const DEFAULT_NAMESPACE = "default";

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

  async launch(spec: LaunchSpec): Promise<{ ref: string; endpoint?: string }> {
    await this.ensureImage(spec.image);
    const network = dockerNetworkMode(spec.network);
    const packageCache = packageCacheMount(spec);
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.cmd,
      Env: Object.entries({ ...packageCache?.env, ...spec.env }).map(
        ([key, value]) => `${key}=${value}`,
      ),
      // Do not retain the legacy `facility.run` label. Old Facility workers
      // sweep that label globally and would delete a new instance's healthy
      // containers during a rolling upgrade. These versioned ownership labels
      // make both instance and workload kind explicit.
      Labels: {
        [NAMESPACE_LABEL]: spec.namespace ?? DEFAULT_NAMESPACE,
        [KIND_LABEL]: spec.kind ?? "run",
        [RUN_LABEL]: spec.runId,
      },
      ...(spec.servicePort ? { ExposedPorts: { [`${spec.servicePort}/tcp`]: {} } } : {}),
      // Keep the repository workspace on an anonymous Docker volume instead
      // of a RAM-backed tmpfs. Dependency trees for real repositories routinely
      // exceed several GiB while package managers unpack them; charging that to
      // the daemon's memory budget makes otherwise healthy runs OOM under local
      // concurrency. The volume remains run-scoped and `destroy({ v: true })`
      // removes it with the container, so no workspace or credential persists.
      Volumes: { "/work": {} },
      HostConfig: {
        // Use Docker's built-in tiny init as PID 1. Agent tools may launch and
        // disown children; without an init those children become permanent
        // zombies because the Node runner is not a process reaper.
        Init: true,
        AutoRemove: false,
        Memory: Math.max(128, spec.memoryMb) * 1024 * 1024,
        NanoCpus: Math.max(0.1, spec.cpu) * 1_000_000_000,
        ReadonlyRootfs: true,
        Tmpfs: {
          "/tmp": "rw,exec,nosuid,nodev,size=512m",
          "/var/tmp": "rw,exec,nosuid,nodev,size=512m",
        },
        ...(packageCache ? { Mounts: [packageCache.mount] } : {}),
        ...(network.hostConfig ?? {}),
        ...(spec.servicePort
          ? {
              PortBindings: {
                [`${spec.servicePort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
              },
            }
          : {}),
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
    if (!spec.servicePort) return { ref: container.id };
    const info = await container.inspect();
    const binding = info.NetworkSettings?.Ports?.[`${spec.servicePort}/tcp`]?.[0];
    if (!binding?.HostPort) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new Error(`Docker did not publish preview port ${spec.servicePort}`);
    }
    return { ref: container.id, endpoint: `http://127.0.0.1:${binding.HostPort}` };
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

  async listFacilityContainers(
    namespace = DEFAULT_NAMESPACE,
  ): Promise<Array<{ ref: string; runId: string }>> {
    const containers = (await this.docker.listContainers({
      all: true,
      filters: { label: [`${NAMESPACE_LABEL}=${namespace}`, `${KIND_LABEL}=run`] },
    })) as ContainerSummary[];
    return containers.flatMap((container) => {
      const runId = container.Labels?.[RUN_LABEL];
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

function packageCacheMount(spec: LaunchSpec) {
  if (!spec.cachePartition || spec.kind === "preview") return undefined;
  const namespace = spec.namespace ?? DEFAULT_NAMESPACE;
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(spec.cachePartition)
    .digest("hex")
    .slice(0, 32);
  const target = "/work/.facility-package-cache";
  return {
    env: {
      // Package-manager downloads are safe to reuse within the control plane's
      // project partition. pnpm_config_store_dir is the actual content-addressed
      // package store (PNPM_HOME is only the global-bin directory), while npm's
      // `_cacache` verifies content integrity. Do not persist COREPACK_HOME: it
      // contains executable package-manager code, so a writable cross-run copy
      // would create a same-project persistence channel. The cache is a Docker
      // volume, not another service, and never contains the repository working
      // tree.
      pnpm_config_store_dir: `${target}/pnpm-store`,
      // Docker Desktop and small self-hosted daemons often share a finite VM
      // with the control plane. pnpm otherwise derives aggressive concurrency
      // from the host CPU count, which can overwhelm that shared daemon while
      // extracting a large dependency graph. These remain package-manager
      // settings, not a shell-command override, so private-registry command
      // validation stays intact.
      pnpm_config_network_concurrency: "4",
      pnpm_config_child_concurrency: "2",
      PNPM_CONFIG_VERIFY_STORE_INTEGRITY: "true",
      NPM_CONFIG_CACHE: `${target}/npm`,
    },
    mount: {
      Type: "volume" as const,
      Source: `facility-package-cache-${digest}`,
      Target: target,
      ReadOnly: false,
    },
  };
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
