import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ecsTaskProtection, WorkerTurnGuard } from "../src/worker-task-protection.js";

const taskArn =
  "arn:aws:ecs:us-east-1:111111111111:task/test-cluster/0123456789abcdef0123456789abcdef";
let server: ReturnType<typeof createServer>;
let endpoint: string;
let response: unknown;
let status: number;
let protectedTask: boolean;
let expiresAt: number;
let requests: { path: string; body: Record<string, unknown> }[];
const env = {
  FACILITY_WORKER_TASK_PROTECTION: "ecs",
  ECS_AGENT_URI: "http://169.254.170.2",
  ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/test",
};

beforeEach(async () => {
  requests = [];
  status = 200;
  response = undefined;
  protectedTask = false;
  expiresAt = 0;
  server = createServer(async (req, res) => {
    if (req.url === "/rollout") {
      res.setHeader("content-type", "application/json");
      return void res.end(
        JSON.stringify({ terminated: !protectedTask || expiresAt <= Date.now() }),
      );
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v4/test/task") return void res.end(JSON.stringify({ TaskARN: taskArn }));
    res.statusCode = status;
    if (status === 200 && response === undefined) {
      protectedTask = body.ProtectionEnabled === true;
      expiresAt = Date.now() + Number(body.ExpiresInMinutes ?? 0) * 60_000;
    }
    res.end(
      JSON.stringify(
        response !== undefined
          ? response
          : {
              protection: {
                TaskArn: taskArn,
                ProtectionEnabled: body.ProtectionEnabled,
                ExpirationDate: new Date(expiresAt).toISOString(),
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request: typeof fetch = (input, init) =>
  fetch(String(input).replace("http://169.254.170.2", endpoint), init);

it("keeps a simulated rolling replacement from terminating an active turn", async () => {
  const protection = await ecsTaskProtection(env, request);
  const guard = new WorkerTurnGuard(protection, { warn: vi.fn() });
  await guard.run(async () => {
    const last = requests.at(-1)?.body;
    expect(last).toEqual({ ProtectionEnabled: true, ExpiresInMinutes: 2880 });
    expect(await (await fetch(`${endpoint}/rollout`)).json()).toEqual({ terminated: false });
  });
  expect(await (await fetch(`${endpoint}/rollout`)).json()).toEqual({ terminated: true });
  expect(requests.map((r) => r.path)).toEqual([
    "/v4/test/task",
    "/task-protection/v1/state",
    "/task-protection/v1/state",
  ]);
  expect(requests.at(-1)?.body).toEqual({ ProtectionEnabled: false });
});

it("keeps a long turn protected when a rolling deployment rejects every renewal", async () => {
  const now = Date.now();
  const protection = await ecsTaskProtection(env, request);
  const dispatch = vi.fn(async () => {
    const initialExpiry = protection?.expiresAt;
    response = { failure: { Reason: "DEPLOYMENT_BLOCKED", Detail: "untrusted provider body" } };
    await expect(protection?.set(true)).rejects.toThrow("DEPLOYMENT_BLOCKED");
    expect(protection?.expiresAt).toBe(initialExpiry);
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60_000);
    expect(await (await fetch(`${endpoint}/rollout`)).json()).toEqual({ terminated: false });
    response = undefined;
  });
  await new WorkerTurnGuard(protection, { warn: vi.fn() }).run(dispatch);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(await (await fetch(`${endpoint}/rollout`)).json()).toEqual({ terminated: true });
});

it("rejects a short confirmed lease before admitting a long turn", async () => {
  response = {
    protection: {
      TaskArn: taskArn,
      ProtectionEnabled: true,
      ExpirationDate: new Date(Date.now() + 120 * 60_000).toISOString(),
    },
  };
  const dispatch = vi.fn();
  await expect(
    new WorkerTurnGuard(await ecsTaskProtection(env, request), { warn: vi.fn() }).run(dispatch),
  ).rejects.toThrow("INSUFFICIENT_LEASE");
  expect(dispatch).not.toHaveBeenCalled();
});

it("reports a blocked renewal with its remaining lease and releases after completion", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const warn = vi.fn();
  let finish!: () => void;
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const guard = new WorkerTurnGuard(await ecsTaskProtection(env, request), { warn });
  const turn = guard.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
        started();
      }),
  );
  await admitted;
  response = { failure: { Reason: "DEPLOYMENT_BLOCKED", Detail: "credential=private-value" } };
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  expect(warn.mock.calls[0]?.[0]).toMatchObject({
    event: "worker.protection_renewal_failed",
    code: "DEPLOYMENT_BLOCKED",
    status: 200,
  });
  expect(warn.mock.calls[0]?.[0].leaseRemainingMs).toBeGreaterThan(47 * 60 * 60_000);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
  response = undefined;
  finish();
  await turn;
  expect(requests.at(-1)?.body).toEqual({ ProtectionEnabled: false });
});

it.each([
  [403, { error: { Code: "AccessDeniedException" } }],
  [200, { failure: { Reason: "DEPLOYMENT_BLOCKED" } }],
  [200, {}],
  [200, null],
  [200, { protection: { TaskArn: taskArn, ProtectionEnabled: false } }],
  [
    200,
    {
      protection: {
        TaskArn: taskArn.replace("111111111111", "222222222222"),
        ProtectionEnabled: true,
        ExpirationDate: "2099-01-01T00:00:00Z",
      },
    },
  ],
  [
    200,
    {
      protection: {
        TaskArn: taskArn,
        ProtectionEnabled: true,
        ExpirationDate: "2000-01-01T00:00:00Z",
      },
    },
  ],
  [200, { protection: { TaskArn: taskArn, ProtectionEnabled: true, ExpirationDate: "invalid" } }],
])("does not admit work when protection is denied, mismatched or stale (%s)", async (code, body) => {
  status = code;
  response = body;
  const dispatch = vi.fn();
  const guard = new WorkerTurnGuard(await ecsTaskProtection(env, request), { warn: vi.fn() });
  await expect(guard.run(dispatch)).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});

it("accepts the legacy ARN format for the same task while retaining account and task identity", async () => {
  response = {
    protection: {
      TaskArn: taskArn.replace("test-cluster/", ""),
      ProtectionEnabled: true,
      ExpirationDate: "2099-01-01T00:00:00Z",
    },
  };
  const protection = await ecsTaskProtection(env, request);
  await expect(protection?.set(true)).resolves.toBeUndefined();
  response = {
    protection: {
      TaskArn: taskArn.replace("test-cluster/", "").replace("111111111111", "222222222222"),
      ProtectionEnabled: true,
      ExpirationDate: "2099-01-01T00:00:00Z",
    },
  };
  await expect(protection?.set(true)).rejects.toThrow("INVALID_RESPONSE");
  response = {
    protection: {
      TaskArn: taskArn.replace("test-cluster", "other-cluster"),
      ProtectionEnabled: true,
      ExpirationDate: "2099-01-01T00:00:00Z",
    },
  };
  await expect(protection?.set(true)).rejects.toThrow("INVALID_RESPONSE");
});
