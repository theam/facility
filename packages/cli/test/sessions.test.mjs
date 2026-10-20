import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { accessToken, instanceUrl, loadInstance, saveInstance, withCredentialLock } from "../src/credentials.mjs";
import { login, startLoopback, validateOAuthEndpoint } from "../src/login.mjs";
import { HerdrReporter } from "../src/herdr.mjs";
import { attach, remoteCommand, renderTurnEvent, resolveStory } from "../src/remote.mjs";

test("instance and OAuth endpoint validation reject insecure and cross-instance credentials", () => {
  assert.equal(instanceUrl("http://127.0.0.1:4400"), "http://127.0.0.1:4400");
  for (const value of ["http://example.test", "https://user:password@example.test", "https://example.test/path", "https://example.test/?token=secret", "file:///tmp/instance"])
    assert.throws(() => instanceUrl(value));
  assert.throws(() => validateOAuthEndpoint("https://other.example.test/oauth/token", "https://example.test"));
  assert.equal(validateOAuthEndpoint("https://example.test/oauth/token", "https://example.test"), "https://example.test/oauth/token");
});

test("credentials are private, multi-instance and rotated once across concurrent processes of work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-cli-credentials-"));
  const previous = process.env.FACILITY_CONFIG_DIR;
  process.env.FACILITY_CONFIG_DIR = directory;
  t.after(async () => { if (previous === undefined) delete process.env.FACILITY_CONFIG_DIR; else process.env.FACILITY_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  const persist = (url, value) => saveInstance(url, value, () => ({ status: 1 }));
  const first = "https://first.example.test";
  const second = "https://second.example.test";
  const value = { access_token: "expired-fixture-access", refresh_token: "fixture-refresh", expires_at: 0, token_endpoint: `${first}/oauth/token`, client_id: "fixture-client", resource: `${first}/mcp` };
  await withCredentialLock(() => persist(first, value));
  await withCredentialLock(() => persist(second, { ...value, expires_at: Date.now() + 100_000 }));
  assert.equal((await loadInstance()).url, second);
  assert.equal((await stat(join(directory, "credentials.json"))).mode & 0o777, 0o600);
  let refreshes = 0;
  const fetchImpl = async (_url, request) => {
    refreshes++;
    assert.equal(request.body.get("refresh_token"), "fixture-refresh");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, json: async () => ({ access_token: "renewed-fixture-access", refresh_token: "rotated-fixture-refresh", expires_in: 900 }) };
  };
  const results = await Promise.all([accessToken(first, fetchImpl, persist), accessToken(first, fetchImpl, persist)]);
  assert.equal(refreshes, 1);
  assert.ok(results.every((result) => result.access_token === "renewed-fixture-access"));
  const stored = await readFile(join(directory, "credentials.json"), "utf8");
  assert.ok(!stored.includes('"refresh_token":"fixture-refresh","expires_at":0'));
  await persist(first, value);
  await assert.rejects(accessToken(first, async () => ({ ok: false }), persist), /could not renew/);
  assert.equal((await loadInstance(first)).access_token, "expired-fixture-access");
});

test("loopback OAuth accepts one matching callback and denies CSRF, malformed and replayed callbacks", async () => {
  const callback = startLoopback("fixture-state", 5000);
  try {
    const redirect = await callback.ready;
    for (const query of ["state=wrong&code=value", "state=fixture-state&code=a&code=b", "code=value", "state=fixture-state"])
      assert.equal((await fetch(`${redirect}?${query}`)).status, 400);
    assert.equal((await fetch(`${redirect}?state=fixture-state&code=fixture-code`, { method: "POST" })).status, 400);
    assert.equal((await fetch(`${redirect}?state=fixture-state&code=fixture-code`)).status, 200);
    assert.equal(await callback.code, "fixture-code");
    assert.equal((await fetch(`${redirect}?state=fixture-state&code=replay`)).status, 400);
  } finally { callback.close(); }
});

test("loopback sign-in expires without issuing a credential", async () => {
  const callback = startLoopback("fixture-state", 30);
  try { await callback.ready; await assert.rejects(callback.code, /timed out/); }
  finally { callback.close(); }
});

test("loopback verifies the authorization-response issuer and handles denial without storing tokens", async () => {
  const callback = startLoopback("fixture-state", 5000, "https://issuer.example.test");
  try {
    const redirect = await callback.ready;
    for (const query of ["state=fixture-state&code=value", "state=fixture-state&code=value&iss=https://other.example.test"])
      assert.equal((await fetch(`${redirect}?${query}`)).status, 400);
    assert.equal((await fetch(`${redirect}?state=fixture-state&error=access_denied&iss=https://issuer.example.test`)).status, 200);
    await assert.rejects(callback.code, /declined/);
    assert.equal((await fetch(`${redirect}?state=fixture-state&code=replay&iss=https://issuer.example.test`)).status, 400);
  } finally { callback.close(); }
});

