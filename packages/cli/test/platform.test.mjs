import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
    profiles: { default: { url: "http://localhost", key: "fak_test" } },
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

  const exit = await runPlatformCommand("login", ["--url", "http://facility.test", "--key", "fak_secret", "--allow-insecure"], {
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

test("login refuses to transmit credentials over remote plaintext HTTP", async () => {
  let called = false;
  const stdout = sink();
  const stderr = sink();
  const exit = await runPlatformCommand(
    "login",
    ["--url", "http://facility.test", "--key", "fak_secret", "--json"],
    {
      fetch: async () => {
        called = true;
        return json({});
      },
      stdout,
      stderr,
      config: { profiles: {} },
    },
  );
  assert.equal(exit, 1);
  assert.equal(called, false);
  assert.equal(JSON.parse(stdout.text).error.code, "insecure_api_url");
  assert.equal(stderr.text, "");
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
      if (path === "/v1/runs") return json([{ id: "run_1", status: "running" }]);
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
    if (path === "/v1/runs") return json([{ id: "run_1", projectId: "proj_1", status: "running", mode: "builder" }]);
    if (path === "/v1/inbox") return json([{ id: "prop_1", state: "open", actionTypeId: "plan", projectId: "proj_1" }]);
    return json({ error: { message: "missing fixture" } }, 404);
  };

  assert.equal(await runPlatformCommand("sessions", ["list"], { config: config(), stdout: runsOut, fetch }), 0);
  assert.equal(await runPlatformCommand("inbox", [], { config: config(), stdout: inboxOut, fetch }), 0);
  assert.ok(runsOut.text.includes("run_1"));
  assert.ok(inboxOut.text.includes("prop_1"));
});

test("runs watch reconnects from the last event and emits JSON lines until result", async () => {
  const stdout = sink();
  const calls = [];
  const streams = [
    'id: 1\nevent: run_event\ndata: {"seq":1,"type":"assistant","data":{"text":"working"}}\n\n',
    'id: 2\nevent: run_event\ndata: {"seq":2,"type":"result","data":{"status":"succeeded"}}\n\n',
  ];
  const fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      lastEventId: new Headers(init.headers).get("last-event-id"),
    });
    return new Response(streams.shift(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const exit = await runPlatformCommand("runs", ["watch", "run_1", "--json"], {
    config: config(),
    stdout,
    fetch,
    sleep: async () => undefined,
  });

  assert.equal(exit, 0);
  assert.deepEqual(
    stdout.text.trim().split("\n").map((line) => JSON.parse(line)),
    [
      { seq: 1, type: "assistant", data: { text: "working" } },
      { seq: 2, type: "result", data: { status: "succeeded" } },
    ],
  );
  assert.deepEqual(calls, [
    { url: "http://localhost/v1/runs/run_1/stream", lastEventId: null },
    { url: "http://localhost/v1/runs/run_1/stream?afterSeq=1", lastEventId: "1" },
  ]);
});

test("runs watch returns on a terminal event even while the server keeps the stream open", async () => {
  const stdout = sink();
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'id: 9\nevent: run_event\ndata: {"seq":9,"type":"result","data":{"status":"succeeded"}}\n\n',
        ),
      );
    },
    cancel() {
      canceled = true;
    },
  });
  const exit = await runPlatformCommand("runs", ["watch", "run_1", "--json"], {
    config: config(),
    stdout,
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(exit, 0);
  assert.equal(JSON.parse(stdout.text).data.status, "succeeded");
  assert.equal(canceled, true);
});

test("runs watch returns a failing exit code for an unsuccessful terminal event", async () => {
  const stdout = sink();
  const stream =
    'id: 3\nevent: run_event\ndata: {"seq":3,"type":"result","data":{"status":"failed","error":"boom"}}\n\n';
  const exit = await runPlatformCommand("runs", ["watch", "run_1", "--json"], {
    config: config(),
    stdout,
    fetch: async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(stdout.text).data.status, "failed");
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

test("runs cancel calls the idempotent cancellation endpoint", async () => {
  const calls = [];
  const stdout = sink();
  const exit = await runPlatformCommand("runs", ["cancel", "run_1", "--json"], {
    config: config(),
    stdout,
    fetch: async (url, init = {}) => {
      calls.push({ method: init.method, path: new URL(url).pathname });
      return json({ id: "run_1", status: "canceled" });
    },
  });

  assert.equal(exit, 0);
  assert.deepEqual(calls, [{ method: "POST", path: "/v1/runs/run_1/cancel" }]);
  assert.equal(JSON.parse(stdout.text).status, "canceled");
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
      mode: "project-owner",
      agent: "project-owner",
      trigger: { source: "cli", agentName: "project-owner", input: { ok: true } },
    },
  });
});

