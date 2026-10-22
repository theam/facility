import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPatchedVersion } from "../runner/verify-package-security.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRequire = createRequire(resolve(root, "apps/docs/package.json"));
const coreRequire = createRequire(docsRequire.resolve("@docusaurus/core/package.json"));
const serverRequire = createRequire(coreRequire.resolve("webpack-dev-server"));
const launcherRequire = createRequire(serverRequire.resolve("launch-editor"));
const webRequire = createRequire(resolve(root, "apps/web/package.json"));
const nextRequire = createRequire(webRequire.resolve("next/package.json"));
const apiRequire = createRequire(resolve(root, "services/api/package.json"));
const mcpRequire = createRequire(resolve(root, "packages/mcp/package.json"));
const { quote } = launcherRequire("shell-quote");
const sharp = nextRequire("sharp");
const { auth } = apiRequire("@modelcontextprotocol/sdk/client/auth.js");
const lock = apiRequire("yaml").parse(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
const floors = { next: "16.4.1", "shell-quote": "1.11.0", sharp: "0.35.5", "@modelcontextprotocol/sdk": "1.31.0" };

test("the lockfile and real consumers use reviewed security releases", () => {
  for (const [name, minimum] of Object.entries(floors)) {
    const versions = Object.keys(lock.packages).filter((key) => key.startsWith(`${name}@`)).map((key) => key.slice(name.length + 1));
    assert.ok(versions.length > 0, `${name} must be installed`);
    for (const version of versions) assertPatchedVersion(version, minimum, name);
  }
  assertPatchedVersion(webRequire("next/package.json").version, floors.next, "web Next.js");
  assertPatchedVersion(launcherRequire("shell-quote/package.json").version, floors["shell-quote"], "docs shell-quote");
  assertPatchedVersion(sharp.versions.sharp, floors.sharp, "Next.js sharp");
  assertPatchedVersion(sharp.versions.rsvg, "2.63.2", "bundled librsvg");
  for (const consumer of [apiRequire, mcpRequire]) {
    const entry = consumer.resolve("@modelcontextprotocol/sdk/client/auth.js");
    const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../../../package.json"), "utf8"));
    assertPatchedVersion(manifest.version, floors["@modelcontextprotocol/sdk"], "MCP consumer");
  }
});

for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
  test(`shell-quote rejects a line terminator after a comment (${JSON.stringify(terminator)})`, () => {
    assert.throws(() => quote(["printf", "ok", { comment: "fixture" }, `text${terminator}printf injected`]), TypeError);
  });
}

test("shell-quote preserves literal arguments when executed by a real shell", () => {
  const argument = "literal 'quoted' text; $(printf injected)";
  const command = quote(["printf", "%s", argument]);
  assert.equal(execFileSync("sh", ["-c", command], { encoding: "utf8", timeout: 2000 }), argument);
});

test("patched sharp renders a valid SVG with the reviewed native librsvg", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#123456"/></svg>');
  const png = await sharp(svg).png().toBuffer();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [2, 2, 4]);
  assert.deepEqual([...data.subarray(0, 4)], [0x12, 0x34, 0x56, 0xff]);
});

test("patched sharp rejects malformed SVG input", { timeout: 3000 }, async () => {
  await assert.rejects(sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><broken>')).png().toBuffer());
});

function provider(issuer) {
  let savedTokens;
  const value = {
    redirectUrl: new URL("http://127.0.0.1/callback"),
    clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
    clientInformation: () => ({ client_id: "fixture-client", client_secret: "synthetic-secret", issuer }),
    tokens: () => ({ access_token: "synthetic-old-access", refresh_token: "synthetic-refresh", token_type: "Bearer", issuer }),
    saveTokens: (tokens) => { savedTokens = tokens; },
    redirectToAuthorization: () => { throw Error("Unexpected interactive authorization"); },
    codeVerifier: () => "synthetic-verifier",
    saveCodeVerifier: () => undefined,
  };
  return { value, saved: () => savedTokens };
}

test("SDK rejects stored OAuth credentials bound to another authorization server before any token request", async () => {
  const fixture = provider("https://trusted.fixture.test");
  fixture.value.discoveryState = () => ({
    authorizationServerUrl: "https://untrusted.fixture.test",
    authorizationServerMetadata: {
      issuer: "https://trusted.fixture.test",
      authorization_endpoint: "https://untrusted.fixture.test/authorize",
      token_endpoint: "https://untrusted.fixture.test/token",
      response_types_supported: ["code"],
    },
    resourceMetadata: { resource: "https://mcp.fixture.test/mcp" },
  });
  let requests = 0;
  await assert.rejects(auth(fixture.value, {
    serverUrl: "https://mcp.fixture.test/mcp",
    fetchFn: async () => { requests++; throw Error("A bound credential must not leave the client"); },
  }), /bound to authorization server.*not presented/);
  assert.equal(requests, 0);
  assert.equal(fixture.saved(), undefined);
});

async function localServer(t, handler) {
  const server = createServer(handler);
  t.after(() => new Promise((resolveClose, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolveClose());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

for (const changedIssuer of [false, true]) {
  test(`SDK HTTP discovery ${changedIssuer ? "withholds credentials from a changed issuer" : "refreshes against the bound issuer"}`, { timeout: 5000 }, async (t) => {
    const tokenRequests = [];
    let selectedIssuer;
    const authorizationServer = await localServer(t, async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/.well-known/")) {
        response.end(JSON.stringify({ issuer: selectedIssuer, authorization_endpoint: `${selectedIssuer}/authorize`, token_endpoint: `${selectedIssuer}/token`, response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"] }));
      } else if (request.url === "/token") {
        let body = "";
        for await (const chunk of request) body += chunk;
        tokenRequests.push({ body, authorization: request.headers.authorization });
        response.end(JSON.stringify({ access_token: "synthetic-new-access", token_type: "Bearer", expires_in: 3600 }));
      } else { response.statusCode = 404; response.end("{}"); }
    });
    selectedIssuer = authorizationServer;
    const resource = await localServer(t, (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ resource: `${resource}/mcp`, authorization_servers: [selectedIssuer] }));
    });
    const fixture = provider(changedIssuer ? `${authorizationServer}/original-issuer` : selectedIssuer);
    const operation = auth(fixture.value, {
      serverUrl: `${resource}/mcp`,
      fetchFn: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(2000) }),
    });
    if (changedIssuer) {
      await assert.rejects(operation, /bound to authorization server.*not presented/);
      assert.equal(tokenRequests.length, 0);
      assert.equal(fixture.saved(), undefined);
    } else {
      assert.equal(await operation, "AUTHORIZED");
      assert.equal(tokenRequests.length, 1);
      assert.equal(new URLSearchParams(tokenRequests[0].body).get("refresh_token"), "synthetic-refresh");
      assert.equal(tokenRequests[0].authorization, `Basic ${Buffer.from("fixture-client:synthetic-secret").toString("base64")}`);
      assert.equal(fixture.saved().issuer, selectedIssuer);
      assert.equal(fixture.saved().access_token, "synthetic-new-access");
    }
  });
}
