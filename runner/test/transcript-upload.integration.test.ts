import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRunResult, type RunPolls } from "../src/index.js";
import type { RunBundle, RunEvent } from "../src/types.js";

const ENV_KEYS = ["FACILITY_API_URL", "RUN_ID", "RUNNER_TOKEN"] as const;

const RUN_ID = "run_transcript";
const RUNNER_TOKEN = "runner-transcript-token";
const TRANSCRIPT_LINE = '{"type":"assistant","message":"hello"}\n';

type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

let cleanups: Array<() => Promise<void>> = [];
let handlerFailures: unknown[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let previousFetch: typeof fetch;

beforeEach(() => {
  cleanups = [];
  handlerFailures = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error(`integration test blocked external request to ${url.origin}`);
    }
    return previousFetch(request, init);
  };
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = previousFetch;
  }
  failures.push(...handlerFailures);
  if (failures.length > 0) throw new AggregateError(failures, "integration fixture cleanup failed");
});

/**
 * Stands in for the platform: the transcript route answers with `transcriptStatus`,
 * the events route walks `eventsStatuses` one status per request (the last value
 * sticking for any further requests), so a test can make one events request
 * succeed and the next fail. Every events request is recorded — rejected ones
 * included — so a test can assert how many requests were made, not only what
 * the platform ended up storing.
 */