test("run get, events, and trigger expose complete scripting contracts", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({
      method: init.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
    });
    if (parsed.pathname === "/v1/projects") return json([{ id: "proj_1", slug: "demo" }]);
    return json(parsed.pathname.endsWith("/events") ? [] : { id: "run_1", status: "running" });
  };

  assert.equal(
    await runPlatformCommand("runs", ["get", "run_1", "--json"], {
      config: config(), stdout: sink(), fetch,
    }),
    0,
  );
  assert.equal(
    await runPlatformCommand("runs", ["events", "run_1", "--after-seq", "5", "--tail", "20", "--json"], {
      config: config(), stdout: sink(), fetch,
    }),
    0,
  );
  assert.equal(
    await runPlatformCommand("runs", ["trigger", "demo", "builder", "--idempotency-key", "deploy-42", "--json"], {
      config: config(), stdout: sink(), fetch,
    }),
    0,
  );

  assert.deepEqual(calls[0], { method: "GET", path: "/v1/runs/run_1", query: {}, idempotencyKey: null });
  assert.deepEqual(calls[1], {
    method: "GET",
    path: "/v1/runs/run_1/events",
    query: { afterSeq: "5", tail: "20" },
    idempotencyKey: null,
  });
  assert.equal(calls.at(-1).idempotencyKey, "deploy-42");
});

test("kickstart maps typed answer flags without forwarding CLI control flags", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo" }]);
    if (path === "/v1/projects/proj_1/repos") {
      return json([{ id: "repo_1", owner: "theam", name: "demo" }]);
    }
    if (path.endsWith("/kickstart/preview")) return json({ files: [] });
    if (path.endsWith("/kickstart")) {
      calls.push(JSON.parse(init.body));
      return json({ pr: { url: "https://github.test/pull/1" } });
    }
    return json({ error: { message: "missing fixture" } }, 404);
  };
  const exit = await runPlatformCommand(
    "kickstart",
    [
      "demo",
      "--repo",
      "theam/demo",
      "--checks",
      "pnpm test,pnpm lint",
      "--modules",
      '["analytics","database"]',
      "--execution-lane",
      '{"security":"platform"}',
      "--yes",
      "--json",
    ],
    { config: config(), stdout: sink(), fetch },
  );

  assert.equal(exit, 0);
  assert.deepEqual(calls, [
    {
      repoId: "repo_1",
      answers: {
        checkCmds: ["pnpm test", "pnpm lint"],
        modules: ["analytics", "database"],
        execution_lane: { security: "platform" },
      },
      mode: "pr",
    },
  ]);
});

test("non-2xx maps to exit 1 with API error message", async () => {
  const stdout = sink();
  const stderr = sink();
  const exit = await runPlatformCommand("projects", ["list"], {
    config: config(),
    stdout,
    stderr,
    fetch: async () => json({ error: { message: "no permission" } }, 403),
  });

  assert.equal(exit, 1);
  assert.equal(stdout.text, "");
  assert.equal(stderr.text, "no permission\n");
});

test("401 maps to auth exit 2", async () => {
  const stdout = sink();
  const stderr = sink();
  const exit = await runPlatformCommand("status", [], {
    config: config(),
    stdout,
    stderr,
    fetch: async () => json({ error: { message: "bad key" } }, 401),
  });

  assert.equal(exit, 2);
  assert.equal(stdout.text, "");
  assert.equal(stderr.text, "bad key\n");
});

