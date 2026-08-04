import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  dockerRequestPolicy,
  secureDockerBindSources,
  startDockerProxy,
  validateDockerBody,
} from "../src/docker-proxy.js";
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
    expect(dockerRequestPolicy("GET", "/v1.47/containers/abc/archive?path=/tmp/out")).toEqual({
      allowed: true,
    });
    expect(dockerRequestPolicy("POST", "/v1.47/commit?container=abc")).toEqual({
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

  test("rewrites validated workspace binds to root-pinned aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-workspace-view-"));
    const workspaceRoot = join(dir, "work");
    const workspaceView = join(dir, "trusted-work");
    const source = join(workspaceRoot, "repo");
    const outside = join(dir, "outside");
    await mkdir(source, { recursive: true });
    await mkdir(workspaceView);
    await mkdir(outside);
    await symlink(outside, join(workspaceRoot, "escape"));
    const upstreamSocket = join(dir, "upstream.sock");
    const publicSocket = join(dir, "public.sock");
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const pinnedSources: string[] = [];
    const upstream = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      upstreamBodies.push(JSON.parse(body));
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
    await listen(upstream, upstreamSocket);
    const proxy = await startDockerProxy({
      publicSocket,
      upstreamSocket,
      workspaceRoot,
      pinBindSources: async (resolved) => {
        pinnedSources.push(...resolved);
        return resolved.map((_, index) => join(workspaceView, `pin-${index + 1}`));
      },
    });
    cleanup.push(async () => {
      await close(proxy);
      await close(upstream);
      await rm(dir, { recursive: true, force: true });
    });

    const accepted = await request(publicSocket, "/v1.47/containers/create", {
      Image: "facility-security-smoke:local",
      HostConfig: {
        Binds: [`${source}:/repo:ro`],
        Mounts: [{ Type: "bind", Source: source, Target: "/repo-again" }],
      },
    });
    expect(accepted.status).toBe(201);
    expect(upstreamBodies).toEqual([
      {
        Image: "facility-security-smoke:local",
        HostConfig: {
          Binds: [`${workspaceView}/pin-1:/repo:ro`],
          Mounts: [{ Type: "bind", Source: `${workspaceView}/pin-2`, Target: "/repo-again" }],
        },
      },
    ]);
    const resolvedSource = await realpath(source);
    expect(pinnedSources).toEqual([resolvedSource, resolvedSource]);

    const denied = await request(publicSocket, "/v1.47/containers/create", {
      Image: "facility-security-smoke:local",
      HostConfig: { Binds: [`${workspaceRoot}/escape:/host:ro`] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("host_bind_source_escape_denied");
    expect(upstreamBodies).toHaveLength(1);
  });

  test("pins all workspace binds in one transaction before rewriting the request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-bind-transaction-"));
    const workspaceRoot = join(dir, "work");
    const first = join(workspaceRoot, "first");
    const second = join(workspaceRoot, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second);
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const body = {
      HostConfig: {
        Binds: [`${first}:/first:ro`],
        Mounts: [{ Type: "bind", Source: second, Target: "/second" }],
      },
    };

    await expect(
      secureDockerBindSources(body, workspaceRoot, async (sources) => {
        expect(sources).toEqual([await realpath(first), await realpath(second)]);
        throw new Error("workspace_bind_source_denied");
      }),
    ).resolves.toBe("workspace_bind_source_denied");
    expect(body.HostConfig).toEqual({
      Binds: [`${first}:/first:ro`],
      Mounts: [{ Type: "bind", Source: second, Target: "/second" }],
    });
  });

  test("forwards a Docker exec upgrade body before waiting for 101", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-upgrade-"));
    const upstreamSocket = join(dir, "upstream.sock");
    const publicSocket = join(dir, "public.sock");
    const execBody = JSON.stringify({ Detach: false, Tty: false });
    const upstream = net.createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        const headersEnd = received.indexOf("\r\n\r\n");
        if (headersEnd < 0) return;
        const headers = received.subarray(0, headersEnd).toString();
        const contentLength = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1] ?? "0");
        const body = received.subarray(headersEnd + 4);
        if (body.length < contentLength) return;
        expect(headers).toContain("POST /v1.47/exec/abc/start HTTP/1.1");
        expect(body.subarray(0, contentLength).toString()).toBe(execBody);
        socket.end("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nready");
      });
    });
    await listen(upstream, upstreamSocket);
    const proxy = await startDockerProxy({ publicSocket, upstreamSocket });
    cleanup.push(async () => {
      await close(proxy);
      await close(upstream);
      await rm(dir, { recursive: true, force: true });
    });

    await expect(upgrade(publicSocket, "/v1.47/exec/abc/start", execBody)).resolves.toBe("ready");
  });

  test("flushes long-lived Docker response headers before the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facility-docker-stream-"));
    const upstreamSocket = join(dir, "upstream.sock");
    const publicSocket = join(dir, "public.sock");
    let finishUpstream = () => {};
    const upstreamFinished = new Promise<void>((resolve) => {
      finishUpstream = resolve;
    });
    const upstream = http.createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      await upstreamFinished;
      response.end("{}");
    });
    await listen(upstream, upstreamSocket);
    const proxy = await startDockerProxy({ publicSocket, upstreamSocket });
    cleanup.push(async () => {
      finishUpstream();
      await close(proxy);
      await close(upstream);
      await rm(dir, { recursive: true, force: true });
    });

    const headersReceived = new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: publicSocket,
          method: "POST",
          path: "/v1.47/containers/abc/wait",
          headers: { connection: "close" },
        },
        (response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        },
      );
      request.on("error", reject);
      request.end();
    });
    const result = await Promise.race([
      headersReceived,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    finishUpstream();
    expect(result).toBe(200);
  });
});

test("the CodeBuild runner uses a different identity for untrusted commands", () => {
  expect(untrustedSpawnIdentity(() => 0)).toEqual({ uid: 1000, gid: 1000 });
  expect(untrustedSpawnIdentity(() => 501)).toEqual({});
});

test("custom CodeBuild lifecycle commands drop root", async () => {
  const script = await readFile(new URL("../codebuild-runner.sh", import.meta.url), "utf8");
  expect(script).toMatch(
    /exec setpriv --reuid="\$untrusted_uid" --regid="\$untrusted_gid" --clear-groups -- "\$@"/,
  );
});

test("CodeBuild metadata egress is scoped to untrusted identities", async () => {
  const script = await readFile(new URL("../codebuild-runner.sh", import.meta.url), "utf8");
  expect(script).toContain(
    'for isolated_uid in "$untrusted_uid" "$(id -u "$docker_user")" "$(id -u "$proxy_user")"; do',
  );
  expect(script).toContain(
    'iptables -I OUTPUT 1 -m owner --uid-owner "$isolated_uid" -d 169.254.0.0/16 -j REJECT',
  );
  expect(script).toContain("iptables -I FORWARD 1 -d 169.254.0.0/16 -j REJECT");
  expect(script).not.toContain("iptables -I OUTPUT 1 -d 169.254.0.0/16 -j REJECT");
});

function listen(server: http.Server | net.Server, socket: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
}

function close(server: http.Server | net.Server) {
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

function upgrade(socketPath: string, path: string, body: string) {
  return new Promise<string>((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: "POST",
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "tcp",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
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
    req.end(body);
  });
}
