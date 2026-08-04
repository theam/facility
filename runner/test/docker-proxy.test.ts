import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { dockerRequestPolicy, startDockerProxy, validateDockerBody } from "../src/docker-proxy.js";
import { untrustedSpawnIdentity } from "../src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("restricted Docker API", () => {
  test("allows build and ordinary container lifecycle calls", () => {
    expect(dockerRequestPolicy("POST", "/v1.47/build?t=repo%2Fimage")).toEqual({
      allowed: true,
    });
    expect(dockerRequestPolicy("POST", "/v1.47/containers/create")).toEqual({
      allowed: true,
      validateBody: "container",
    });
    expect(dockerRequestPolicy("POST", "/v1.47/containers/abc/start")).toEqual({
      allowed: true,
    });
    expect(dockerRequestPolicy("POST", "/v1.47/volumes/create")).toEqual({
      allowed: true,
      validateBody: "volume",
    });
    expect(validateDockerBody("container", { HostConfig: {} })).toBeNull();
  });

  test("denies daemon administration and runtime privilege escalation", () => {
    for (const path of ["/plugins/pull", "/swarm/init", "/containers/abc/update"]) {
      expect(dockerRequestPolicy("POST", path)).toMatchObject({ allowed: false });
    }
    for (const [body, reason] of [
      [{ HostConfig: { Privileged: true } }, "privileged_container_denied"],
      [{ HostConfig: { PidMode: "host" } }, "host_config_pidmode_denied"],
      [{ HostConfig: { NetworkMode: "host" } }, "host_network_denied"],
      [{ HostConfig: { Binds: ["/proc:/host-proc:ro"] } }, "host_bind_source_denied"],
      [
        { HostConfig: { Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] } },
        "host_bind_source_denied",
      ],
      [{ HostConfig: { CapAdd: ["SYS_ADMIN"] } }, "host_config_capadd_denied"],
      [{ HostConfig: { MaskedPaths: [] } }, "host_config_maskedpaths_denied"],
      [
        {
          HostConfig: {
            Mounts: [
              {
                Type: "volume",
                Source: "escape",
                Target: "/raw",
                VolumeOptions: {
                  DriverConfig: {
                    Name: "local",
                    Options: { type: "none", o: "bind", device: "/run/facility-docker" },
                  },
                },
              },
            ],
          },
        },
        "host_mount_volume_driver_denied",
      ],
    ] as const) {
      expect(validateDockerBody("container", body)).toBe(reason);
    }
    expect(validateDockerBody("exec", { Privileged: true })).toBe("privileged_exec_denied");
    expect(
      validateDockerBody("volume", {
        Driver: "local",
        DriverOpts: { type: "none", o: "bind", device: "/run/facility-docker/docker.sock" },
      }),
    ).toBe("volume_driver_options_denied");
  });

  test("blocks a proc credential-recovery bind before it reaches dockerd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-proxy-"));
    const upstreamSocket = join(dir, "upstream.sock");
    const publicSocket = join(dir, "public.sock");
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
    await listen(upstream, upstreamSocket);
    const proxy = await startDockerProxy({ publicSocket, upstreamSocket });
    cleanup.push(async () => {
      await close(proxy);
      await close(upstream);
      await rm(dir, { recursive: true, force: true });
    });

    const denied = await request(publicSocket, "/v1.47/containers/create", {
      Image: "facility-security-smoke:local",
      HostConfig: { Binds: ["/proc:/host-proc:ro"] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("host_bind_source_denied");
    expect(upstreamRequests).toBe(0);

    const deniedVolume = await request(publicSocket, "/v1.47/volumes/create", {
      Name: "raw-socket",
      Driver: "local",
      DriverOpts: { type: "none", o: "bind", device: "/run/facility-docker" },
    });
    expect(deniedVolume.status).toBe(403);
    expect(deniedVolume.body).toContain("volume_driver_options_denied");
    expect(upstreamRequests).toBe(0);

    const deniedVolumeMount = await request(publicSocket, "/v1.47/containers/create", {
      Image: "facility-security-smoke:local",
      HostConfig: {
        Mounts: [
          {
            Type: "volume",
            Source: "raw-socket",
            Target: "/raw",
            VolumeOptions: {
              DriverConfig: { Name: "local", Options: { device: "/run/facility-docker" } },
            },
          },
        ],
      },
    });
    expect(deniedVolumeMount.status).toBe(403);
    expect(deniedVolumeMount.body).toContain("host_mount_volume_driver_denied");
    expect(upstreamRequests).toBe(0);

    const accepted = await request(publicSocket, "/v1.47/containers/create", {
      Image: "facility-security-smoke:local",
      HostConfig: {},
    });
    expect(accepted.status).toBe(201);
    expect(upstreamRequests).toBe(1);
  });

  test("forwards the Docker attach protocol upgrade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-upgrade-"));
    const upstreamSocket = join(dir, "upstream.sock");
    const publicSocket = join(dir, "public.sock");
    const upstream = http.createServer();
    upstream.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nready");
    });
    await listen(upstream, upstreamSocket);
    const proxy = await startDockerProxy({ publicSocket, upstreamSocket });
    cleanup.push(async () => {
      await close(proxy);
      await close(upstream);
      await rm(dir, { recursive: true, force: true });
    });

    await expect(upgrade(publicSocket, "/v1.47/containers/abc/attach?stream=1")).resolves.toBe(
      "ready",
    );
  });
});

test("the CodeBuild runner uses a different identity for untrusted commands", () => {
  expect(untrustedSpawnIdentity(() => 0)).toEqual({ uid: 1000, gid: 1000 });
  expect(untrustedSpawnIdentity(() => 501)).toEqual({});
});

function listen(server: http.Server, socket: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function request(socketPath: string, path: string, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(json) },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk.toString();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
      },
    );
    req.on("error", reject);
    req.end(json);
  });
}

function upgrade(socketPath: string, path: string) {
  return new Promise<string>((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: "POST",
      path,
      headers: { connection: "Upgrade", upgrade: "tcp" },
    });
    req.on("upgrade", (_response, socket, head) => {
      let body = head.toString();
      const finish = () => {
        socket.destroy();
        resolve(body);
      };
      if (body) return finish();
      socket.once("data", (chunk) => {
        body += chunk.toString();
        finish();
      });
    });
    req.on("error", reject);
    req.end();
  });
}
