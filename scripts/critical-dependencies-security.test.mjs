import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const docsRequire = createRequire(new URL("../apps/docs/package.json", import.meta.url));
const coreRequire = createRequire(docsRequire.resolve("@docusaurus/core/package.json"));
const serverRequire = createRequire(coreRequire.resolve("webpack-dev-server"));
const expressRequire = createRequire(serverRequire.resolve("express"));
const proxyaddr = expressRequire("proxy-addr");
const poolURL = pathToFileURL(coreRequire.resolve("tinypool")).href;

test("IPv4 addresses cannot match malformed or unmapped IPv6 trust subnets", () => {
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust("203.0.113.10"), false);
    assert.equal(trust("127.0.0.1"), false);
  }
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust("10.1.2.3"), true);
    assert.equal(trust("203.0.113.10"), false);
  }
});

test("real HTTP requests cannot spoof their IP through a malformed trust subnet", async (t) => {
  const trust = proxyaddr.compile("::ffff:10.0.0.0/8");
  const server = createServer((request, response) => response.end(proxyaddr(request, trust)));
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
    headers: { "x-forwarded-for": "198.51.100.20" },
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(await response.text(), "127.0.0.1");
});

for (const vector of ["none", "execArgv", "env", "filename"]) {
  test(`real worker pool ignores inherited ${vector} options`, () => {
    const directory = mkdtempSync(join(tmpdir(), "facility-worker-security-"));
    try {
      const worker = join(directory, "worker.mjs");
      const payload = join(directory, "payload.cjs");
      const replacement = join(directory, "replacement.mjs");
      writeFileSync(worker, "export default n => ({ value: n * 2, poisoned: process.env.FACILITY_TEST_POISONED === 'yes' });");
      writeFileSync(payload, "process.env.FACILITY_TEST_POISONED = 'yes';");
      writeFileSync(replacement, "export default () => ({ value: -1, poisoned: true });");
      // Prototype mutation is confined to a disposable child process. Fixtures
      // only set a synthetic marker, never access credentials or external hosts.
      const code = `
        import assert from 'node:assert/strict';
        import Tinypool from ${JSON.stringify(poolURL)};
        const vector = ${JSON.stringify(vector)};
        if (vector === 'execArgv') Object.prototype.execArgv = ['--require', ${JSON.stringify(payload)}];
        if (vector === 'env') Object.prototype.env = { NODE_OPTIONS: '--require ' + ${JSON.stringify(payload)} };
        const pool = new Tinypool({ filename: ${JSON.stringify(worker)}, minThreads: 1, maxThreads: 1 });
        try {
          if (vector === 'filename') Object.prototype.filename = ${JSON.stringify(replacement)};
          const result = await pool.run(21, { signal: new AbortController().signal });
          assert.deepEqual(result, { value: 42, poisoned: false });
        } finally {
          delete Object.prototype.execArgv;
          delete Object.prototype.env;
          delete Object.prototype.filename;
          await pool.destroy();
        }
      `;
      const probe = join(directory, "probe.mjs");
      writeFileSync(probe, code);
      const result = spawnSync(process.execPath, [probe], {
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