test("--json failures are structured on stdout and keep stderr clean", async () => {
  const stdout = sink();
  const stderr = sink();
  const exit = await runPlatformCommand("projects", ["list", "--json"], {
    config: config(),
    stdout,
    stderr,
    fetch: async () =>
      json(
        { error: { code: "forbidden", message: "no permission", details: { needed: "projects:read" } } },
        403,
      ),
  });

  assert.equal(exit, 1);
  assert.equal(stderr.text, "");
  assert.deepEqual(JSON.parse(stdout.text), {
    error: {
      code: "forbidden",
      message: "no permission",
      status: 403,
      details: { needed: "projects:read" },
    },
  });
});

test("human failures include actionable structured details", async () => {
  const stderr = sink();
  const exit = await runPlatformCommand("projects", ["list"], {
    config: config(),
    stdout: sink(),
    stderr,
    fetch: async () =>
      json(
        {
          error: {
            code: "validation_failed",
            message: "Request failed validation",
            details: { errors: [{ code: "invalid_slug", message: "Use lowercase letters." }] },
          },
        },
        400,
      ),
  });
  assert.equal(exit, 1);
  assert.match(stderr.text, /invalid_slug: Use lowercase letters\./);
});

test("value and numeric flags fail closed when their values are missing", async () => {
  for (const args of [
    ["trigger", "demo", "builder", "--idempotency-key", "--json"],
    ["events", "run_1", "--tail", "--json"],
  ]) {
    const stdout = sink();
    const exit = await runPlatformCommand("runs", args, {
      config: config(),
      stdout,
      fetch: async () => json([{ id: "proj_1", slug: "demo" }]),
    });
    assert.equal(exit, 1);
    assert.equal(JSON.parse(stdout.text).error.code, "invalid_flag");
  }
});

test("JSON login never prompts and reports missing credentials structurally", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("login", ["--json"], {
    config: { profiles: {} },
    stdin: Readable.from([]),
    stdout,
  });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(stdout.text).error.code, "credentials_required");
  assert.ok(!stdout.text.includes("API URL:"));
});

test("piped login consumes URL and key from one stdin stream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facility-platform-pipe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const stdout = sink();
  const exit = await runPlatformCommand("login", [], {
    config: { profiles: {} },
    configPath: path,
    stdin: Readable.from(["https://facility.test\nfak_pipe_secret\n"]),
    stdout,
    fetch: async () => json({ org: { slug: "tam" }, principal: { type: "key" } }),
  });

  assert.equal(exit, 0);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.profiles.default.url, "https://facility.test");
  assert.equal(saved.profiles.default.key, "fak_pipe_secret");
  assert.ok(!stdout.text.includes("fak_pipe_secret"));
});

test("required values fail closed before any write across command families", async () => {
  const cases = [
    ["projects", ["create", "--name", "--slug", "review-hazard", "--json"]],
    ["members", ["add", "--email", "--role", "role_owner", "--json"]],
    ["providers", ["create", "--provider", "--name", "primary", "--secret", "sk", "--json"]],
    ["tasks", ["create", "demo", "--title", "--body", "body", "--json"]],
    ["integrations", ["create", "--kind", "--name", "deploys", "--json"]],
  ];
  for (const [command, args] of cases) {
    let called = false;
    const stdout = sink();
    const exit = await runPlatformCommand(command, args, {
      config: config(),
      stdout,
      fetch: async () => {
        called = true;
        return json({});
      },
    });
    assert.equal(exit, 1, `${command} exits with a flag error`);
    assert.equal(JSON.parse(stdout.text).error.code, "invalid_flag");
    assert.equal(called, false, `${command} must fail before calling the API`);
  }
});

test("destructive API-key revocation requires explicit confirmation", async () => {
  let called = false;
  const stdout = sink();
  const rejected = await runPlatformCommand("keys", ["revoke", "key_1", "--json"], {
    config: config(),
    stdout,
    fetch: async () => {
      called = true;
      return json({});
    },
  });
  assert.equal(rejected, 1);
  assert.equal(JSON.parse(stdout.text).error.code, "confirmation_required");
  assert.equal(called, false);

  const accepted = await runPlatformCommand("keys", ["revoke", "key_1", "--yes", "--json"], {
    config: config(),
    stdout: sink(),
    fetch: async () => {
      called = true;
      return json({ id: "key_1", revokedAt: "2026-07-16T00:00:00.000Z" });
    },
  });
  assert.equal(accepted, 0);
  assert.equal(called, true);
});

