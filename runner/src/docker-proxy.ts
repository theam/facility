#!/usr/bin/env node
import { chmod, chown, realpath, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

const DEFAULT_PUBLIC_SOCKET = "/run/facility-proxy/docker.sock";
const DEFAULT_UPSTREAM_SOCKET = "/run/facility-docker/docker.sock";
const DEFAULT_WORKSPACE_ROOT = "/work";
const DEFAULT_WORKSPACE_VIEW = "/run/facility-workspace";
const MAX_POLICY_BODY_BYTES = 1024 * 1024;

type PolicyDecision =
  | { allowed: true; validateBody?: "container" | "exec" | "volume" }
  | {
      allowed: false;
      reason: string;
    };

export function dockerRequestPolicy(method: string, rawUrl: string): PolicyDecision {
  const pathname = dockerPath(rawUrl);
  const readOnly = method === "GET" || method === "HEAD";
  if (readOnly && /^\/(?:_ping|version|info|events|system\/df)$/.test(pathname)) {
    return { allowed: true };
  }
  if (
    readOnly &&
    /^\/(?:containers(?:\/json|\/[^/]+\/(?:json|top|logs|stats|changes|export|archive))|images(?:\/json|\/.+\/(?:json|history|get))|networks(?:\/[^/]+)?|volumes(?:\/[^/]+)?)$/.test(
      pathname,
    )
  ) {
    return { allowed: true };
  }
  if (method === "POST" && pathname === "/containers/create") {
    return { allowed: true, validateBody: "container" };
  }
  if (method === "POST" && /^\/containers\/[^/]+\/exec$/.test(pathname)) {
    return { allowed: true, validateBody: "exec" };
  }
  if (method === "POST" && pathname === "/volumes/create") {
    return { allowed: true, validateBody: "volume" };
  }
  if (
    method === "POST" &&
    /^(?:\/auth|\/build|\/build\/prune|\/commit|\/images\/(?:create|load|prune)|\/images\/.+\/(?:push|tag)|\/containers\/[^/]+\/(?:start|stop|restart|kill|wait|pause|unpause|rename)|\/exec\/[^/]+\/(?:start|resize)|\/networks\/(?:create|prune)|\/networks\/[^/]+\/(?:connect|disconnect)|\/volumes\/prune)$/.test(
      pathname,
    )
  ) {
    return { allowed: true };
  }
  if (method === "DELETE" && /^\/(?:containers|images|networks|volumes)\/[^/]+$/.test(pathname)) {
    return { allowed: true };
  }
  if (method === "PUT" && /^\/containers\/[^/]+\/archive$/.test(pathname)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `docker_api_denied:${method}:${pathname}` };
}

export function validateDockerBody(
  kind: "container" | "exec" | "volume",
  value: unknown,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_json_object";
  const body = value as Record<string, unknown>;
  if (kind === "exec") return body.Privileged === true ? "privileged_exec_denied" : null;
  if (kind === "volume") {
    const driver = String(body.Driver ?? "");
    if (driver !== "" && driver !== "local") return "volume_driver_denied";
    if (objectKeys(body.DriverOpts).length > 0) return "volume_driver_options_denied";
    return null;
  }

  const host = object(body.HostConfig);
  if (host.Privileged === true) return "privileged_container_denied";
  const deniedNonEmpty = [
    "Devices",
    "DeviceRequests",
    "CapAdd",
    "SecurityOpt",
    "VolumesFrom",
    "DeviceCgroupRules",
  ];
  for (const field of deniedNonEmpty) {
    if (nonEmpty(host[field])) return `host_config_${field.toLowerCase()}_denied`;
  }
  for (const field of ["MaskedPaths", "ReadonlyPaths"]) {
    if (Array.isArray(host[field])) return `host_config_${field.toLowerCase()}_denied`;
  }
  if (objectKeys(host.Sysctls).length > 0) return "host_config_sysctls_denied";
  for (const field of ["CgroupParent", "Runtime"]) {
    if (typeof host[field] === "string" && host[field] !== "") {
      return `host_config_${field.toLowerCase()}_denied`;
    }
  }
  for (const field of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) {
    if (typeof host[field] === "string" && host[field] !== "") {
      return `host_config_${field.toLowerCase()}_denied`;
    }
  }
  if (String(host.NetworkMode ?? "").toLowerCase() === "host") {
    return "host_network_denied";
  }
  for (const source of dockerBindSources(host)) {
    if (!safeBindSource(source, workspaceRoot)) return "host_bind_source_denied";
  }
  if (Array.isArray(host.Mounts)) {
    for (const mount of host.Mounts) {
      const type = String(object(mount).Type ?? "").toLowerCase();
      if (type === "bind") {
        if (!safeBindSource(String(object(mount).Source ?? ""), workspaceRoot)) {
          return "host_bind_source_denied";
        }
      } else if (type === "volume") {
        const volumeOptions = object(object(mount).VolumeOptions);
        if ("DriverConfig" in volumeOptions) return "host_mount_volume_driver_denied";
      } else if (type !== "tmpfs") return "host_mount_denied";
    }
  }
  return null;
}

export async function secureDockerBindSources(
  value: unknown,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  workspaceView = DEFAULT_WORKSPACE_VIEW,
): Promise<string | null> {
  const host = object(object(value).HostConfig);
  const hasBind =
    (Array.isArray(host.Binds) && host.Binds.length > 0) ||
    (Array.isArray(host.Mounts) &&
      host.Mounts.some((mount) => String(object(mount).Type ?? "").toLowerCase() === "bind"));
  if (!hasBind) return null;
  let resolvedWorkspaceRoot: string;
  try {
    resolvedWorkspaceRoot = await realpath(workspaceRoot);
  } catch {
    return "workspace_root_unresolved";
  }
  if (Array.isArray(host.Binds)) {
    for (let index = 0; index < host.Binds.length; index += 1) {
      const bind = String(host.Binds[index]);
      const source = bind.split(":", 1)[0] ?? "";
      const secured = await secureBindSource(source, resolvedWorkspaceRoot, workspaceView);
      if (typeof secured !== "string") return secured.reason;
      host.Binds[index] = `${secured}${bind.slice(source.length)}`;
    }
  }
  if (Array.isArray(host.Mounts)) {
    for (const value of host.Mounts) {
      const mount = object(value);
      if (String(mount.Type ?? "").toLowerCase() !== "bind") continue;
      const secured = await secureBindSource(
        String(mount.Source ?? ""),
        resolvedWorkspaceRoot,
        workspaceView,
      );
      if (typeof secured !== "string") return secured.reason;
      mount.Source = secured;
    }
  }
  return null;
}

export async function startDockerProxy(
  options: {
    publicSocket?: string;
    upstreamSocket?: string;
    socketUid?: number;
    socketGid?: number;
    workspaceRoot?: string;
    workspaceView?: string;
  } = {},
) {
  const publicSocket = options.publicSocket ?? DEFAULT_PUBLIC_SOCKET;
  const upstreamSocket = options.upstreamSocket ?? DEFAULT_UPSTREAM_SOCKET;
  const workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspaceView = options.workspaceView ?? DEFAULT_WORKSPACE_VIEW;
  await rm(publicSocket, { force: true });
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, upstreamSocket, workspaceRoot, workspaceView);
  });
  server.on("upgrade", (request, client, head) => {
    handleUpgrade(request, client, head, upstreamSocket);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicSocket, () => resolve());
  });
  await chmod(publicSocket, 0o660);
  if (options.socketUid !== undefined && options.socketGid !== undefined) {
    await chown(publicSocket, options.socketUid, options.socketGid);
  }
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamSocket: string,
  workspaceRoot: string,
  workspaceView: string,
) {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  const decision = dockerRequestPolicy(method, url);
  if (!decision.allowed) return reject(response, decision.reason);
  let body: Buffer | undefined;
  if (decision.validateBody) {
    try {
      body = await readBounded(request, MAX_POLICY_BODY_BYTES);
      const parsed = JSON.parse(body.toString("utf8"));
      const reason =
        validateDockerBody(decision.validateBody, parsed, workspaceRoot) ??
        (decision.validateBody === "container"
          ? await secureDockerBindSources(parsed, workspaceRoot, workspaceView)
          : null);
      if (reason) return reject(response, reason);
      body = Buffer.from(JSON.stringify(parsed));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid_request";
      return reject(response, reason);
    }
  }
  const headers = { ...request.headers, host: "docker" };
  if (body) headers["content-length"] = String(body.length);
  const upstream = http.request({ socketPath: upstreamSocket, method, path: url, headers });
  upstream.on("response", (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`docker_upstream_error:${error.message}`);
  });
  if (body) upstream.end(body);
  else request.pipe(upstream);
}

