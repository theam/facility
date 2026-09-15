#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as upstreamRequest } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION = /^psess_[a-z0-9]{16,64}$/;
const COOKIE = "__Host-facility-preview";
const NONCE = "__Host-facility-preview-login";
const reserved = (name) => name.startsWith("__Host-facility-") || name === "facility_session";

export function nativePreviewConfig(raw) {
  if (!raw) return undefined;
  const value = JSON.parse(raw);
  for (const field of ["apiUrl", "webUrl", "origin"]) {
    const url = new URL(value[field]);
    if (url.origin !== value[field] || url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid native preview configuration");
  }
  if (
    !/^ws_[a-z0-9]{16,64}$/.test(value.workspaceId) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.service) ||
    !/^[a-z0-9-]+\.vercel\.run$/.test(new URL(value.origin).hostname) ||
    new URL(value.origin).port
  )
    throw new Error("Invalid native preview binding");
  return value;
}
function cookieValue(request, name) {
  const values = String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : "";
}
function setCookie(name, value, age) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}
export function applicationHeaders(headers, target, native) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^(?:x-facility-|proxy-|host$|cookie$)/i.test(name)) continue;
    if (native && /^(?:x-forwarded-|forwarded$)/i.test(name)) continue;
    forwarded[name] = value;
  }
  const cookies = String(headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !reserved(part.split("=", 1)[0]))
    .join("; ");
  if (cookies) forwarded.cookie = cookies;
  forwarded.host = `127.0.0.1:${target}`;
  if (native) {
    forwarded["x-forwarded-host"] = new URL(native.origin).host;
    forwarded["x-forwarded-proto"] = "https";
  }
  return forwarded;
}

/** Facility infrastructure, independent of the repository's Compose/application. */
export function createPreviewGateway({ target, secret, native, fetchImpl = fetch }) {
  if (!Number.isInteger(target) || target < 1 || target > 65_535 || secret.length < 32)
    throw new Error("Invalid preview gateway configuration");
  const internal = (value) =>
    typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(secret));
  const call = async (action, body) => {
    const url =
      native.apiUrl +
      "/workspace-preview-native/" +
      native.workspaceId +
      "/" +
      native.service +
      "/" +
      action;
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", "x-facility-preview-token": secret },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw Object.assign(new Error("Preview access unavailable"), { status: response.status });
    return response.json();
  };
  const authorize = async (request) => {
    if (internal(request.headers["x-facility-preview-token"])) return;
    if (!native) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    const parts = cookieValue(request, COOKIE).split(".");
    if (parts.length !== 2 || !SESSION.test(parts[0]) || !TOKEN.test(parts[1]))
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    await call("authorize", { sessionId: parts[0], token: parts[1] });
  };
  const login = (response) => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(
      `/api/workspace-preview-login/${native.workspaceId}/${native.service}`,
      native.webUrl,
    );
    url.searchParams.set("challenge", createHash("sha256").update(verifier).digest("base64url"));
    response.writeHead(302, {
      location: url.toString(),
      "set-cookie": setCookie(NONCE, verifier, 120),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end();
  };
  const server = createServer(async (incoming, response) => {
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("referrer-policy", "no-referrer");
    let path;
    try {
      path = new URL(incoming.url, "http://gateway.invalid");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (native && path.pathname.startsWith("/.facility/")) {
      if (
        path.pathname === "/.facility/health" &&
        incoming.method === "GET" &&
        internal(incoming.headers["x-facility-preview-token"])
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ native: true, origin: native.origin }));
        return;
      }
      if (path.pathname !== "/.facility/callback" || incoming.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      const sessionId = path.searchParams.get("session") ?? "";
      const code = path.searchParams.get("code") ?? "";
      const verifier = cookieValue(incoming, NONCE);
      try {
        if (!SESSION.test(sessionId) || !TOKEN.test(code) || !TOKEN.test(verifier))
          throw new Error("Invalid grant");
        const result = await call("exchange", { sessionId, code, verifier });
        if (!TOKEN.test(result.accessToken)) throw new Error("Invalid session");
        const age = Math.min(
          3600,
          Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000),
        );
        if (!Number.isFinite(age) || age <= 0) throw new Error("Expired session");
        response
          .writeHead(302, {
            location: "/",
            "set-cookie": [
              setCookie(COOKIE, `${sessionId}.${result.accessToken}`, age),
              setCookie(NONCE, "", 0),
            ],
          })
          .end();
      } catch {
        response.writeHead(401, {
          "content-type": "text/plain",
          "set-cookie": setCookie(NONCE, "", 0),
        });
        response.end(
          "Preview sign-in expired or was denied. Open the preview again from Facility.",
        );
      }
      return;
    }
    try {
      await authorize(incoming);
    } catch (error) {
      if (
        native &&
        [401, 403].includes(error.status) &&
        incoming.method === "GET" &&
        String(incoming.headers.accept ?? "").includes("text/html")
      )
        login(response);
      else
        response
          .writeHead([401, 403].includes(error.status) ? 401 : 503, {
            "content-type": "text/plain",
          })
          .end("Preview access unavailable");
      return;
    }
    const outgoing = upstreamRequest(
      {
        host: "127.0.0.1",
        port: target,
        path: incoming.url,
        method: incoming.method,
        headers: applicationHeaders(incoming.headers, target, native),
      },
      (upstream) => {
        const headers = {
          ...upstream.headers,
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        };
        if (headers["set-cookie"])
          headers["set-cookie"] = headers["set-cookie"]
            .filter((value) => !reserved(value.split("=", 1)[0].trim()))
            .map((value) => value.replace(/;\s*Domain=[^;]*/gi, ""));
        response.writeHead(upstream.statusCode ?? 502, headers);
        upstream.pipe(response);
      },
    );
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Preview service unavailable");
    });
    incoming.pipe(outgoing);
  });
  server.on("upgrade", (incoming, socket, head) => {
    if (native && incoming.url?.startsWith("/.facility/")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    void authorize(incoming)
      .then(() => {
        const upstream = connect(target, "127.0.0.1", () => {
          const headers = Object.entries(applicationHeaders(incoming.headers, target, native))
            .map(
              ([name, value]) =>
                `${name}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`,
            )
            .join("\r\n");
          upstream.write(
            incoming.method +
              " " +
              incoming.url +
              " HTTP/" +
              incoming.httpVersion +
              "\r\n" +
              headers +
              "\r\n\r\n",
          );
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      })
      .catch(() => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = Object.fromEntries(
    process.argv.slice(2).reduce((entries, value, index, values) => {
      if (value.startsWith("--") && values[index + 1])
        entries.push([value.slice(2), values[index + 1]]);
      return entries;
    }, []),
  );
  const listen = Number(options.listen);
  if (!Number.isInteger(listen) || listen < 1 || listen > 65_535) process.exit(2);
  createPreviewGateway({
    target: Number(options.target),
    secret: process.env.FACILITY_PREVIEW_GATEWAY_TOKEN ?? "",
    native: nativePreviewConfig(process.env.FACILITY_NATIVE_PREVIEW),
  }).listen(listen, "0.0.0.0");
}