test("verification commands return non-zero when their report is not ok", async () => {
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo" }]);
    if (path.endsWith("/kb/validate")) {
      return json({ ok: false, errors: [{ code: "kb_space_missing", message: "Missing" }], warnings: [] });
    }
    if (path === "/v1/audit/verify") return json({ ok: false, firstBreakSeq: 7 });
    return json({ error: { message: "missing fixture" } }, 404);
  };
  assert.equal(
    await runPlatformCommand("kb", ["validate", "demo", "--json"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    1,
  );
  assert.equal(
    await runPlatformCommand("audit", ["verify", "--json"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    1,
  );
});

test("analytics is explicit and known-but-irrelevant flags are rejected", async () => {
  const calls = [];
  assert.equal(
    await runPlatformCommand("analytics", ["timeseries", "--group-by", "day", "--json"], {
      config: config(),
      stdout: sink(),
      fetch: async (url) => {
        calls.push(String(url));
        return json([]);
      },
    }),
    0,
  );
  assert.equal(new URL(calls[0]).pathname, "/v1/analytics");
  assert.equal(new URL(calls[0]).searchParams.get("groupBy"), "day");

  const analyticsOut = sink();
  assert.equal(
    await runPlatformCommand("analytics", ["--group-by", "day", "--json"], {
      config: config(),
      stdout: analyticsOut,
      fetch: async () => json({}),
    }),
    1,
  );
  assert.equal(JSON.parse(analyticsOut.text).error.code, "invalid_flag");

  const projectsOut = sink();
  assert.equal(
    await runPlatformCommand("projects", ["list", "--status", "archived", "--json"], {
      config: config(),
      stdout: projectsOut,
      fetch: async () => json([]),
    }),
    1,
  );
  assert.equal(JSON.parse(projectsOut.text).error.code, "unknown_flag");
});

test("human tables fit narrow terminals and JSON booleans cannot be assigned", async () => {
  const stdout = { ...sink(), columns: 50 };
  const exit = await runPlatformCommand("roles", ["list"], {
    config: config(),
    stdout,
    fetch: async () =>
      json([
        {
          id: "role_very_long_identifier",
          name: "production-operator",
          permissions: ["projects:read", "projects:write", "runs:read", "runs:write"],
          description: "A deliberately long description for terminal-width acceptance.",
        },
      ]),
  });
  assert.equal(exit, 0);
  assert.ok(Math.max(...stdout.text.split("\n").map((line) => line.length)) <= 50);

  const jsonOut = sink();
  assert.equal(
    await runPlatformCommand("status", ["--json=false"], {
      config: config(),
      stdout: jsonOut,
    }),
    1,
  );
  assert.equal(JSON.parse(jsonOut.text).error.code, "invalid_flag");
});

test("platform doctor applies the login transport-safety rule", async () => {
  let called = false;
  const stdout = sink();
  const exit = await doctor(
    { url: "http://facility.test", key: "fak_secret", json: true },
    "0.3.0",
    {
      stdout,
      fetch: async () => {
        called = true;
        return json({ ok: true, checks: [] });
      },
    },
  );
  assert.equal(exit, 1);
  assert.equal(JSON.parse(stdout.text).error.code, "insecure_api_url");
  assert.equal(called, false);
});

test("command help is available without a configured profile", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("runs", ["--help"], {
    config: { currentProfile: "default", profiles: {} },
    stdout,
  });

  assert.equal(exit, 0);
  assert.match(
    stdout.text,
    /facility runs list\|get\|events\|transcript\|watch\|trigger\|steer\|interrupt\|resume\|cancel/,
  );
});

test("unknown subcommands fail with usage before authentication", async () => {
  for (const [command, args] of [
    ["projects", ["lst", "--json"]],
    ["roles", ["lst", "--json"]],
  ]) {
    const stdout = sink();
    let requested = false;
    const exit = await runPlatformCommand(command, args, {
      config: { currentProfile: "default", profiles: {} },
      stdout,
      fetch: async () => {
        requested = true;
        return json({});
      },
    });
    assert.equal(exit, 1);
    assert.equal(JSON.parse(stdout.text).error.code, "usage");
    assert.equal(requested, false);
  }
});

test("profiles can be listed and switched without authenticating", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "facility-platform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const configured = {
    currentProfile: "default",
    profiles: {
      default: { url: "https://one.test", key: "fak_one" },
      staging: { url: "https://two.test", key: "fak_two" },
    },
  };
  const stdout = sink();

  assert.equal(
    await runPlatformCommand("profiles", ["list", "--json"], {
      config: configured,
      configPath: path,
      stdout,
    }),
    0,
  );
  assert.equal(JSON.parse(stdout.text).profiles.length, 2);
  assert.ok(!stdout.text.includes("fak_one") && !stdout.text.includes("fak_two"));
  assert.equal(
    await runPlatformCommand("profiles", ["use", "staging"], {
      config: configured,
      configPath: path,
      stdout: sink(),
    }),
    0,
  );
  assert.equal(JSON.parse(readFileSync(path, "utf8")).currentProfile, "staging");
  assert.equal((statSync(path).mode & 0o777).toString(8), "600");

  const human = sink();
  assert.equal(
    await runPlatformCommand("profiles", ["list"], {
      config: configured,
      configPath: path,
      stdout: human,
    }),
    0,
  );
  assert.doesNotMatch(human.text, /\n\s+—\s+profile/);
});

