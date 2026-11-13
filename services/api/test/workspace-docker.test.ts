import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import type { WorkspaceLocator } from "../src/workspaces/runtime.js";

const workspaceId = "ws_0123456789abcdef";
const suffix = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
const workspace: WorkspaceLocator = {
  id: workspaceId,
  image: "facility-runner:test",
  externalRef: `facility-ws-${suffix}`,
  volumeRef: `facility-ws-volume-${suffix}`,
};

const ownedLabels = {
  "facility.workspace.id": workspaceId,
  "facility.workload.kind": "workspace-v2",
};
/** Labels of a container created by the current bootstrap. */
const currentLabels = { ...ownedLabels, "facility.workspace.bootstrap": "2" };

/**
 * A container that boots the way the workspace bootstrap does: `start` returns
 * immediately, and the readiness marker only appears after `readyAfterProbes`
 * probes. Every probe is recorded so a test can prove one was made — or wasn't.
 */
function fakeDocker(options: {
  running: boolean;
  readyAfterProbes: number;
  bootstrapExits?: boolean;
}) {
  const probes: string[][] = [];
  const state = {
    running: options.running,
    startedAt: "2026-09-07T09:00:00.000000000Z",
    remaining: options.readyAfterProbes,
  };
  const start = vi.fn(async () => {
    // A bootstrap that dies on start leaves the container stopped again.
    state.running = options.bootstrapExits !== true;
    state.startedAt = "2026-09-07T10:00:00.000000000Z";
  });
  const inspect = vi.fn(async () => ({
    Id: "container-1",
    State: { Running: state.running, StartedAt: state.startedAt, ExitCode: 0 },
    Config: { Labels: currentLabels },
    Mounts: [{ Destination: "/workspace", Name: workspace.volumeRef }],
  }));
  const container = {
    id: "container-1",
    inspect,
    start,
    exec: async (options: { Cmd: string[] }) => {
      probes.push(options.Cmd);
      const ready = state.remaining <= 0;
      state.remaining -= 1;
      return {
        start: async () => undefined,
        inspect: async () => ({ Running: false, ExitCode: ready ? 0 : 1 }),
      };
    },
  };
  const docker = { getContainer: vi.fn(() => container) } as unknown as Docker;
  return { docker, container, start, inspect, probes };
}

describe("Docker workspace readiness", () => {
  it("waits for the bootstrap before handing back a woken workspace", async () => {
    const { docker, start, probes } = fakeDocker({ running: false, readyAfterProbes: 2 });
    const runtime = new DockerWorkspaceRuntime(docker);

    await expect(runtime.wake(workspace)).resolves.toMatchObject({
      computeRef: "container-1",
      state: "running",
    });

    expect(start).toHaveBeenCalledOnce();
    // Two failing probes plus the one that finally observed the marker.
    expect(probes).toHaveLength(3);
    expect(probes.at(-1)?.at(-1)).toContain("/workspace/.facility/runtime-ready");
  });

  it("waits for a container someone else started and is still booting", async () => {
    const { docker, start, probes } = fakeDocker({ running: true, readyAfterProbes: 1 });
    const runtime = new DockerWorkspaceRuntime(docker);

    await runtime.wake(workspace);

    expect(start).not.toHaveBeenCalled();
    expect(probes).toHaveLength(2);
  });

  it("proves each container start once and reuses the result on later wakes", async () => {
    const { docker, probes } = fakeDocker({ running: true, readyAfterProbes: 0 });
    const runtime = new DockerWorkspaceRuntime(docker);

    await runtime.wake(workspace);
    await runtime.wake(workspace);
    await runtime.wake(workspace);

    expect(probes).toHaveLength(1);
  });

  it("inspects a running container once per wake", async () => {
    const { docker, inspect } = fakeDocker({ running: true, readyAfterProbes: 0 });
    const runtime = new DockerWorkspaceRuntime(docker);
    await runtime.wake(workspace);
    inspect.mockClear();

    await runtime.wake(workspace);

    expect(inspect).toHaveBeenCalledOnce();
  });

  it("refuses a workspace whose bootstrap exited instead of reporting it ready", async () => {
    const { docker } = fakeDocker({
      running: false,
      readyAfterProbes: 0,
      bootstrapExits: true,
    });

    await expect(new DockerWorkspaceRuntime(docker).wake(workspace)).rejects.toMatchObject({
      code: "workspace_initialize_failed",
    });
  });
});

