import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  drainLineEvents,
  FetchJsonError,
  fetchJson,
  isRunTerminalConflict,
  isTransientFetchError,
  retryAfterMs,
  transientRetryDelayMs,
} from "../src/index.js";
import type { RunEvent } from "../src/types.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
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

  it("classifies containerized-DNS loss and undici stall timeouts as transient", () => {
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND api"), { code: "ENOTFOUND" });
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: notFound }))).toBe(true);
    const headersTimeout = Object.assign(new Error("Headers Timeout Error"), {
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    expect(isTransientFetchError(new TypeError("fetch failed", { cause: headersTimeout }))).toBe(
      true,
    );
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
      fetchJson(`http://127.0.0.1:${port}/events`, {}, undefined, { budgetMs: 0 }),
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
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it("retries when the control plane dies between headers and body", async () => {
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
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
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
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
    // 20ms is half the 40ms jitter window — the floor Retry-After: 0 must not
    // defeat.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
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
