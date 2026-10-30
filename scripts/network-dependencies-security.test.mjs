import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import { constants, createDeflateRaw } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const apiRequire = createRequire(join(root, "services/api/package.json"));
const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

// Test the versions actually selected by the lockfile, not stale store folders
// left behind by an update or a separately installed test-only dependency.
function lockedModules(name) {
  const versions = [...new Set(
    [...lockfile.matchAll(new RegExp(`^  ${name}@([\\d.]+):`, "gm"))].map((match) => match[1]),
  )];
  assert.ok(versions.length > 0, `${name} must be present in the tested dependency graph`);
  return versions.map((version) => ({
    version,
    module: require(join(root, "node_modules/.pnpm", `${name}@${version}`, "node_modules", name)),
  }));
}

for (const { version, module: uri } of lockedModules("fast-uri")) {
  test(`fast-uri ${version} preserves valid authorities and rejects injected ports`, () => {
    const valid = uri.serialize({ scheme: "https", host: "example.com", port: 8443, path: "/app" });
    assert.equal(new URL(valid).hostname, "example.com");
    assert.equal(new URL(valid).port, "8443");
    assert.throws(() => uri.serialize({
      scheme: "https", host: "example.com", port: "@127.0.0.1:8124", path: "/app",
    }));
  });

  test(`fast-uri ${version} rejects malformed host brackets but accepts IPv6`, () => {
    assert.ok(uri.parse("http://[example.com/").error);
    assert.equal(uri.parse("http://[::1]:8080/").error, undefined);
  });
}

for (const { version, module: { Address6 } } of lockedModules("ip-address")) {
  test(`ip-address ${version} classifies the entire IPv6 link-local range`, () => {
    for (const address of ["fe80::1", "fe81::1", "febf::1", "fe80:0:0:1::1"]) {
      assert.equal(new Address6(address).isLinkLocal(), true, address);
    }
    assert.equal(new Address6("2001:4860:4860::8888").isLinkLocal(), false);
  });

  test(`ip-address ${version} classifies local-use NAT64 as private`, () => {
    for (const address of ["64:ff9b:1::7f00:1", "64:ff9b:1:7f00:0:100::"]) {
      assert.equal(new Address6(address).isPrivate(), true, address);
    }
    assert.equal(new Address6("2001:4860:4860::8888").isPrivate(), false);
  });
}

const { Agent, WebSocket, request } = apiRequire("undici");
const { WebSocketServer } = apiRequire("ws");
const limit = 1024 * 1024;

async function compressedOverLimitFrame() {
  const compressor = createDeflateRaw();
  const chunks = [];
  compressor.on("data", (chunk) => chunks.push(chunk));
  try {
    await new Promise((resolve, reject) => {
      compressor.once("error", reject);
      compressor.write(Buffer.alloc(limit + 65536));
      compressor.flush(constants.Z_SYNC_FLUSH, resolve);
    });
    // Non-final compressed data exceeds the limit, then an invalid stored block
    // provokes a late zlib error. The old undici cleanup removed its listener.
    const payload = Buffer.concat([...chunks, Buffer.from([0, 0, 0, 0, 0, 255, 255])]);
    assert.ok(payload.length > 125 && payload.length < 65536);
    const header = Buffer.alloc(4);
    header[0] = 0xc2;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  } finally {
    compressor.destroy();
  }
}

async function localWebSocket(t, onConnection) {
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0, perMessageDeflate: { threshold: 0 },
  });
  const agent = new Agent({ webSocket: { maxPayloadSize: limit } });
  t.after(async () => {
    for (const peer of server.clients) peer.terminate();
    await agent.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on("connection", onConnection);
  await once(server, "listening");
  return new WebSocket(`ws://127.0.0.1:${server.address().port}`, { dispatcher: agent });
}

test("undici receives a valid compressed message from a local peer", { timeout: 5000 }, async (t) => {
  const client = await localWebSocket(t, (peer) => peer.send("fixture", { compress: true }));
  const [event] = await once(client, "message");
  assert.equal(event.data, "fixture");
  client.close();
});

test("undici rejects a malformed compressed peer without crashing", { timeout: 5000 }, async (t) => {
  const frame = await compressedOverLimitFrame();
  const client = await localWebSocket(t, (peer) => peer._socket.write(frame));
  let messages = 0;
  client.addEventListener("message", () => { messages += 1; });
  await once(client, "close");
  // Let already-queued zlib callbacks run before ending the regression case.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages, 0);
  assert.equal(client.readyState, WebSocket.CLOSED);
});

// Generated per run so no private key is committed. The client trusts this
// certificate explicitly, leaving its identity callback as the only refusal.
function throwawayCertificate() {
  const directory = mkdtempSync(join(tmpdir(), "facility-undici-tls-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert,
    ], { stdio: "pipe" });
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function tlsPeer(t, identityCheck) {
  const { key, cert } = throwawayCertificate();
  let served = 0;
  let agent;
  const server = createServer({ key, cert }, (_request, response) => {
    served += 1;
    response.end("fixture");
  });
  t.after(async () => {
    await agent?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // Vulnerable Agents JSON-cloned `tls`: `ca` survived, the callback did not.
  agent = new Agent({ tls: { ca: cert, checkServerIdentity: identityCheck } });
  const url = `https://127.0.0.1:${server.address().port}/`;
  return {
    served: () => served,
    async get() {
      const { statusCode, body } = await request(url, { dispatcher: agent });
      return { statusCode, text: await body.text() };
    },
  };
}

test("undici Agent runs a TLS identity callback that accepts the peer", { timeout: 5000 }, async (t) => {
  let checks = 0;
  const peer = await tlsPeer(t, (host, certificate) => {
    checks += 1;
    return checkServerIdentity(host, certificate);
  });
  assert.deepEqual(await peer.get(), { statusCode: 200, text: "fixture" });
  assert.equal(checks, 1);
});

test("undici Agent refuses a peer its TLS identity callback rejects", { timeout: 5000 }, async (t) => {
  const peer = await tlsPeer(t, () => new Error("fixture pin mismatch"));
  await assert.rejects(peer.get(), /fixture pin mismatch/);
  assert.equal(peer.served(), 0);
});