test("browser login completes discovery, native registration, PKCE callback and private persistence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-cli-login-"));
  const previous = process.env.FACILITY_CONFIG_DIR; process.env.FACILITY_CONFIG_DIR = directory;
  t.after(async () => { if (previous === undefined) delete process.env.FACILITY_CONFIG_DIR; else process.env.FACILITY_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  const origin = "https://instance.example.test";
  let redirect; let challenge; let exchanged = false;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: origin, registration_endpoint: `${origin}/oauth/register`, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` });
    if (url.endsWith("/oauth/register")) {
      const body = JSON.parse(options.body); assert.equal(body.application_type, "native");
      assert.equal(body.token_endpoint_auth_method, "none"); redirect = body.redirect_uris[0];
      assert.equal(new URL(redirect).hostname, "127.0.0.1"); return Response.json({ client_id: "fixture-client" });
    }
    assert.equal(url, `${origin}/oauth/token`); const body = options.body;
    assert.equal(body.get("code"), "fixture-authorization-code"); assert.equal(body.get("redirect_uri"), redirect);
    assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), challenge);
    exchanged = true; return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 900 });
  };
  await login(origin, { fetchImpl, launchBrowser: async (value) => {
    const url = new URL(value); challenge = url.searchParams.get("code_challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("prompt"), "consent");
    const callback = new URL(redirect); callback.search = new URLSearchParams({ state: url.searchParams.get("state"), code: "fixture-authorization-code", iss: origin });
    assert.equal((await fetch(callback)).status, 200);
  }, persist: (url, value) => saveInstance(url, value, () => ({ status: 1 })) });
  assert.ok(exchanged); assert.equal((await loadInstance(origin)).access_token, "fixture-access");
  assert.equal((await stat(join(directory, "credentials.json"))).mode & 0o777, 0o600);
});

test("Herdr reports increasing sequences, a resume command and release, and is inert outside Herdr", async () => {
  const calls = [];
  const launch = (_command, args) => {
    calls.push(args);
    const child = new EventEmitter(); child.kill = () => undefined;
    queueMicrotask(() => child.emit("exit", 0)); return child;
  };
  const disabled = new HerdrReporter({}, launch);
  disabled.attach("Story", "codex", "https://example.test/projects/demo/stories/story_fixture");
  disabled.state("working"); await disabled.release(); assert.equal(calls.length, 0);
  const reporter = new HerdrReporter({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/test/socket" }, launch);
  reporter.attach("Story", "codex", "https://example.test/projects/demo/stories/story_fixture");
  reporter.state("working"); reporter.state("blocked", "A question"); await reporter.release();
  const sequences = calls.map((args) => Number(args[args.indexOf("--seq") + 1]));
  assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]));
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--") + 1), ["facility", "attach", "https://example.test/projects/demo/stories/story_fixture"]);
  assert.ok(calls.some((args) => args.includes("blocked") && args.includes("A question")));
  assert.equal(calls.at(-1)[1], "release-agent");
});

test("read-only event rendering removes terminal escape injection", () => {
  assert.equal(renderTurnEvent({ type: "engine.item.completed", data: { item: { text: "\x1b]2;injected title\x07Hello" } } }), "Hello");
  assert.equal(renderTurnEvent({ type: "turn.failed", data: { error: "Failure" } }), "Turn failed: Failure");
});

test("remote story commands resolve scoped references, page holders and open the configured preview", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "facility-cli-remote-"));
  const previous = process.env.FACILITY_CONFIG_DIR; process.env.FACILITY_CONFIG_DIR = directory;
  const originalFetch = globalThis.fetch; const originalLog = console.log;
  t.after(async () => { globalThis.fetch = originalFetch; console.log = originalLog; if (previous === undefined) delete process.env.FACILITY_CONFIG_DIR; else process.env.FACILITY_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  const origin = "https://api.example.test";
  await saveInstance(origin, { access_token: "fixture-access", expires_at: Date.now() + 100_000, issuer: "https://web.example.test" }, () => ({ status: 1 }));
  const requests = []; const output = []; console.log = (line) => output.push(line);
  globalThis.fetch = async (value, options) => {
    const url = new URL(value); assert.equal(url.origin, origin); assert.equal(options.headers.authorization, "Bearer fixture-access"); assert.equal(options.redirect, "error"); requests.push({ url, options });
    if (url.pathname === "/v1/projects") return Response.json([{ id: "proj_fixture", slug: "demo" }]);
    if (url.pathname.endsWith("/backlog")) return Response.json({ items: [{ title: "Needs an answer", phase: "attention", attention: [{ id: "attention" }], issue: { number: 101 }, story: { id: "story_fixture", externalId: "issue:101" } }, { title: "Finished", phase: "done", attention: [], story: { id: "story_other", externalId: "manual:other" } }], total: 2 });
    if (url.pathname.endsWith("/session-holders")) return Response.json(url.searchParams.get("offset") === "0" ? { holders: { story_fixture: { kind: "person", name: "Ada" } }, next_offset: 1000 } : { holders: {}, next_offset: null });
    if (url.pathname.endsWith("/preview/web/open")) { assert.equal(options.method, "POST"); assert.ok(options.headers["idempotency-key"]); return Response.json({ url: "https://preview.example.test/one-time-launch" }); }
    if (url.pathname.endsWith("/workspace-stories/story_fixture")) return Response.json({ workspace: { environment: { ports: [{ service: "web" }] } } });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  assert.deepEqual(await resolveStory(origin, "demo#101"), { projectId: "proj_fixture", storyId: "story_fixture", title: "Needs an answer" });
  assert.deepEqual(await resolveStory(origin, "https://web.example.test/projects/proj_fixture/stories/story_fixture"), { projectId: "proj_fixture", storyId: "story_fixture" });
  await assert.rejects(resolveStory(origin, "https://other.example.test/projects/proj_fixture/stories/story_fixture"), /another instance/);
  await remoteCommand("stories", [], { instance: origin, "needs-you": true, json: true });
  const rows = JSON.parse(output.pop()); assert.equal(rows.length, 1); assert.equal(rows[0].session.holder.name, "Ada");
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/session-holders")).length, 2);
  await remoteCommand("preview", ["demo#101"], { instance: origin });
  assert.equal(output.pop(), "https://preview.example.test/one-time-launch");
  if (!process.stdin.isTTY) await assert.rejects(attach(origin, "story_fixture"), /requires a terminal/);
});

test("attach reconnects, confirms the displayed holder, bridges binary input and resize, and restores the terminal", { timeout: 15_000 }, async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "facility-cli-attach-"));
  const previous = process.env.FACILITY_CONFIG_DIR; process.env.FACILITY_CONFIG_DIR = directory;
  const originalFetch = globalThis.fetch; const originalLog = console.log;
  const stdin = new EventEmitter(); stdin.isTTY = true; stdin.isRaw = false;
  stdin.setRawMode = (raw) => { stdin.isRaw = raw; }; stdin.resume = () => undefined; stdin.pause = () => undefined;
  const stdout = new EventEmitter(); stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  let transcript = ""; stdout.write = (value) => { transcript += value.toString(); return true; };
  const reports = []; const reporter = { attach: (...args) => reports.push(["attach", ...args]), state: (...args) => reports.push(["state", ...args]), release: async () => reports.push(["release"]) };
  let operation;
  t.after(async () => {
    stdin.emit("data", Buffer.from([29])); for (const socket of server.clients) socket.close();
    await operation?.catch(() => undefined); await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch; console.log = originalLog;
    if (previous === undefined) delete process.env.FACILITY_CONFIG_DIR; else process.env.FACILITY_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await saveInstance(origin, { access_token: "fixture-access", expires_at: Date.now() + 100_000, issuer: origin }, () => ({ status: 1 }));
  globalThis.fetch = async () => Response.json({ story: { title: "Terminal fixture" }, turns: [{ engine: "codex" }] });
  console.log = () => undefined;
  let connections = 0; const identities = new Set(); const controls = []; const input = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer fixture-access");
    identities.add(new URL(request.url, origin).searchParams.get("client_id")); connections++;
    if (connections === 1) { socket.close(1001, "API restart"); return; }
    socket.send(JSON.stringify({ type: "holder", phase: "working", writer: false, holder: { kind: "facility", turnId: "turn_original", name: "builder", since: "2026-01-01T00:00:00Z" } }));
    socket.on("message", (data, binary) => {
      if (binary) { input.push(data.toString()); return; }
      const control = JSON.parse(data.toString()); controls.push(control);
      if (control.type === "takeover") {
        socket.send(JSON.stringify({ type: "holder", phase: "working", writer: true, holder: { kind: "person", turnId: "turn_native", name: "Ada", since: "2026-01-01T00:00:00Z", state: "working" } }));
        socket.send(Buffer.from("native-output"));
      }
      if (control.type === "leave") { socket.send(JSON.stringify({ type: "session_ended", reason: "left", message: "Session retained" })); socket.close(1000); }
    });
  });
  operation = attach(origin, `${origin}/projects/proj_fixture/stories/story_fixture`, { stdin, stdout, reporter });
  const wait = async (predicate) => { const until = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < until, "terminal transition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  await wait(() => connections === 2 && reports.some((report) => report[0] === "state"));
  stdin.emit("data", Buffer.from([3])); await wait(() => transcript.includes("[y/N]"));
  assert.equal(controls.filter((control) => control.type === "takeover").length, 0);
  stdin.emit("data", Buffer.from("y\r")); await wait(() => transcript.includes("native-output"));
  assert.deepEqual(controls.find((control) => control.type === "takeover"), { type: "takeover", turnId: "turn_original", confirm: true });
  stdin.emit("data", Buffer.from("a correction\r")); await wait(() => input.length === 1);
  assert.deepEqual(input, ["a correction\r"]);
  stdout.columns = 120; stdout.rows = 40; stdout.emit("resize");
  await wait(() => controls.some((control) => control.type === "resize" && control.cols === 120 && control.rows === 40));
  stdin.emit("data", Buffer.from([29])); assert.equal(await operation, 0);
  assert.equal(identities.size, 1); assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount("data"), 0); assert.equal(stdout.listenerCount("resize"), 0);
  assert.equal(reports.at(-1)[0], "release");
});
