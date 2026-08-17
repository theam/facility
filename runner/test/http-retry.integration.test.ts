import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyControlMessages,
  drainLineEvents,
  ENDPOINT_RETRY_POLICIES,
  ENDPOINT_RETRY_POLICY_DEFAULT,
  emitRunEvents,
  endpointRetryPolicy,
  FetchJsonError,
  fetchJson,
  fetchSessionStateArchive,
  isRunTerminalConflict,
  isTransientFetchError,
  postResult,
  requestPushToken,
  retryAfterMs,
  steerPollPath,
  transientRetryDelayMs,
} from "../src/index.js";
import type { RunEvent } from "../src/types.js";

const servers: ReturnType<typeof createServer>[] = [];

// The production call paths below read the API origin and the run's credentials
// from the environment, so a test that drives one has to point them at its own
// server and put the process back as it found it.
const RUNNER_ENV_KEYS = ["FACILITY_API_URL", "RUN_ID", "RUNNER_TOKEN"] as const;
let previousRunnerEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  previousRunnerEnv = Object.fromEntries(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const key of RUNNER_ENV_KEYS) {
    const value = previousRunnerEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function configureRunner(origin: string) {
  process.env.FACILITY_API_URL = origin;
  process.env.RUN_ID = "run_test";
  process.env.RUNNER_TOKEN = "runner-test-token";
}

// Flushes response headers and a truncated body, then kills the socket: the
// shape of a control plane dying after a route handler may already have
// committed. undici surfaces it as a socket-level loss, the class of failure
// that only an endpoint absorbing a duplicate may replay. The request body is
// drained first so the loss lands on the response rather than on an upload the
// server never read.
async function startAmbiguousLossServer(reply: unknown, failures = 1) {
  const attempts: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      attempts.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (attempts.length <= failures) {
        response.setHeader("content-length", "100");
        response.write("{");
        response.destroy();
        return;
      }
      response.end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { attempts, origin: `http://127.0.0.1:${port}` };
}

// Binds an ephemeral port and releases it, so the next connect to it is refused
// by the kernel — the provably-undelivered failure a restarting control plane
// produces.
async function reserveClosedPort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("runner HTTP rate-limit recovery", () => {
  it("parses numeric and HTTP-date Retry-After values with a bounded fallback", () => {
    const now = Date.parse("2026-08-05T10:00:00.000Z");
    expect(retryAfterMs("4", now)).toBe(4_000);
    expect(retryAfterMs("Wed, 05 Aug 2026 10:00:03 GMT", now)).toBe(3_000);
    expect(retryAfterMs("3600", now)).toBe(60_000);
    expect(retryAfterMs("-1", now)).toBe(1_000);
    expect(retryAfterMs("0x10", now)).toBe(1_000);
    expect(retryAfterMs("1e2", now)).toBe(1_000);
    expect(retryAfterMs("invalid", now)).toBe(1_000);
    expect(retryAfterMs(null, now)).toBe(1_000);
  });

  it("creates a fresh streaming body for every upload attempt", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.setHeader("content-type", "application/json");
        if (bodies.length === 1) {
          response.statusCode = 429;
          response.setHeader("retry-after", "0");
          response.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }
        response.end(JSON.stringify({ uploaded: true }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const payload = "streamed transcript\n";

    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/transcript`,
        {
          method: "POST",
          headers: { "content-type": "application/x-ndjson" },
          duplex: "half",
        } as RequestInit & { duplex: "half" },
        () => Readable.from(payload) as unknown as RequestInit["body"],
      ),
    ).resolves.toEqual({ uploaded: true });
    expect(bodies).toEqual([payload, payload]);
  });

  it("replays an authenticated event batch after a deterministic 429", async () => {
    const requests: Array<{ authorization: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ authorization: request.headers.authorization, body });
        response.setHeader("content-type", "application/json");
        if (requests.length === 1) {
          response.statusCode = 429;
          response.setHeader("retry-after", "0");
          response.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }
        response.end(JSON.stringify({ count: 1 }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const payload = JSON.stringify([{ type: "shell", data: { text: "installed" } }]);

    await expect(
      fetchJson(`http://127.0.0.1:${port}/internal/runs/run_test/events`, {
        method: "POST",
        headers: {
          authorization: "Bearer runner-test-token",
          "content-type": "application/json",
        },
        body: payload,
      }),
    ).resolves.toEqual({ count: 1 });
    expect(requests).toEqual([
      { authorization: "Bearer runner-test-token", body: payload },
      { authorization: "Bearer runner-test-token", body: payload },
    ]);
  });

  it("fails closed after the bounded number of rate-limit retries", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 429;
      response.setHeader("content-type", "application/json");
      response.setHeader("retry-after", "0");
      response.end(JSON.stringify({ error: "still_rate_limited" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(fetchJson(`http://127.0.0.1:${port}/events`)).rejects.toThrow("failed 429");
    expect(attempts).toBe(9);
  });
});

describe("runner transient-failure classification", () => {
  it("classifies syscall-level network failures as transient wherever undici nests them", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: refused }))).toBe(true);
    const aggregate = new AggregateError([refused], "connect failed");
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: aggregate }))).toBe(true);
    expect(isTransientFetchError(refused)).toBe(true);
  });

  it("separates provably-undelivered failures from ambiguous ones", () => {
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND api"), { code: "ENOTFOUND" });
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: notFound }))).toBe(true);
    // An undici stall timeout leaves the request on the wire, so it is retryable
    // only where a second delivery of the same request is harmless.
    const headersTimeout = Object.assign(new Error("Headers Timeout Error"), {
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: headersTimeout }))).toBe(
      false,
    );
    expect(
      isTransientFetchError(new TypeError("fetch failed", { cause: headersTimeout }), true),
    ).toBe(true);
  });

  it("keeps aborts, timeouts, and unknown failures fatal", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isTransientFetchError(abort)).toBe(false);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(isTransientFetchError(timeout)).toBe(false);
    expect(isTransientFetchError(new TypeError("Invalid URL"))).toBe(false);
    expect(isTransientFetchError(new Error("boom"))).toBe(false);
    expect(isTransientFetchError(undefined)).toBe(false);
  });

  it("spreads retry delays inside a bounded, growing jitter window", () => {
    expect(transientRetryDelayMs(0, 500, 10_000, () => 0)).toBe(250);
    expect(transientRetryDelayMs(0, 500, 10_000, () => 1)).toBe(500);
    expect(transientRetryDelayMs(2, 500, 10_000, () => 0)).toBe(1_000);
    expect(transientRetryDelayMs(2, 500, 10_000, () => 1)).toBe(2_000);
    expect(transientRetryDelayMs(10, 500, 10_000, () => 1)).toBe(10_000);
  });

  it("recognizes a run-terminal conflict as an already-recorded result", () => {
    const terminal = new FetchJsonError(
      "http://127.0.0.1/internal/runs/run_test/result",
      409,
      JSON.stringify({ error: { code: "run_terminal", message: "Run is terminal" } }),
    );
    expect(isRunTerminalConflict(terminal)).toBe(true);
    const otherConflict = new FetchJsonError(
      "http://127.0.0.1/internal/runs/run_test/result",
      409,
      JSON.stringify({ error: { code: "different_conflict", message: "no" } }),
    );
    expect(isRunTerminalConflict(otherConflict)).toBe(false);
    const wrongStatus = new FetchJsonError(
      "http://127.0.0.1/internal/runs/run_test/result",
      503,
      JSON.stringify({ error: { code: "run_terminal", message: "no" } }),
    );
    expect(isRunTerminalConflict(wrongStatus)).toBe(false);
    const unparseable = new FetchJsonError("http://127.0.0.1/result", 409, "run_terminal");
    expect(isRunTerminalConflict(unparseable)).toBe(false);
    expect(isRunTerminalConflict(new Error("run_terminal"))).toBe(false);
  });
});