async function startPlatform({
  transcriptStatus = 200,
  eventsStatuses = [200],
}: {
  transcriptStatus?: number;
  eventsStatuses?: number[];
} = {}) {
  const requests: RecordedRequest[] = [];
  const eventRequests: RunEvent[][] = [];
  const eventBatches: RunEvent[][] = [];
  let eventsCall = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      // Drain before replying: the transcript upload streams its body, and
      // answering early would surface as a socket error instead of the status.
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      if (recorded.headers.authorization !== `Bearer ${RUNNER_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "invalid runner token" }));
        return;
      }
      if (recorded.method === "POST" && recorded.path === `/internal/runs/${RUN_ID}/transcript`) {
        response.writeHead(transcriptStatus, { "content-type": "application/json" });
        response.end(JSON.stringify(transcriptStatus === 200 ? {} : { error: "s3_write_failed" }));
        return;
      }
      if (recorded.method === "POST" && recorded.path === `/internal/runs/${RUN_ID}/events`) {
        const batch = JSON.parse(recorded.body) as RunEvent[];
        const status = eventsStatuses[Math.min(eventsCall, eventsStatuses.length - 1)] ?? 200;
        eventsCall += 1;
        eventRequests.push(batch);
        // The API inserts a batch in one transaction, so a rejected request
        // stores none of it.
        if (status === 200) eventBatches.push(batch);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 200 ? {} : { message: "events degraded" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `unexpected route ${recorded.path}` }));
    } catch (error) {
      handlerFailures.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  process.env.FACILITY_API_URL = `http://127.0.0.1:${port}`;
  process.env.RUN_ID = RUN_ID;
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  return {
    requests,
    /** Every event the platform accepted, flattened across batches. */
    events: () => eventBatches.flat(),
    /** Every batch the runner sent to the events route, rejected ones included. */
    eventRequests: () => eventRequests,
    transcriptRequests: () =>
      requests.filter((r) => r.path === `/internal/runs/${RUN_ID}/transcript`),
  };
}

async function writeTranscript(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "facility-transcript-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "engine.stream.jsonl");
  await writeFile(path, contents);
  return path;
}

function bundle(overrides: Partial<RunBundle> = {}): RunBundle {
  return {
    runId: RUN_ID,
    mode: "builder",
    engine: "codex",
    contract: "Do the work.",
    skills: [],
    engineConfig: {},
    repo: { cloneUrl: null, branch: null, expectedHeadSha: null, installationTokenRef: null },
    harness: null,
    packageInstallCmd: null,
    provisionCmd: null,
    checkCmds: [],
    gatewayUrls: { anthropic: "https://anthropic.test", openai: "https://openai.test" },
    scope: {},
    timeoutMin: 5,
    ...overrides,
  };
}

/**
 * Runs the run's real `result_capture` phase — the same exported function
 * `main()` measures — over a transcript this test controls. Nothing about the
 * phase is reassembled here: only its inputs (the polls `main()` started
 * before the engine, and the transcript path) are supplied, so a step removed
 * from the phase is a step removed from these tests.
 */
async function capture(transcriptPath: string) {
  const polls: RunPolls = {
    progress: async () => false,
    checkpoint: async () => undefined,
  };
  const captured = await captureRunResult({
    bundle: bundle(),
    engineCode: 0,
    managedProgress: null,
    preparedSecuritySweep: null,
    polls,
    transcriptPath,
  });
  return { captured, polls };
}

describe("result capture phase wiring", () => {
  it("keeps the capture phase wired into main()", async () => {
    // The tests below drive `captureRunResult` directly, which is the only way
    // to reach the phase: `main()` is not exported and no test spawns the
    // runner. That leaves one gap they cannot see — a `main()` that stops
    // calling the phase at all. Asserting the call site closes it, so deleting
    // it turns this suite red instead of silently retiring the transcript
    // upload and the evidence it emits.
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

    expect(source).toMatch(
      /phases\.measure\(\s*"result_capture",\s*\(\)\s*=>\s*captureRunResult\(/,
    );
  });
});

describe("result capture transcript evidence", () => {
  it("streams the transcript to the platform and records nothing when it lands", async () => {
    const platform = await startPlatform();
    const path = await writeTranscript(TRANSCRIPT_LINE);

    const { polls } = await capture(path);

    const [upload] = platform.transcriptRequests();
    expect(upload?.headers["content-type"]).toBe("application/x-ndjson");
    expect(upload?.body).toBe(TRANSCRIPT_LINE);
    expect(platform.events()).toEqual([]);
    // Both polls stopped and cleared, so main()'s `finally` cannot stop them
    // a second time.
    expect(polls).toEqual({ progress: undefined, checkpoint: undefined });
  });

  it("does not upload or record anything when the engine wrote no transcript", async () => {
    const platform = await startPlatform({ transcriptStatus: 500 });
    const path = await writeTranscript("");

    await capture(path);

    expect(platform.transcriptRequests()).toEqual([]);
    expect(platform.events()).toEqual([]);
  });

  it("records a rejected upload as evidence that the receipt's check query cannot collect", async () => {
    const platform = await startPlatform({ transcriptStatus: 500 });
    const path = await writeTranscript(TRANSCRIPT_LINE);

    await capture(path);

    const events = platform.events();
    expect(events).toContainEqual({
      type: "evidence",
      data: { name: "transcript", status: "failed", reason: "transcript_upload_failed" },
    });
    // The receipt collects its check list with `where type = 'check'`, so the
    // loss is recorded without ever reaching the gate that list feeds.
    expect(events.filter((event) => event.type === "check")).toEqual([]);
    expect(events).toContainEqual({
      type: "artifact_error",
      data: { kind: "transcript_upload_failed" },
    });
  });

  it("sends the error and the evidence in one request, so a later failure cannot strand the anonymous half", async () => {
    const platform = await startPlatform({ transcriptStatus: 500, eventsStatuses: [200, 503] });
    const path = await writeTranscript(TRANSCRIPT_LINE);

    await capture(path);

    const batch: RunEvent[] = [
      { type: "artifact_error", data: { kind: "transcript_upload_failed" } },
      {
        type: "evidence",
        data: { name: "transcript", status: "failed", reason: "transcript_upload_failed" },
      },
    ];
    // The outcome that matters: the platform stored both halves even though it
    // rejects the second request. Emitted separately, the 200 is spent on the
    // anonymous error and the named evidence is lost to the 503, leaving the
    // receipt with an anonymous +1 on `activity.errors` and nothing saying the
    // transcript is what the run lost.
    expect(platform.events()).toEqual(batch);
    // One request, so the 503 is never reached at all.
    expect(platform.eventRequests()).toEqual([batch]);
  });

  it("survives an events endpoint that is degraded at the same time", async () => {
    const platform = await startPlatform({ transcriptStatus: 500, eventsStatuses: [503] });
    const path = await writeTranscript(TRANSCRIPT_LINE);

    // Both writes fail, and the phase must still complete: an unguarded emit
    // here would reach main()'s outer catch and fail an otherwise successful
    // run over a storage blip.
    const { captured, polls } = await capture(path);

    expect(captured.progressPublished).toBe(false);
    expect(polls).toEqual({ progress: undefined, checkpoint: undefined });
    // The batch is rejected whole, so the receipt never holds the anonymous
    // error without the evidence that names what was lost.
    expect(platform.events()).toEqual([]);
  });
});
