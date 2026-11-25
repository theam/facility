import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import { previewGatewayPorts, type WorkspaceLocator } from "../src/workspaces/runtime.js";

const id = "ws_0123456789abcdef";
const suffix = createHash("sha256").update(id).digest("hex").slice(0, 24);
const names = {
  container: `facility-ws-${suffix}`,
  volume: `facility-ws-volume-${suffix}`,
  network: `facility-ws-network-${suffix}`,
};
const ports = [{ service: "web", port: 3_000 }];
const gatewayPort = previewGatewayPorts(ports)[0]?.gatewayPort;
if (!gatewayPort) throw new Error("the fixture needs one preview gateway port");
const workspace: WorkspaceLocator = {
  id,
  image: "facility-runner:test",
  externalRef: names.container,
  volumeRef: names.volume,
  expectedComputeRef: "container-original",
  ports,
};
const label = "facility.preview-proxy=true";

function fakeDocker(proxies: string[]) {
  const calls: string[] = [];
  const details = {
    Id: "container-original",
    Name: `/${names.container}`,
    State: { Running: true },
    Config: { Labels: { "facility.workspace.id": id, "facility.workload.kind": "workspace-v2" } },
    Mounts: [{ Destination: "/workspace", Name: names.volume }],
    NetworkSettings: {
      Ports: { [`${gatewayPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "49153" }] },
    },
  };
  const alreadyConnected = Object.assign(
    new Error(`endpoint with name api already exists in network ${names.network}`),
    { statusCode: 403 },
  );
  const notConnected = Object.assign(
    new Error(`container proxy-b is not connected to network ${names.network}`),
    { statusCode: 403 },
  );
  const network = {
    connect: vi.fn(async ({ Container }: { Container: string }) => {
      calls.push(`connect ${Container}`);
      if (Container === "proxy-b") throw alreadyConnected;
    }),
    disconnect: vi.fn(async ({ Container }: { Container: string }) => {
      calls.push(`disconnect ${Container}`);
      if (Container === "proxy-b") throw notConnected;
    }),
    remove: vi.fn(async () => {
      calls.push("remove network");
    }),
  };
  const docker = {
    getContainer: vi.fn(() => ({
      inspect: async () => details,
      remove: vi.fn(async () => {
        calls.push("remove container");
      }),
    })),
    getVolume: vi.fn(() => ({
      inspect: async () => ({}),
      remove: vi.fn(async () => {
        calls.push("remove volume");
      }),
    })),
    getNetwork: vi.fn(() => network),
    listContainers: vi.fn(async () => proxies.map((Id) => ({ Id }))),
  };
  return { docker: docker as unknown as Docker, fake: docker, network, calls };
}

describe("Docker preview endpoints", () => {
  it("keeps the host loopback URL and touches no network when no proxy label is configured", async () => {
    const { docker, fake, network } = fakeDocker(["proxy-a"]);
    const runtime = new DockerWorkspaceRuntime(docker);

    await expect(runtime.expose(workspace, ports)).resolves.toEqual([
      { ...ports[0], url: "http://127.0.0.1:49153" },
    ]);
    expect(fake.listContainers).not.toHaveBeenCalled();
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("joins every labeled proxy to the workspace network and addresses the gateway by container name", async () => {
    const { docker, fake, network } = fakeDocker(["proxy-a", "proxy-b"]);
    const runtime = new DockerWorkspaceRuntime(docker, { previewProxyLabel: label });

    await expect(runtime.expose(workspace, ports)).resolves.toEqual([
      { ...ports[0], url: `http://${names.container}:${gatewayPort}` },
    ]);
    expect(fake.listContainers).toHaveBeenCalledWith({ all: true, filters: { label: [label] } });
    expect(fake.getNetwork).toHaveBeenCalledWith(names.network);
    expect(network.connect.mock.calls.map(([options]) => options)).toEqual([
      { Container: "proxy-a" },
      { Container: "proxy-b" },
    ]);
  });

  it("refuses to publish an unreachable endpoint when no container carries the label", async () => {
    const { docker } = fakeDocker([]);
    const runtime = new DockerWorkspaceRuntime(docker, { previewProxyLabel: label });

    await expect(runtime.expose(workspace, ports)).rejects.toMatchObject({
      code: "preview_proxy_unavailable",
    });
  });

  it("does not look for proxies when the workspace exposes no ports", async () => {
    const { docker, fake } = fakeDocker([]);
    const runtime = new DockerWorkspaceRuntime(docker, { previewProxyLabel: label });

    await expect(runtime.expose(workspace, [])).resolves.toEqual([]);
    expect(fake.listContainers).not.toHaveBeenCalled();
  });

  it("detaches proxies before removing the workspace network", async () => {
    const { docker, calls } = fakeDocker(["proxy-a", "proxy-b"]);
    const runtime = new DockerWorkspaceRuntime(docker, { previewProxyLabel: label });

    await runtime.destroy(workspace);

    expect(calls).toEqual([
      "remove container",
      "remove volume",
      "disconnect proxy-a",
      "disconnect proxy-b",
      "remove network",
    ]);
  });
});
