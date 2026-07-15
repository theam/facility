import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/doctor.mjs";
import { runPlatformCommand } from "../src/platform.mjs";

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    },
  };
}

function config() {
  return {
    currentProfile: "default",
    profiles: { default: { url: "http://facility.test", key: "fak_test" } },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("login verifies /v1/me and writes config with 0600 permissions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facility-platform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const stdout = sink();
  const calls = [];

  const exit = await runPlatformCommand("login", ["--url", "http://facility.test", "--key", "fak_secret"], {
    configPath: path,
    stdout,
    fetch: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.authorization });
      return json({ org: { slug: "tam" }, principal: { type: "key" } });
    },
  });

  assert.equal(exit, 0);
  assert.deepEqual(calls, [{ url: "http://facility.test/v1/me", auth: "Bearer fak_secret" }]);
  assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  assert.ok(!stdout.text.includes("fak_secret"), "config secret must not be logged");
});

test("status --json emits parseable output", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("status", ["--json"], {
    config: config(),
    stdout,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo", name: "Demo", status: "active" }]);
      if (path === "/v1/inbox") return json([{ id: "prop_1", state: "open" }]);
      if (path === "/v1/issues") return json([]);
      if (path === "/v1/spend") return json([{ bucket: "today", cost_cents: 125 }]);
      if (path === "/v1/projects/proj_1/runs") return json([{ id: "run_1", status: "running" }]);
      return json({ error: { message: "missing fixture" } }, 404);
    },
  });

  assert.equal(exit, 0);
  const parsed = JSON.parse(stdout.text);
  assert.equal(parsed.liveSessions[0].id, "run_1");
  assert.deepEqual(parsed.liveRuns, parsed.liveSessions, "legacy JSON key remains compatible");
  assert.equal(parsed.spend[0].cost_cents, 125);
});

test("sessions and inbox render stub fetch fixtures", async () => {
  const runsOut = sink();
  const inboxOut = sink();
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo", name: "Demo", status: "active" }]);
    if (path === "/v1/projects/proj_1/runs") return json([{ id: "run_1", projectId: "proj_1", status: "running", mode: "builder" }]);
    if (path === "/v1/inbox") return json([{ id: "prop_1", state: "open", actionTypeId: "plan", projectId: "proj_1" }]);
    return json({ error: { message: "missing fixture" } }, 404);
  };

  assert.equal(await runPlatformCommand("sessions", ["list"], { config: config(), stdout: runsOut, fetch }), 0);
  assert.equal(await runPlatformCommand("inbox", [], { config: config(), stdout: inboxOut, fetch }), 0);
  assert.ok(runsOut.text.includes("run_1"));
  assert.ok(inboxOut.text.includes("prop_1"));
});

test("inbox surfaces watchtower issues alongside proposals", async () => {
  const out = sink();
  const fetch = async (url) => {
    if (new URL(url).pathname === "/v1/inbox") {
      return json({
        proposals: [{ id: "prop_1", state: "open", actionTypeId: "plan", projectId: "proj_1" }],
        issues: [{ id: "iss_1", severity: "error", kind: "run_failure", state: "open", title: "Boom" }],
      });
    }
    return json({ error: { message: "missing fixture" } }, 404);
  };
  assert.equal(await runPlatformCommand("inbox", [], { config: config(), stdout: out, fetch }), 0);
  assert.ok(out.text.includes("prop_1"), "shows proposals");
  assert.ok(out.text.includes("iss_1") && out.text.includes("run_failure"), "shows issues");
});

test("llm-requests list calls raw metering endpoint", async () => {
  const stdout = sink();
  const calls = [];
  const exit = await runPlatformCommand(
    "llm-requests",
    ["list", "--project", "proj_1", "--limit", "5", "--json"],
    {
      config: config(),
      stdout,
      fetch: async (url) => {
        calls.push(String(url));
        return json({
          items: [{ id: "evt_1", projectId: "proj_1", model: "gpt-5.5", status: "ok" }],
          nextCursor: null,
        });
      },
    },
  );

  assert.equal(exit, 0);
  assert.equal(new URL(calls[0]).pathname, "/v1/llm-requests");
  assert.equal(new URL(calls[0]).searchParams.get("projectId"), "proj_1");
  assert.equal(new URL(calls[0]).searchParams.get("limit"), "5");
  assert.equal(JSON.parse(stdout.text).items[0].id, "evt_1");
});

test("llm-requests get calls envelope endpoint", async () => {
  const stdout = sink();
  const calls = [];
  const exit = await runPlatformCommand("llm-requests", ["get", "evt_1", "--json"], {
    config: config(),
    stdout,
    fetch: async (url) => {
      calls.push(String(url));
      return json({ llmRequest: { id: "evt_1" }, envelope: { response: { id: "resp_1" } } });
    },
  });

  assert.equal(exit, 0);
  assert.equal(new URL(calls[0]).pathname, "/v1/llm-requests/evt_1/envelope");
  assert.equal(JSON.parse(stdout.text).envelope.response.id, "resp_1");
});