test("doctor calls platform readiness endpoint and renders remediation", async () => {
  const stdout = sink();
  const calls = [];
  const exit = await doctor(
    { url: "http://facility.test/", key: "fak_secret", "allow-insecure": true },
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
  assert.ok(stdout.text.includes("✓ Database connectivity and migrations"));
  assert.ok(stdout.text.includes("Fix: Set S3_BUCKET."));
  assert.ok(stdout.text.includes("Not ready for production traffic."));
  assert.ok(!stdout.text.includes("fak_secret"), "doctor must not log API keys");
});

test("platform doctor selects the saved profile and emits one JSON value", async () => {
  const stdout = sink();
  const exit = await doctor(
    { platform: true, json: true, "allow-insecure": true },
    "0.3.0",
    {
      stdout,
      config: config(),
      fetch: async () => json({ ok: true, generatedAt: "2026-07-05T00:00:00.000Z", checks: [] }),
    },
  );

  assert.equal(exit, 0);
  assert.deepEqual(JSON.parse(stdout.text), {
    mode: "platform",
    target: { profile: "default", url: "http://localhost" },
    ok: true,
    generatedAt: "2026-07-05T00:00:00.000Z",
    checks: [],
  });
});

test("platform doctor fails structurally when no saved target exists", async () => {
  const stdout = sink();
  const exit = await doctor(
    { platform: true, json: true },
    "0.3.0",
    { stdout, config: { currentProfile: "default", profiles: {} } },
  );

  assert.equal(exit, 2);
  assert.deepEqual(JSON.parse(stdout.text), {
    mode: "platform",
    target: null,
    ok: false,
    checks: [],
    error: {
      code: "doctor_target_required",
      message: "facility doctor needs both --url and --key, or a saved login profile.",
    },
  });
});

test("platform doctor rejects a successful non-JSON proxy response", async () => {
  const stdout = sink();
  const exit = await doctor(
    { url: "http://facility.test", key: "fak_secret", json: true, "allow-insecure": true },
    "0.3.0",
    {
      stdout,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      }),
    },
  );

  assert.equal(exit, 1);
  assert.deepEqual(JSON.parse(stdout.text), {
    mode: "platform",
    target: { profile: "adhoc", url: "http://facility.test" },
    ok: false,
    checks: [],
    error: {
      code: "doctor_failed",
      message: "Facility API returned an invalid JSON response",
    },
  });
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

test("administration commands expose roles without requiring the web application", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("roles", ["list", "--json"], {
    config: config(),
    stdout,
    fetch: async (url, init = {}) => {
      assert.equal(init.method, "GET");
      assert.equal(new URL(url).pathname, "/v1/roles");
      return json([{ id: "role_owner", name: "owner", permissions: ["*"] }]);
    },
  });

  assert.equal(exit, 0);
  assert.equal(JSON.parse(stdout.text)[0].id, "role_owner");
});

