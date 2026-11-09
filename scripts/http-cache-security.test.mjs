import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise the installed documentation HTTP client and its actual dependency
// resolution, not a separately installed test-only copy of the cache policy.
const store = fileURLToPath(new URL("../node_modules/.pnpm/", import.meta.url));
const clients = readdirSync(store).filter((name) => /^got@12\./.test(name));
assert.equal(clients.length, 1, "Review the documentation HTTP client dependency layout");
const clientRoot = join(store, clients[0], "node_modules/got");
const clientRequire = createRequire(join(clientRoot, "package.json"));
const cacheRequire = createRequire(clientRequire.resolve("cacheable-request"));
const CachePolicy = cacheRequire("http-cache-semantics");
const { default: got } = await import(pathToFileURL(join(clientRoot, "dist/source/index.js")));

test("the documentation cache consumer resolves the reviewed official release", () => {
  assert.equal(cacheRequire("http-cache-semantics/package.json").version, "4.3.0");
});

test("private and no-store responses are excluded from shared cache storage", () => {
  const request = { method: "GET", url: "http://fixture.test/", headers: { host: "fixture.test" } };
  for (const directive of ["private", "no-store"]) {
    const policy = new CachePolicy(request, {
      status: 200,
      headers: { "cache-control": `${directive}, max-age=60`, "set-cookie": "session=synthetic" },
    }, { shared: true });
    // The documented cache contract checks storable() before saving a response.
    // Revalidation alone is not a substitute for that storage gate.
    assert.equal(policy.storable(), false);
  }
});

test("the real HTTP client preserves private isolation and public caching", async (t) => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    const directive = request.url.slice(1);
    response.setHeader("Cache-Control", `${directive}, max-age=60`);
    response.setHeader("Set-Cookie", `session=synthetic-${hits}`);
    response.end(String(hits));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = got.extend({ cache: new Map(), retry: { limit: 0 }, timeout: { request: 2000 } });
  for (const directive of ["private", "no-store", "public"]) {
    const url = `http://127.0.0.1:${server.address().port}/${directive}`;
    const first = await client(url);
    const second = await client(url, { headers: { "cache-control": "max-stale=999999" } });
    if (directive === "public") {
      assert.equal(second.isFromCache, true);
      assert.equal(second.body, first.body);
    } else {
      assert.equal(second.isFromCache, false);
      assert.notEqual(second.body, first.body);
      assert.notDeepEqual(second.headers["set-cookie"], first.headers["set-cookie"]);
    }
  }
});