test("steer and decide send exact request bodies", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ method: init.method, path: new URL(url).pathname, body: init.body && JSON.parse(init.body) });
    return json({ ok: true });
  };

  assert.equal(
    await runPlatformCommand("sessions", ["steer", "run_1", "keep", "going"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0
  );
  assert.equal(
    await runPlatformCommand("inbox", ["decide", "prop_1", "approve", "--note", "looks good"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0
  );

  assert.deepEqual(calls, [
    { method: "POST", path: "/v1/runs/run_1/steer", body: { body: "keep going" } },
    { method: "POST", path: "/v1/proposals/prop_1/decide", body: { decision: "approve", note: "looks good" } },
  ]);
});

test("sessions trigger sends agent identity for API resolution", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body && JSON.parse(init.body);
    calls.push({ method: init.method, path, body });
    if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo", name: "Demo" }]);
    if (path === "/v1/projects/proj_1/runs") return json({ id: "run_1" });
    return json({ error: { message: "missing fixture" } }, 404);
  };

  assert.equal(
    await runPlatformCommand("sessions", ["trigger", "demo", "project-owner", "--input", '{"ok":true}'], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0
  );

  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/v1/projects/proj_1/runs",
    body: {
      mode: "manual",
      engine: "codex",
      agent: "project-owner",
      trigger: { source: "cli", agentName: "project-owner", input: { ok: true } },
    },
  });
});

test("non-2xx maps to exit 1 with API error message", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("projects", ["list"], {
    config: config(),
    stdout,
    fetch: async () => json({ error: { message: "no permission" } }, 403),
  });

  assert.equal(exit, 1);
  assert.equal(stdout.text, "no permission\n");
});

test("401 maps to auth exit 2", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("status", [], {
    config: config(),
    stdout,
    fetch: async () => json({ error: { message: "bad key" } }, 401),
  });

  assert.equal(exit, 2);
  assert.equal(stdout.text, "bad key\n");
});

test("doctor calls platform readiness endpoint and renders remediation", async () => {
  const stdout = sink();
  const calls = [];
  const exit = await doctor(
    { url: "http://facility.test/", key: "fak_secret" },
    "0.3.0",
    {
      stdout,
      fetch: async (url, init) => {
        calls.push({ url: String(url), auth: init.headers.authorization });
        return json({
          ok: false,
          generatedAt: "2026-07-05T00:00:00.000Z",
          checks: [
            {
              id: "database",
              label: "Database connectivity and migrations",
              status: "pass",
              ok: true,
              message: "Database is reachable; 6 migration(s) applied.",
            },
            {
              id: "object_storage",
              label: "Object storage envelope round trip",
              status: "fail",
              ok: false,
              message: "Object storage not configured: S3_BUCKET is empty.",
              remediation: "Set S3_BUCKET.",
            },
          ],
        });
      },
    },
  );

  assert.equal(exit, 1);
  assert.deepEqual(calls, [
    { url: "http://facility.test/v1/admin/doctor", auth: "Bearer fak_secret" },
  ]);
  assert.ok(stdout.text.includes("[PASS] Database connectivity and migrations"));
  assert.ok(stdout.text.includes("Fix: Set S3_BUCKET."));
  assert.ok(stdout.text.includes("Not ready for production traffic."));
  assert.ok(!stdout.text.includes("fak_secret"), "doctor must not log API keys");
});

test("keys issue surfaces the one-time secret in human output", async () => {
  const stdout = sink();
  const calls = [];
  const exit = await runPlatformCommand("keys", ["issue", "ci-key", "--role", "role_admin"], {
    config: config(),
    stdout,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return json({ id: "key_1", name: "ci-key", last4: "ab12", secret: "fak_live_supersecret" });
    },
  });

  assert.equal(exit, 0);
  assert.equal(calls[0].method, "POST");
  assert.ok(stdout.text.includes("fak_live_supersecret"), "the secret must be printed once");
  assert.ok(stdout.text.includes("shown once"), "must warn the secret is not retrievable later");
});

test("keys issue --json includes the secret for scripting", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("keys", ["issue", "ci-key", "--role", "role_admin", "--json"], {
    config: config(),
    stdout,
    fetch: async () => json({ id: "key_1", name: "ci-key", last4: "ab12", secret: "fak_live_supersecret" }),
  });

  assert.equal(exit, 0);
  assert.equal(JSON.parse(stdout.text).secret, "fak_live_supersecret");
});