/** Records the container definition `create` builds, without a Docker daemon. */
function recordingDocker() {
  const created: Array<Record<string, unknown>> = [];
  const notFound = Object.assign(new Error("no such container"), { statusCode: 404 });
  const container = {
    id: "container-new",
    start: async () => undefined,
    remove: async () => undefined,
    inspect: async () => ({
      Id: "container-new",
      State: { Running: true, StartedAt: "2026-09-15T10:00:00.000000000Z", ExitCode: 0 },
      NetworkSettings: { Ports: {} },
    }),
    exec: async () => ({
      start: async () => undefined,
      inspect: async () => ({ Running: false, ExitCode: 0 }),
    }),
  };
  const docker = {
    getContainer: () => ({
      ...container,
      inspect: async () => {
        throw notFound;
      },
    }),
    getVolume: () => ({
      inspect: async () => {
        throw notFound;
      },
    }),
    getNetwork: () => ({
      inspect: async () => {
        throw notFound;
      },
    }),
    getImage: () => ({ inspect: async () => ({}) }),
    createNetwork: async () => ({}),
    createVolume: async () => ({}),
    createContainer: async (options: Record<string, unknown>) => {
      created.push(options);
      return container;
    },
  } as unknown as Docker;
  return { docker, created };
}

describe("Docker workspace bootstrap", () => {
  it("clears the previous start's daemon runtime state before starting dockerd", async () => {
    const { docker, created } = recordingDocker();

    await new DockerWorkspaceRuntime(docker).create({
      id: workspaceId,
      image: "facility-runner:test",
    });

    const script = String((created[0]?.Cmd as string[])[0]);
    const lines = script.split("\n");
    const cleanup = lines.findIndex((line) => line.includes("/var/run/docker.pid"));
    const daemon = lines.findIndex((line) => line.startsWith("dockerd "));

    // A stopped container keeps its writable layer, so dockerd finds the pidfile
    // its previous start wrote and refuses to boot. Removing it after the daemon
    // line would be useless, which is why the order is asserted and not just the
    // presence of the command.
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(daemon).toBeGreaterThan(cleanup);
    expect(lines[cleanup]).toContain("/var/run/docker");
    expect(lines[cleanup]).toContain("/var/run/docker.sock");
  });

  it("labels a new container with the bootstrap revision it was created from", async () => {
    const { docker, created } = recordingDocker();

    await new DockerWorkspaceRuntime(docker).create({
      id: workspaceId,
      image: "facility-runner:test",
    });

    expect(created[0]?.Labels).toEqual(currentLabels);
  });
});

/**
 * A container created before the bootstrap was revised. Docker stored the old
 * script as its command, so starting it would run that script again.
 */
function outdatedDocker(options: { running: boolean }) {
  const notFound = Object.assign(new Error("no such container"), { statusCode: 404 });
  let removed = false;
  const created: Array<Record<string, unknown>> = [];
  const old = {
    start: vi.fn(async () => undefined),
    remove: vi.fn(async (_options: { force: boolean; v: boolean }) => {
      removed = true;
    }),
    inspect: async () => ({
      Id: "container-old",
      State: {
        Running: options.running,
        StartedAt: "2026-09-07T09:00:00.000000000Z",
        ExitCode: 0,
      },
      Config: { Labels: ownedLabels },
      Mounts: [{ Destination: "/workspace", Name: workspace.volumeRef }],
    }),
    exec: async () => ({
      start: async () => undefined,
      inspect: async () => ({ Running: false, ExitCode: 0 }),
    }),
  };
  const replacement = {
    id: "container-new",
    start: vi.fn(async () => undefined),
    remove: async () => undefined,
    inspect: async () => ({
      Id: "container-new",
      State: { Running: true, StartedAt: "2026-11-11T10:00:00.000000000Z", ExitCode: 0 },
    }),
    exec: old.exec,
  };
  const docker = {
    getContainer: (name: string) => {
      if (name === "container-new") return replacement;
      if (name === "container-old" || !removed) return old;
      return {
        inspect: async () => {
          throw notFound;
        },
      };
    },
    getImage: () => ({ inspect: async () => ({}) }),
    getNetwork: () => ({
      inspect: async () => {
        throw notFound;
      },
    }),
    createNetwork: async () => ({}),
    createVolume: async () => ({}),
    createContainer: async (definition: Record<string, unknown>) => {
      created.push(definition);
      return replacement;
    },
  } as unknown as Docker;
  return { docker, old, replacement, created };
}

describe("Docker workspace created by an older bootstrap", () => {
  it("is recreated from the current bootstrap instead of started, keeping its volume", async () => {
    const { docker, old, replacement, created } = outdatedDocker({ running: false });

    await expect(new DockerWorkspaceRuntime(docker).wake(workspace)).resolves.toMatchObject({
      computeRef: "container-new",
      state: "running",
    });

    expect(old.start).not.toHaveBeenCalled();
    expect(old.remove).toHaveBeenCalledWith({ force: true, v: false });
    expect(created).toHaveLength(1);
    expect(String((created[0]?.Cmd as string[])[0])).toContain("/var/run/docker.pid");
    expect(created[0]?.Labels).toEqual(currentLabels);
    expect(replacement.start).toHaveBeenCalledOnce();
  });

  it("is left alone while it is running, since its bootstrap already finished", async () => {
    const { docker, old, created } = outdatedDocker({ running: true });

    await expect(new DockerWorkspaceRuntime(docker).wake(workspace)).resolves.toMatchObject({
      computeRef: "container-old",
    });

    expect(old.remove).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});