describe("runner control-plane outage recovery", () => {
  it("retries a connection-refused call until the control plane comes back", async () => {
    const probe = createServer();
    servers.push(probe);
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    servers.splice(servers.indexOf(probe), 1);

    const revivedRequests: string[] = [];
    // Restart the control plane on the same port mid-retry, like a dev watch
    // or deploy restart of the API while the runner is in flight.
    const revival = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(async () => {
      const revived = createServer((request, response) => {
        revivedRequests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
      servers.push(revived);
      await new Promise<void>((resolve) => revived.listen(port, "127.0.0.1", resolve));
    });

    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/internal/runs/run_test/events`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
        undefined,
        { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 },
      ),
    ).resolves.toEqual({ ok: true });
    await revival;
    expect(revivedRequests).toEqual(["/internal/runs/run_test/events"]);
  });

  it("retries transient 5xx responses and succeeds when the API recovers", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts < 3) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "restarting" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/internal/runs/run_test/result`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
        maxDelayMs: 4,
        replaySafe: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("does not spend the outage budget on a single failing attempt", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "restarting" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 0,
        replaySafe: true,
      }),
    ).rejects.toThrow("failed 503");
    expect(attempts).toBe(1);
  });

  it("gives up once the outage budget is exhausted", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "still_down" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 150,
        baseDelayMs: 1,
        maxDelayMs: 4,
        replaySafe: true,
      }),
    ).rejects.toThrow("failed 503");
    expect(attempts).toBeGreaterThan(1);
  });

  it("does not retry non-transient client errors", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "bad_request" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow("failed 400");
    expect(attempts).toBe(1);
  });

  it("grants one retry even when a slow failure consumed the whole budget", async () => {
    const probe = createServer();
    servers.push(probe);
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    servers.splice(servers.indexOf(probe), 1);

    const revivedRequests: string[] = [];
    const revival = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(async () => {
      const revived = createServer((request, response) => {
        revivedRequests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
      servers.push(revived);
      await new Promise<void>((resolve) => revived.listen(port, "127.0.0.1", resolve));
    });

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 0,
        baseDelayMs: 60,
        maxDelayMs: 60,
      }),
    ).resolves.toEqual({ ok: true });
    await revival;
    expect(revivedRequests).toEqual(["/events"]);
  });

  it("keeps rate-limit retries outside the transient outage budget", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.statusCode = 429;
        response.setHeader("retry-after", "0");
        response.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, { budgetMs: 0 }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("honors a server-requested Retry-After beyond the backoff", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.statusCode = 503;
        response.setHeader("retry-after", "1");
        response.end(JSON.stringify({ error: "recovering" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const startedAt = Date.now();
    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
        maxDelayMs: 4,
        replaySafe: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it("retries a replay-safe call when the control plane dies between headers and body", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.setHeader("content-length", "100");
        response.write("{");
        response.destroy();
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
        maxDelayMs: 4,
        replaySafe: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("applies an interrupt exactly once when the control plane dies mid-response", async () => {
    const message = { id: "evt_interrupt", kind: "interrupt", body: "human_interrupt" };
    let attempts = 0;
    const delivered = new Set<string>();
    const server = createServer((request, response) => {
      attempts += 1;
      const polled = new URL(request.url ?? "/", "http://127.0.0.1");
      for (const id of polled.searchParams.get("ack")?.split(",") ?? []) delivered.add(id);
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.setHeader("content-length", "100");
        response.write("[");
        response.destroy();
        return;
      }
      // Delivery is recorded from the ack the next poll carries, not from the
      // select, so a lost response leaves the interrupt pending and the replay
      // serves it again.
      response.end(JSON.stringify(delivered.has(message.id) ? [] : [message]));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    let interrupts = 0;
    const handlers = {
      appendSteer: async () => {
        throw new Error("an interrupt must never reach the steer file");
      },
      emit: async () => undefined,
      interrupt: async () => {
        interrupts += 1;
      },
    };
    let ack: string[] = [];
    for (let poll = 0; poll < 2; poll += 1) {
      const messages = (await fetchJson(
        `http://127.0.0.1:${port}${steerPollPath("run_test", ack)}`,
        {},
        undefined,
        { budgetMs: 5_000, baseDelayMs: 1, maxDelayMs: 4, replaySafe: true },
      )) as Array<{ id: string; kind?: string; body: string }>;
      const applied = await applyControlMessages(messages, handlers);
      expect(applied.error).toBeUndefined();
      ack = applied.handled;
    }

    // Three requests: the destroyed one, its replay carrying the same message,
    // and the acknowledged poll that comes back empty.
    expect(attempts).toBe(3);
    expect(interrupts).toBe(1);
    expect(ack).toEqual([]);
    expect(delivered).toEqual(new Set([message.id]));
  });

  it("keeps a failing 5xx retry loop paced even when Retry-After asks for zero delay", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts < 2) {
        response.statusCode = 503;
        response.setHeader("retry-after", "0");
        response.end(JSON.stringify({ error: "recovering" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const startedAt = Date.now();
    await expect(
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 40,
        maxDelayMs: 40,
        replaySafe: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    // 20ms is half the 40ms jitter window — the floor Retry-After: 0 must not
    // defeat.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it("replays a connection-refused call even when the caller is not replay-safe", async () => {
    const probe = createServer();
    servers.push(probe);
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    servers.splice(servers.indexOf(probe), 1);

    const revivedRequests: string[] = [];
    const revival = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(async () => {
      const revived = createServer((request, response) => {
        revivedRequests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ token: "ghs_replayed" }));
      });
      servers.push(revived);
      await new Promise<void>((resolve) => revived.listen(port, "127.0.0.1", resolve));
    });

    // A refused connection proves no route handler ran, so even the endpoints
    // that must never be replayed after a lost response still ride out the
    // restart this whole mechanism exists for.
    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/internal/runs/run_test/push-token`,
        { method: "POST" },
        undefined,
        { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 },
      ),
    ).resolves.toEqual({ token: "ghs_replayed" });
    await revival;
    expect(revivedRequests).toEqual(["/internal/runs/run_test/push-token"]);
  });

  it("never replays an ambiguous mid-flight failure for a call that is not replay-safe", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", "100");
      response.write("{");
      response.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // The handler may already have minted the installation token and written its
    // audit row before the socket died, so the loss has to surface as a failure.
    // A replay here leaves a second live contents:write token that nobody holds.
    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/internal/runs/run_test/push-token`,
        { method: "POST" },
        undefined,
        { budgetMs: 5_000, baseDelayMs: 1, maxDelayMs: 4 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("replays an ambiguous mid-flight failure when the caller opts in", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts === 1) {
        response.setHeader("content-length", "100");
        response.write("{");
        response.destroy();
        return;
      }
      response.end(JSON.stringify({ uri: "s3://transcripts/run_test" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // The transcript upload overwrites one object keyed by run id, so a second
    // delivery of the same bytes is indistinguishable from the first.
    await expect(
      fetchJson(
        `http://127.0.0.1:${port}/internal/runs/run_test/transcript`,
        { method: "POST" },
        undefined,
        { budgetMs: 5_000, baseDelayMs: 1, maxDelayMs: 4, replaySafe: true },
      ),
    ).resolves.toEqual({ uri: "s3://transcripts/run_test" });
    expect(attempts).toBe(2);
  });

  it("replays a transient 5xx only for the caller that opts in", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader("content-type", "application/json");
      if (attempts < 3) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "restarting" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // A 5xx may have been raised after the handler committed, so recovering from
    // it is the same ambiguous replay: the conservative caller fails on its first
    // answer.
    await expect(
      fetchJson(`http://127.0.0.1:${port}/internal/runs/run_test/events`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
        maxDelayMs: 4,
      }),
    ).rejects.toThrow("failed 503");
    expect(attempts).toBe(1);

    await expect(
      fetchJson(`http://127.0.0.1:${port}/internal/runs/run_test/result`, {}, undefined, {
        budgetMs: 5_000,
        baseDelayMs: 1,
        maxDelayMs: 4,
        replaySafe: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("resumes the stream when event delivery fails for good, so the child can exit", async () => {
    const stream = new PassThrough({ highWaterMark: 16 });
    const draining = drainLineEvents(
      stream,
      "shell",
      async () => {
        throw new Error("delivery_failed");
      },
      { flushMs: 1 },
    );
    stream.write("first line\n");
    await expect(draining).rejects.toThrow("delivery_failed");

    // The write callback fires only if the resumed stream consumes the chunk;
    // the guard timer wins if the failed drain left the pipe paused.
    const flushed = new Promise<boolean>((resolve) => {
      stream.write("x".repeat(1_024), () => resolve(true));
    });
    const guard = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500));
    await expect(Promise.race([flushed, guard])).resolves.toBe(true);
  });

  it("buffers shell events during a control-plane restart and delivers them once, in order", async () => {
    const batches: RunEvent[][] = [];
    let firstBatchArrived: () => void = () => undefined;
    const firstBatch = new Promise<void>((resolve) => {
      firstBatchArrived = resolve;
    });
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        batches.push(JSON.parse(body) as RunEvent[]);
        firstBatchArrived();
        response.setHeader("content-type", "application/json");
        // Refuse keep-alive so the restart is observed as a refused connection.
        // A pooled socket dispatched in the same tick the API's FIN arrives fails
        // with UND_ERR_SOCKET instead, and that loss is ambiguous — the events
        // POST does not opt into replaying it, which would make this a race.
        response.setHeader("connection", "close");
        response.end(JSON.stringify({ count: 1 }));
      });
    };
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const stream = new PassThrough();
    const draining = drainLineEvents(
      stream,
      "shell",
      (events) =>
        fetchJson(
          `http://127.0.0.1:${port}/internal/runs/run_test/events`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(events),
          },
          undefined,
          { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 },
        ),
      { flushMs: 1 },
    );

    stream.write("one\n");
    await firstBatch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    servers.splice(servers.indexOf(server), 1);

    stream.write("two\n");
    stream.write("three\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const revived = createServer(handler);
    servers.push(revived);
    await new Promise<void>((resolve) => revived.listen(port, "127.0.0.1", resolve));
    stream.write("four\n");
    stream.end();

    await expect(draining).resolves.toBeUndefined();
    expect(batches.flat().map((event) => event.data?.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});

// The ack is the runner's half of the delivery record: /internal/runs/:runId/steer
// marks a message delivered from the ids the NEXT poll names, so a batch the
// runner mishandles or an ack lost on the wire must both come back. The ids
// travel in the query string, and the server refuses the whole request unless
// each one matches its ACK_ID (services/api/src/routes/internal.ts), so the
// construction is part of the contract rather than a detail.
const ACK_ID = /^evt_[0-9a-f]{32}$/;
const ackId = (hex: string) => `evt_${hex.repeat(32).slice(0, 32)}`;

describe("runner steer poll acknowledgement", () => {
  it("names every acked id in the query and encodes each one on its own", () => {
    const first = ackId("a");
    const second = ackId("b");
    expect(steerPollPath("run_test", [])).toBe("/internal/runs/run_test/steer");
    expect(steerPollPath("run_test", [first, second])).toBe(
      `/internal/runs/run_test/steer?ack=${first},${second}`,
    );

    // The comma is the server's separator, so it stays literal between ids and
    // is escaped inside one: an id carrying its own comma or an ampersand has to
    // arrive as a single off-shape value the server refuses, never as extra ids
    // or a second query parameter.
    const hostile = "evt_1,&ack=evt_2";
    const query = new URL(steerPollPath("run_test", [hostile]), "http://api.invalid").searchParams;
    expect(query.getAll("ack")).toEqual([hostile]);
    expect([...query.keys()]).toEqual(["ack"]);
  });

  it("acks only the ids it handled and is served the rest again", async () => {
    const unwritable = ackId("a");
    const applied = ackId("b");
    const polled: string[][] = [];
    const served: string[][] = [];
    const pending = new Set([unwritable, applied]);
    const server = createServer((request, response) => {
      // The server's own parse: comma-separated ids, each refused unless it is
      // shaped like a message id, and delivery recorded from the ack alone.
      const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
      const ack = query.get("ack")?.split(",") ?? [];
      if (!ack.every((id) => ACK_ID.test(id))) {
        response.statusCode = 400;
        response.end("{}");
        return;
      }
      polled.push(ack);
      for (const id of ack) pending.delete(id);
      const batch = [...pending].map((id) => ({
        id,
        kind: "steer",
        body: id === unwritable ? "onto a full disk" : "tighten the diff",
      }));
      served.push(batch.map((message) => message.id));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(batch));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    let diskFull = true;
    const steers: string[] = [];
    const handlers = {
      appendSteer: async (body: string) => {
        if (diskFull && body === "onto a full disk") throw new Error("no space left on device");
        steers.push(body);
      },
      emit: async () => undefined,
      interrupt: async () => {
        throw new Error("no interrupt was sent");
      },
    };

    let ack: string[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      const messages = (await fetchJson(
        `http://127.0.0.1:${port}${steerPollPath("run_test", ack)}`,
        {},
        undefined,
        { budgetMs: 5_000, baseDelayMs: 1, maxDelayMs: 4, ...ENDPOINT_RETRY_POLICIES.steer },
      )) as Array<{ id: string; kind?: string; body: string }>;
      ack = (await applyControlMessages(messages, handlers)).handled;
      // The disk clears between the first and second poll, so the message the
      // first poll could not write is the one the redelivery lands.
      diskFull = false;
    }

    // First poll acks only what it applied, so the unwritable message stays
    // pending and the second poll is served it again.
    expect(polled).toEqual([[], [applied], [unwritable]]);
    expect(served).toEqual([[unwritable, applied], [unwritable], []]);
    expect(steers).toEqual(["tighten the diff", "onto a full disk"]);
    // Nothing else acknowledged either message, and the run's whole ack traffic
    // stays inside the 32-id cap the server enforces on one poll.
    expect(polled.flat().sort()).toEqual([applied, unwritable].sort());
    for (const ids of polled) expect(ids.length).toBeLessThanOrEqual(32);
  });
});

// Whether an ambiguous mid-flight loss may be replayed is the whole security
// content of the retry work, and it lives in one declaration per endpoint. The
// tests below therefore assert the declaration and then drive the production
// functions that own the calls: a call site that stopped agreeing with the table
// would leave the table assertion green and has to fail something.
describe("runner per-endpoint replay policy", () => {
  it("declares a replay policy for every endpoint the runner calls", () => {
    // Derived from the runner's own source rather than restated here, so a call
    // site added later cannot pick up the default in silence: it has to be
    // classified or fail this test. Two forms name an endpoint — a control-plane
    // path built from a run id, which api() classifies by its last segment, and
    // an entry read from the table by name, which is how the two calls that do
    // not go through api() pass their policy on.
    //
    // This reads text, so it sees every literal path in the file, a mention
    // inside a comment included, and it cannot see a path whose last segment is
    // itself interpolated. Both directions of that are the safe one: an
    // unclassified endpoint fails here, and only a call site written to hide
    // its own endpoint escapes.
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const patterns = [
      /\/internal\/runs\/\$\{[^}]*\}\/([a-z][a-z-]*(?:\/[a-z][a-z-]*)*)/g,
      /ENDPOINT_RETRY_POLICIES(?:\.([a-z][\w$]*)|\["([a-z][a-z-]*)"\])/g,
    ];
    const called = new Set<string>();
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        // Last segment, because that is the part api() classifies by.
        called.add((match[1] ?? match[2] ?? "").split("/").pop() ?? "");
      }
    }
    const declared = Object.keys(ENDPOINT_RETRY_POLICIES);
    // Both directions, which together also keep the derivation honest: an
    // expression that stopped matching anything would leave every declared
    // endpoint unaccounted for instead of passing vacuously.
    expect([...called].filter((endpoint) => !declared.includes(endpoint))).toEqual([]);
    expect(declared.filter((endpoint) => !called.has(endpoint))).toEqual([]);

    // Naming an endpoint is not the same as being classified by the table. A
    // path spelled out at a raw `fetch` reaches the control plane with no policy
    // at all while still counting as "called" above, which is how the
    // session-state restore stayed unclassified with this test green. So the
    // forms are pinned too: every classified call goes through fetchJson or the
    // shared retry loop, which leaves exactly one bare `fetch` in the file — the
    // loop's own, on a URL it was handed as an argument. A second one, whatever
    // it points at, has to fail here and be justified.
    const bareFetches = [...source.matchAll(/(?<![\w$])fetch\(([^\n]*)/g)];
    expect(bareFetches).toHaveLength(1);
    for (const [, args] of bareFetches) {
      expect(args).not.toMatch(/apiUrl\(\)|\/internal\//);
    }

    // The decision each endpoint carries is the reviewable part, so it is still
    // spelled out — a flip from false to true has to be deliberate.
    expect(ENDPOINT_RETRY_POLICIES).toEqual({
      hello: { replaySafe: false },
      bundle: { replaySafe: true },
      steer: { replaySafe: true },
      transcript: { replaySafe: true },
      "session-state": { replaySafe: true },
      result: { budgetMs: 5 * 60_000, replaySafe: true },
      "push-token": { replaySafe: false },
      events: { replaySafe: false },
    });
    expect(ENDPOINT_RETRY_POLICY_DEFAULT).toEqual({ replaySafe: false });
  });

  it("resolves an endpoint path to its declared policy and anything else conservatively", () => {
    expect(endpointRetryPolicy("/internal/runs/run_test/push-token")).toBe(
      ENDPOINT_RETRY_POLICIES["push-token"],
    );
    // The steer poll carries its acks in the query string, which is not part of
    // the endpoint's identity.
    expect(endpointRetryPolicy("/internal/runs/run_test/steer?ack=evt_1,evt_2")).toBe(
      ENDPOINT_RETRY_POLICIES.steer,
    );
    // An endpoint nobody has classified, and an inherited property of the table's
    // own prototype that must never be mistaken for a classification, both fall
    // back to failing rather than replaying.
    expect(endpointRetryPolicy("/internal/runs/run_test/unclassified")).toEqual({
      replaySafe: false,
    });
    expect(endpointRetryPolicy("/internal/runs/run_test/__proto__")).toEqual({
      replaySafe: false,
    });
  });

  it("requests a push token exactly once when the control plane dies mid-response", async () => {
    const control = await startAmbiguousLossServer({ token: "ghs_minted" });
    configureRunner(control.origin);

    // The handler may already have minted the installation token and written its
    // audit row before the socket died. Replaying would leave a second live
    // contents:write token that nobody holds and nothing revokes, so the lost
    // response has to surface as a failed delivery instead.
    await expect(requestPushToken("run_test")).rejects.toThrow();
    expect(control.attempts).toEqual(["/internal/runs/run_test/push-token"]);
  });

  it("delivers an event batch exactly once when the control plane dies mid-response", async () => {
    const control = await startAmbiguousLossServer({ count: 1 });
    configureRunner(control.origin);

    // Appending to run_events is unguarded, so a replay duplicates the batch and
    // with it the check events the platform's signed receipt is derived from.
    await expect(emitRunEvents([{ type: "shell", data: { text: "installed" } }])).rejects.toThrow();
    expect(control.attempts).toEqual(["/internal/runs/run_test/events"]);
  });

  it("replays the terminal result through the very failure the conservative calls refuse", async () => {
    const control = await startAmbiguousLossServer({ ok: true });
    configureRunner(control.origin);

    // Same fixture, opposite outcome: losing the run's verdict entirely is worse
    // than a duplicate post, which the control plane answers 409 run_terminal.
    // Pinning both sides keeps this about the per-endpoint decision rather than
    // about retries existing at all.
    await expect(postResult(null, "succeeded", Date.now() - 1_000)).resolves.toBeUndefined();
    expect(control.attempts).toEqual([
      "/internal/runs/run_test/result",
      "/internal/runs/run_test/result",
    ]);
  });

  it("replays the session-state restore, which reads bytes rather than JSON", async () => {
    const archive = Buffer.from("facility-session-state-archive");
    const attempts: string[] = [];
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      attempts.push(request.url ?? "");
      authorizations.push(request.headers.authorization);
      response.setHeader("content-type", "application/gzip");
      if (attempts.length === 1) {
        // Headers and a truncated body, then the socket dies: a control plane
        // killed mid-response. The restore is a pure GET read, so replaying it
        // cannot duplicate an effect, and losing it costs the resumed run its
        // warm session and its workspace checkpoint.
        response.setHeader("content-length", String(archive.length));
        response.write(archive.subarray(0, 4));
        response.destroy();
        return;
      }
      response.end(archive);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    configureRunner(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    await expect(fetchSessionStateArchive("run_test")).resolves.toEqual(archive);
    expect(attempts).toEqual([
      "/internal/runs/run_test/session-state",
      "/internal/runs/run_test/session-state",
    ]);
    expect(authorizations).toEqual(["Bearer runner-test-token", "Bearer runner-test-token"]);
  });

  it("surfaces a refused session-state restore instead of retrying it", async () => {
    const attempts: string[] = [];
    const server = createServer((request, response) => {
      attempts.push(request.url ?? "");
      response.statusCode = 404;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    configureRunner(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    // A run with no stored archive is a cold start, not an outage, so it has to
    // reach restoreSessionState's own reporting rather than spend the budget.
    await expect(fetchSessionStateArchive("run_test")).rejects.toBeInstanceOf(FetchJsonError);
    expect(attempts).toEqual(["/internal/runs/run_test/session-state"]);
  });

  it("replays a provably-undelivered failure under every policy, conservative ones included", async () => {
    for (const [endpoint, policy] of Object.entries(ENDPOINT_RETRY_POLICIES)) {
      const port = await reserveClosedPort();
      // The path is synthesized from the table's key so a policy added later is
      // covered without editing this test. What is under test is the policy
      // object, not the route, so the bundle entry — whose real request goes to
      // the absolute URL /hello hands back — is exercised the same way.
      const path = `/internal/runs/run_test/${endpoint}`;
      const requests: string[] = [];
      const revival = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(async () => {
        const revived = createServer((request, response) => {
          requests.push(request.url ?? "");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true }));
        });
        servers.push(revived);
        await new Promise<void>((resolve) => revived.listen(port, "127.0.0.1", resolve));
      });

      // Only the pacing is overridden. replaySafe — the decision under test — is
      // whatever the endpoint declares, and a refused connection proves no
      // handler ran, so every endpoint must ride the restart out.
      await expect(
        fetchJson(`http://127.0.0.1:${port}${path}`, {}, undefined, {
          ...policy,
          baseDelayMs: 5,
          maxDelayMs: 20,
        }),
      ).resolves.toEqual({ ok: true });
      await revival;
      expect(requests).toEqual([path]);
    }
  });
});
