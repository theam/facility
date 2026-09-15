#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer, request as upstreamRequest } from "node:http";
import { connect } from "node:net";

const options = Object.fromEntries(
  process.argv.slice(2).reduce((entries, value, index, values) => {
    if (value.startsWith("--") && values[index + 1])
      entries.push([value.slice(2), values[index + 1]]);
    return entries;
  }, []),
);
const listen = Number(options.listen);
const target = Number(options.target);
const secret = process.env.FACILITY_PREVIEW_GATEWAY_TOKEN ?? "";
if (!Number.isInteger(listen) || listen < 1 || listen > 65_535) process.exit(2);
if (!Number.isInteger(target) || target < 1 || target > 65_535) process.exit(2);
if (secret.length < 32) process.exit(2);

const authorized = (candidate) => {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const server = createServer((incoming, response) => {
  if (!authorized(incoming.headers["x-facility-preview-token"])) {
    response.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Unauthorized");
    return;
  }
  const headers = { ...incoming.headers, host: `127.0.0.1:${target}` };
  delete headers["x-facility-preview-token"];
  const outgoing = upstreamRequest(
    { host: "127.0.0.1", port: target, path: incoming.url, method: incoming.method, headers },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    },
  );
  outgoing.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("Preview service unavailable");
  });
  incoming.pipe(outgoing);
});

server.on("upgrade", (incoming, socket, head) => {
  if (!authorized(incoming.headers["x-facility-preview-token"])) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(target, "127.0.0.1", () => {
    const headers = Object.entries(incoming.headers)
      .filter(([name]) => name !== "x-facility-preview-token")
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`)
      .join("\r\n");
    upstream.write(
      `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers}\r\n\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(listen, "0.0.0.0");
