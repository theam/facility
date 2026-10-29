import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const docsRequire = createRequire(new URL("../apps/docs/package.json", import.meta.url));
const coreRequire = createRequire(docsRequire.resolve("@docusaurus/core/package.json"));
const serverRequire = createRequire(coreRequire.resolve("webpack-dev-server"));
const expressRequire = createRequire(serverRequire.resolve("express"));
const express = serverRequire("express");
const qs = expressRequire("qs");
const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const require = createRequire(import.meta.url);
const versions = [...new Set([...lock.matchAll(/^  qs@([\d.]+):/gm)].map((match) => match[1]))];
assert.ok(versions.length, "Exercise every qs version selected by the lockfile");

for (const version of versions) {
  const parser = require(resolve(root, "node_modules/.pnpm", `qs@${version}/node_modules/qs`));
  for (const encodeValuesOnly of [false, true]) {
    test(`qs ${version} safely serializes hostile comma elements (encodeValuesOnly=${encodeValuesOnly})`, () => {
      const options = { arrayFormat: "comma", encodeValuesOnly };
      const inputs = [
        parser.parse("a[0][toString]=x", { allowPrototypes: true }),
        JSON.parse('{"a":[{"toString":"x"}]}'),
        parser.parse("a[][b]=c", { plainObjects: true }),
        JSON.parse('{"a":[[{"toString":"x"}]]}'),
      ];
      for (const input of inputs) {
        assert.equal(parser.stringify(input, options), "a=%5Bobject%20Object%5D");
      }
      assert.equal(parser.stringify({ a: ["x", "y"] }, options),
        encodeValuesOnly ? "a=x,y" : "a=x%2Cy");
      assert.equal(parser.stringify({ a: [{ toString: () => "valid" }] }, options), "a=valid");
    });
  }
}

test("the actual docs Express dependency safely reserializes hostile HTTP input and serves the next request", { timeout: 5000 }, async (t) => {
  const app = express();
  app.set("query parser", (value) => qs.parse(value, { allowPrototypes: true }));
  app.use(express.json());
  app.all("/serialize", (request, response) => {
    const input = request.method === "POST" ? request.body : request.query;
    response.type("text/plain").send(qs.stringify(input, {
      arrayFormat: "comma", encodeValuesOnly: request.headers["x-values-only"] === "true",
    }));
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/serialize`;
  for (const valuesOnly of [false, true]) {
    const headers = { "x-values-only": String(valuesOnly), "content-type": "application/json" };
    for (const [path, options] of [
      ["?a[0][toString]=x", { headers }],
      ["", { method: "POST", headers, body: '{"a":[{"toString":"x"}]}' }],
    ]) {
      const response = await fetch(url + path, { ...options, signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "a=%5Bobject%20Object%5D");
    }
  }
  const healthy = await fetch(`${url}?a[0]=x&a[1]=y`, { signal: AbortSignal.timeout(2000) });
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), "a=x%2Cy");
});