test("repo and agent setup commands send typed API contracts", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    if (path === "/v1/projects") return json([{ id: "proj_1", slug: "demo" }]);
    return json(path.endsWith("/agents") ? { id: "agent_1" } : { id: "repo_1" });
  };

  assert.equal(
    await runPlatformCommand(
      "repos",
      ["connect", "demo", "--repo", "theam/demo", "--branch", "trunk", "--private", "false"],
      { config: config(), stdout: sink(), fetch },
    ),
    0,
  );
  assert.equal(
    await runPlatformCommand(
      "agents",
      [
        "create",
        "demo",
        "--name",
        "builder",
        "--engine",
        "claude",
        "--contract",
        "item_contract",
        "--triggers",
        '[{"type":"schedule","config":{"cron":"0 9 * * 1-5","timezone":"UTC"}}]',
      ],
      { config: config(), stdout: sink(), fetch },
    ),
    0,
  );

  assert.deepEqual(calls.filter((call) => call.method === "POST"), [
    {
      method: "POST",
      path: "/v1/projects/proj_1/repos",
      body: {
        owner: "theam",
        name: "demo",
        mode: "connect",
        defaultBranch: "trunk",
        private: false,
        autoInit: true,
      },
    },
    {
      method: "POST",
      path: "/v1/projects/proj_1/agents",
      body: {
        name: "builder",
        engine: "claude",
        contractItemId: "item_contract",
        model: {},
        triggers: [
          { type: "schedule", config: { cron: "0 9 * * 1-5", timezone: "UTC" } },
        ],
        enabled: true,
      },
    },
  ]);
});

test("provider, budget, and webhook setup are fully scriptable", async () => {
  const calls = [];
  const stdout = sink();
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/v1/providers") return json({ id: "key_provider" });
    if (path === "/v1/budgets") return json({ id: "bud_1" });
    return json({ id: "int_1", secret: "webhook_secret_value" });
  };

  assert.equal(
    await runPlatformCommand(
      "providers",
      ["create", "--provider", "openai", "--name", "primary", "--secret", "sk-test"],
      { config: config(), stdout: sink(), fetch },
    ),
    0,
  );
  assert.equal(
    await runPlatformCommand(
      "budgets",
      ["set", "--scope", "org", "--period", "monthly", "--limit-cents", "25000", "--mode", "hard"],
      { config: config(), stdout: sink(), fetch },
    ),
    0,
  );
  assert.equal(
    await runPlatformCommand(
      "integrations",
      ["create", "--kind", "webhook", "--name", "deployments", "--config", '{"url":"https://hooks.test/facility"}'],
      { config: config(), stdout, fetch },
    ),
    0,
  );

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v1/providers",
      body: { provider: "openai", name: "primary", secret: "sk-test" },
    },
    {
      method: "POST",
      path: "/v1/budgets",
      body: { scope: "org", period: "monthly", limitCents: 25000, mode: "hard" },
    },
    {
      method: "POST",
      path: "/v1/integrations",
      body: {
        kind: "webhook",
        name: "deployments",
        config: { url: "https://hooks.test/facility" },
        enabled: true,
      },
    },
  ]);
  assert.match(stdout.text, /webhook_secret_value/);
  assert.match(stdout.text, /shown once/);
});

