import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import type { WorkspaceLocator } from "../src/workspaces/runtime.js";

// A deterministic stand-in for the Docker Engine API, modelling only the semantics that
// matter here: named volumes outlive containers, a volume in use cannot be removed, and
// `createVolume` with an unused name creates a new, empty volume.
class SimulatedDockerDaemon {
  readonly containers = new Map<string, Docker.ContainerInspectInfo>();
  readonly volumes = new Map<
    string,
    { labels: Record<string, string>; files: Map<string, string> }
  >();
  readonly networks = new Map<string, { Labels: Record<string, string> }>();
  readonly createdVolumes: string[] = [];
  private nextId = 1;
  readonly modem = { followProgress: (_stream: unknown, done: (e: unknown) => void) => done(null) };

  getImage() {
    return { inspect: async () => ({}) };
  }

  getNetwork(name: string) {
    return {
      inspect: async () => this.networks.get(name) ?? notFound(),
      remove: async () => void this.networks.delete(name),
    };
  }

  async createNetwork(options: { Name: string; Labels: Record<string, string> }) {
    this.networks.set(options.Name, { Labels: options.Labels });
  }

  getVolume(name: string) {
    return {
      inspect: async () => this.volumes.get(name) ?? notFound(),
      remove: async () => {
        if (!this.volumes.has(name)) notFound();
        const inUse = [...this.containers.values()].some((c) =>
          c.Mounts?.some((mount) => mount.Name === name),
        );
        if (inUse) throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
        this.volumes.delete(name);
      },
    };
  }

  async createVolume(options: { Name: string; Labels: Record<string, string> }) {
    this.createdVolumes.push(options.Name);
    if (!this.volumes.has(options.Name))
      this.volumes.set(options.Name, { labels: options.Labels, files: new Map() });
    return {};
  }

  async createContainer(options: {
    name: string;
    Labels: Record<string, string>;
    HostConfig: { Mounts: { Source: string; Target: string }[] };
  }) {
    const id = `container-${this.nextId++}`;
    this.containers.set(options.name, {
      Id: id,
      Name: options.name,
      Config: { Labels: options.Labels },
      Mounts: options.HostConfig.Mounts.map((mount) => ({
        Name: mount.Source,
        Destination: mount.Target,
      })),
      State: { Running: false, ExitCode: 0 },
    } as unknown as Docker.ContainerInspectInfo);
    return this.getContainer(options.name);
  }

  getContainer(nameOrId: string) {
    const find = () =>
      [...this.containers.entries()].find(([name, c]) => name === nameOrId || c.Id === nameOrId);
    return {
      id: find()?.[1].Id ?? nameOrId,
      inspect: async () => find()?.[1] ?? notFound(),
      start: async () => {
        const entry = find() ?? notFound();
        entry[1].State.Running = true;
      },
      stop: async () => {
        const entry = find() ?? notFound();
        entry[1].State.Running = false;
      },
      remove: async () => {
        const entry = find() ?? notFound();
        this.containers.delete(entry[0]);
      },
      exec: async () => ({
        start: async () => undefined,
        inspect: async () => ({ Running: false, ExitCode: 0 }),
      }),
    };
  }

  // Test helpers: the files a turn left in the volume, and an out-of-band volume loss
  // (host replaced, disk failure, `docker volume prune`, provider incident).
  writeToVolume(name: string, path: string, content: string) {
    this.volumes.get(name)?.files.set(path, content);
  }

  loseVolume(name: string) {
    this.volumes.delete(name);
  }
}

function notFound(): never {
  throw Object.assign(new Error("not found"), { statusCode: 404 });
}

async function storyWithUncommittedWork() {
  const daemon = new SimulatedDockerDaemon();
  const runtime = new DockerWorkspaceRuntime(daemon as unknown as Docker);
  const created = await runtime.create({ id: "ws_0123456789abcdef", image: "facility-runner:dev" });
  const workspace = created as WorkspaceLocator;
  daemon.writeToVolume(workspace.volumeRef, "repo/uncommitted.txt", "two hours of agent work");
  daemon.writeToVolume(workspace.volumeRef, ".facility/claude/session.jsonl", "native session");
  // The story goes idle; compute is later replaced, which Facility treats as routine.
  await runtime.suspend(workspace);
  await runtime.replaceCompute(workspace);
  return { daemon, runtime, workspace, created };
}

describe("DockerWorkspaceRuntime when the durable volume is lost", () => {
  it("still resumes after routine compute replacement (baseline)", async () => {
    const { daemon, runtime, workspace } = await storyWithUncommittedWork();
    await runtime.wake(workspace);
    expect(daemon.volumes.get(workspace.volumeRef)?.files.get("repo/uncommitted.txt")).toBe(
      "two hours of agent work",
    );
  });

  it("reports the workspace as destroyed when inspected", async () => {
    const { daemon, runtime, workspace } = await storyWithUncommittedWork();
    daemon.loseVolume(workspace.volumeRef);
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
  });

  it("refuses to wake instead of presenting an empty replacement volume as the story", async () => {
    const { daemon, runtime, workspace } = await storyWithUncommittedWork();
    daemon.loseVolume(workspace.volumeRef);

    await expect(runtime.wake(workspace)).rejects.toMatchObject({
      code: "workspace_volume_lost",
    });
    expect(daemon.createdVolumes).toEqual([workspace.volumeRef]);
    expect(daemon.volumes.has(workspace.volumeRef)).toBe(false);
  });

  it("does not resume commands against a lost volume", async () => {
    const { daemon, runtime, workspace } = await storyWithUncommittedWork();
    daemon.loseVolume(workspace.volumeRef);

    await expect(
      runtime.exec(workspace, { command: "sh", args: ["-lc", "cat repo/uncommitted.txt"] }),
    ).rejects.toMatchObject({ code: "workspace_volume_lost" });
    expect(daemon.volumes.has(workspace.volumeRef)).toBe(false);
  });
});