function handleUpgrade(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  upstreamSocket: string,
) {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  const pathname = dockerPath(url);
  if (method !== "POST" || !/^\/(?:exec\/[^/]+\/start|containers\/[^/]+\/attach)$/.test(pathname)) {
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 21\r\n\r\ndocker_upgrade_denied");
    return;
  }
  const upstream = net.createConnection(upstreamSocket, () => {
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstream.write(
      `${method} ${url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on("error", () => client.destroy());
}

function dockerPath(rawUrl: string) {
  const pathname = new URL(rawUrl, "http://docker").pathname;
  return pathname.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, "");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function objectKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function dockerBindSources(host: Record<string, unknown>) {
  if (!Array.isArray(host.Binds)) return [];
  return host.Binds.map((bind) => String(bind).split(":", 1)[0] ?? "");
}

function safeBindSource(source: string, workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  if (source === workspaceRoot || source.startsWith(`${workspaceRoot}/`)) return true;
  if (source === "/var/run/docker.sock" || source === DEFAULT_PUBLIC_SOCKET) return true;
  // No slash means a Docker-managed named volume, not a host bind.
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source);
}

async function secureBindSource(
  source: string,
  workspaceRoot: string,
  workspaceView: string,
): Promise<string | { reason: string }> {
  if (!source.startsWith("/")) return source;
  let resolved: string;
  try {
    resolved = await realpath(source);
  } catch {
    return { reason: "host_bind_source_unresolved" };
  }
  if (!safeBindSource(resolved, workspaceRoot)) {
    return { reason: "host_bind_source_escape_denied" };
  }
  if (resolved === workspaceRoot) return workspaceView;
  if (resolved.startsWith(`${workspaceRoot}/`)) {
    return `${workspaceView}${resolved.slice(workspaceRoot.length)}`;
  }
  return resolved;
}

function reject(response: ServerResponse, reason: string) {
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: reason }));
}

async function readBounded(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("docker_policy_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDockerProxy({
    publicSocket: process.env.FACILITY_DOCKER_SOCKET,
    upstreamSocket: process.env.FACILITY_DOCKER_UPSTREAM_SOCKET,
    workspaceView: process.env.FACILITY_DOCKER_WORKSPACE_VIEW,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