test("audit verification is available as a first-class CLI command", async () => {
  const stdout = sink();
  const exit = await runPlatformCommand("audit", ["verify", "--json"], {
    config: config(),
    stdout,
    fetch: async (url) => {
      assert.equal(new URL(url).pathname, "/v1/audit/verify");
      return json({ ok: true, firstBreakSeq: null });
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(JSON.parse(stdout.text), { ok: true, firstBreakSeq: null });
});

test("platform commands reject misspelled flags instead of silently ignoring them", async () => {
  const stdout = sink();
  const stderr = sink();
  const exit = await runPlatformCommand("agents", ["list", "demo", "--tiemzone", "UTC", "--json"], {
    stdout,
    stderr,
    config: config(),
  });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(stdout.text).error.code, "unknown_flag");
  assert.equal(stderr.text, "");
});

test("bounded list pagination is exposed consistently and validated locally", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return json([]);
  };

  assert.equal(
    await runPlatformCommand("projects", ["list", "--limit", "25", "--offset", "50", "--json"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0,
  );
  assert.equal(
    await runPlatformCommand("roles", ["list", "--limit", "10", "--offset", "20", "--json"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0,
  );
  assert.deepEqual(
    calls.map((value) => new URL(value).search),
    ["?limit=25&offset=50", "?limit=10&offset=20"],
  );

  const stdout = sink();
  const invalid = await runPlatformCommand("projects", ["list", "--limit", "201", "--json"], {
    config: config(),
    stdout,
    fetch,
  });
  assert.equal(invalid, 1);
  assert.equal(JSON.parse(stdout.text).error.code, "invalid_flag");
  assert.equal(
    JSON.parse(stdout.text).error.message,
    "--limit must be an integer from 1 to 200",
  );
  for (const command of ["projects", "roles"]) {
    const malformedOut = sink();
    assert.equal(
      await runPlatformCommand(command, ["list", "--limit", "abc", "--json"], {
        config: config(),
        stdout: malformedOut,
        fetch,
      }),
      1,
    );
    assert.equal(
      JSON.parse(malformedOut.text).error.message,
      "--limit must be an integer from 1 to 200",
    );
  }
  const missingProjectOut = sink();
  assert.equal(
    await runPlatformCommand("agents", ["list", "--limit", "abc", "--json"], {
      config: config(),
      stdout: missingProjectOut,
      fetch,
    }),
    1,
  );
  assert.equal(
    JSON.parse(missingProjectOut.text).error.message,
    "--limit must be an integer from 1 to 200",
  );
  assert.equal(calls.length, 2, "invalid pagination must fail before a request");
});

test("paged command help makes list navigation discoverable", async () => {
  const stdout = sink();
  assert.equal(await runPlatformCommand("projects", ["--help"], { stdout }), 0);
  assert.match(stdout.text, /List options/);
  assert.match(stdout.text, /--limit <1-200>/);
  assert.match(stdout.text, /--offset <n>/);
});

test("idempotency keys make CLI writes replay-safe and retry transient failures", async () => {
  let attempts = 0;
  const headers = [];
  const exit = await runPlatformCommand(
    "roles",
    [
      "create",
      "--name",
      "release-manager",
      "--permissions",
      "runs:read",
      "--idempotency-key",
      "role-release-manager-2026",
      "--json",
    ],
    {
      config: config(),
      stdout: sink(),
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        attempts += 1;
        headers.push(new Headers(init.headers).get("idempotency-key"));
        return attempts === 1
          ? json({ error: { code: "unavailable", message: "warming up" } }, 503)
          : json({ id: "role_release_manager", name: "release-manager" });
      },
    },
  );
  assert.equal(exit, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(headers, ["role-release-manager-2026", "role-release-manager-2026"]);

  const stdout = sink();
  let called = false;
  const invalid = await runPlatformCommand(
    "projects",
    ["create", "--name", "One", "--slug", "one", "--idempotency-key", "short", "--json"],
    {
      config: config(),
      stdout,
      fetch: async () => {
        called = true;
        return json({});
      },
    },
  );
  assert.equal(invalid, 1);
  assert.equal(called, false);
  assert.equal(JSON.parse(stdout.text).error.code, "invalid_idempotency_key");
});

test("sessions expose transcripts, interrupt, and resume without the web application", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (path.endsWith("/transcript")) {
      return new Response('{"type":"assistant","text":"done"}\n', {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (path.endsWith("/resume")) return json({ id: "run_resumed", status: "queued" });
    return json({ ok: true });
  };

  const transcript = sink();
  assert.equal(
    await runPlatformCommand("sessions", ["transcript", "run_1", "--json"], {
      config: config(),
      stdout: transcript,
      fetch,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(transcript.text), {
    sessionId: "run_1",
    events: [{ type: "assistant", text: "done" }],
  });
  assert.equal(
    await runPlatformCommand("sessions", ["interrupt", "run_1"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0,
  );
  assert.equal(
    await runPlatformCommand("sessions", ["resume", "run_1", "continue", "carefully"], {
      config: config(),
      stdout: sink(),
      fetch,
    }),
    0,
  );
  assert.deepEqual(calls, [
    { path: "/v1/runs/run_1/transcript", method: "GET", body: undefined },
    { path: "/v1/runs/run_1/interrupt", method: "POST", body: undefined },
    {
      path: "/v1/runs/run_1/resume",
      method: "POST",
      body: { message: "continue carefully" },
    },
  ]);
});

test("provider setup forwards Claude subscription authentication explicitly", async () => {
  let request;
  const exit = await runPlatformCommand(
    "providers",
    [
      "create",
      "--provider",
      "anthropic",
      "--name",
      "claude-subscription",
      "--auth-mode",
      "oauth",
      "--secret",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token",
    ],
    {
      config: config(),
      stdout: sink(),
      fetch: async (url, init = {}) => {
        request = {
          path: new URL(url).pathname,
          body: init.body ? JSON.parse(init.body) : undefined,
        };
        return json({ id: "provider_oauth" });
      },
    },
  );

  assert.equal(exit, 0);
  assert.deepEqual(request, {
    path: "/v1/providers",
    body: {
      provider: "anthropic",
      name: "claude-subscription",
      secret: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token",
      authMode: "oauth",
    },
  });
});

test("conversations, GitHub issues, catalog, outcomes, and event history are first-class CLI surfaces", async () => {
  const calls = [];
  const repoQualifiedCalls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: parsed.pathname, method: init.method, body });
    if (parsed.pathname.includes("/issues/42")) {
      repoQualifiedCalls.push({
        path: parsed.pathname,
        repoId: parsed.searchParams.get("repoId"),
      });
    }
    if (parsed.pathname === "/v1/projects") {
      return json([{ id: "proj_1", slug: "demo", name: "Demo", status: "active" }]);
    }
    if (parsed.pathname === "/v1/projects/proj_1/conversations" && init.method === "POST") {
      return json({ id: "evt_thread", status: "idle" });
    }
    if (parsed.pathname === "/v1/conversations/evt_thread/messages") {
      return json({ runId: "run_turn", message: { id: "evt_message" } });
    }
    if (parsed.pathname.endsWith("/issues/sync")) return json({ queued: 1 }, 202);
    if (parsed.pathname.endsWith("/issues/42/trigger")) return json({ id: "run_issue" });
    if (parsed.pathname === "/v1/catalog") {
      return json({ engines: [], models: [], triggerTypes: [], permissions: { all: [] } });
    }
    return json([]);
  };

  const commands = [
    ["conversations", ["start", "demo", "--title", "Release review"]],
    ["conversations", ["send", "evt_thread", "Please", "continue"]],
    ["github", ["issues", "demo", "--state", "open"]],
    ["github", ["issue", "demo", "42", "--repo", "repo_1"]],
    ["github", ["sync", "demo"]],
    ["github", ["trigger", "demo", "42", "--repo", "repo_1", "--agent", "builder"]],
    ["agents", ["status", "demo"]],
    ["integrations", ["events", "int_1"]],
    ["outcomes", ["--state", "all"]],
    ["catalog", []],
  ];
  for (const [command, args] of commands) {
    assert.equal(
      await runPlatformCommand(command, args, { config: config(), stdout: sink(), fetch }),
      0,
      `${command} ${args.join(" ")}`,
    );
  }

  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]),
    [
      ["/v1/projects/proj_1/conversations", { title: "Release review" }],
      ["/v1/conversations/evt_thread/messages", { body: "Please continue" }],
      ["/v1/projects/proj_1/issues/sync", undefined],
      ["/v1/projects/proj_1/issues/42/trigger", { agent: "builder" }],
    ],
  );
  assert.ok(calls.some((call) => call.path === "/v1/projects/proj_1/agents/status"));
  assert.ok(calls.some((call) => call.path === "/v1/integrations/int_1/events"));
  assert.ok(calls.some((call) => call.path === "/v1/outcomes"));
  assert.ok(calls.some((call) => call.path === "/v1/catalog"));
  assert.deepEqual(repoQualifiedCalls, [
    { path: "/v1/projects/proj_1/issues/42", repoId: "repo_1" },
    { path: "/v1/projects/proj_1/issues/42/trigger", repoId: "repo_1" },
  ]);
});
