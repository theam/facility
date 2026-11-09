import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const vitestRequire = createRequire(webRequire.resolve("vitest/package.json"));
const { createManualModuleSource, interceptorPlugin } = await import(
  pathToFileURL(vitestRequire.resolve("@vitest/mocker/node")).href
);
const { createServer } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const payload = 'x"); globalThis.FACILITY_MOCK_INJECTED = true; void("';

test("installed mocker keeps hostile URLs and export names as module data", () => {
  const exportName = 'x"]; globalThis.FACILITY_MOCK_INJECTED = true; void["';
  const generated = createManualModuleSource(payload, ["safe", exportName], JSON.stringify("facilityMocker"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    let observed;
    globalThis.facilityMocker = { getFactoryModule: async (url) => {
      observed = url; return {safe: 'expected', [${JSON.stringify(exportName)}]: 'also data'};
    }};
    ${generated}
    assert.equal(globalThis.FACILITY_MOCK_INJECTED, undefined);
    assert.equal(observed, ${JSON.stringify(payload)});
  `], { encoding: "utf8", timeout: 1_500 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});

test("real Vite mock registration accepts an allowed redirect and denies backslash traversal", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-mocker-security-"));
  const root = join(directory, "root");
  let server, socket;
  t.after(async () => {
    try { socket?.close(); } finally {
      try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  await mkdir(root);
  await writeFile(join(root, "allowed.js"), 'export const safe = "allowed redirect";');
  await writeFile(join(directory, "outside.txt"), "OUTSIDE_ROOT_CANARY");
  // Also exercise registration denial on POSIX, where a backslash is a literal filename.
  await writeFile(join(root, "..\\outside.txt"), "OUTSIDE_ROOT_CANARY");
  const probes = new Set(["/probe-allowed", "/probe-denied", "/probe-manual"]);
  server = await createServer({
    root, configFile: false, cacheDir: join(directory, "cache"), logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
    plugins: [
      { name: "fixture-probes", enforce: "pre", resolveId(id) { return probes.has(id) ? id : undefined; }, load(id) { return probes.has(id) ? 'export const safe = "original module";' : undefined; } },
      interceptorPlugin(),
    ],
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, "vite-hmr");
  let ack;
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(String(event.data));
    if (packet.type !== "custom") return;
    if (packet.event === "vitest:interceptor:register:result") { ack?.(); ack = undefined; }
    if (packet.event === "vitest:interceptor:resolve") socket.send(JSON.stringify({ type: "custom", event: "vitest:interceptor:resolved", data: { url: packet.data, keys: ["safe"] } }));
  });
  await once(socket, "open");
  const register = (data) => new Promise((resolve) => {
    ack = resolve;
    socket.send(JSON.stringify({ type: "custom", event: "vitest:interceptor:register", data }));
  });
  await register({ type: "redirect", raw: "", id: "/probe-allowed", url: "/probe-allowed", redirect: "mock://fixture/allowed.js" });
  const allowed = await fetch(`${origin}/probe-allowed`);
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /allowed redirect/);
  await register({ type: "redirect", raw: "", id: "/probe-denied", url: "/probe-denied", redirect: "mock://fixture/..\\outside.txt" });
  const denied = await fetch(`${origin}/probe-denied`);
  assert.equal(denied.status, 200);
  const deniedSource = await denied.text();
  assert.match(deniedSource, /original module/);
  assert.doesNotMatch(deniedSource, /OUTSIDE_ROOT_CANARY/);
  await register({ type: "manual", raw: "", id: "/probe-manual", url: payload });
  const manual = await fetch(`${origin}/probe-manual`);
  assert.equal(manual.status, 200);
  assert.ok((await manual.text()).includes(`getFactoryModule(${JSON.stringify(payload)})`));
});
