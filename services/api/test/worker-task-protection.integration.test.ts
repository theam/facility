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
  server = createServer(async (req, res) => {
    if (req.url === "/rollout") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ terminated: !protectedTask }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v4/test/task") return void res.end(JSON.stringify({ TaskARN: taskArn }));
    res.statusCode = status;
    if (status === 200 && response === undefined) protectedTask = body.ProtectionEnabled === true;
    res.end(
      JSON.stringify(
        response !== undefined
          ? response
          : {
              protection: {
                TaskArn: taskArn,
                ProtectionEnabled: body.ProtectionEnabled,
                ExpirationDate: new Date(Date.now() + 120 * 60_000).toISOString(),
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
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
    expect(last).toEqual({ ProtectionEnabled: true, ExpiresInMinutes: 120 });
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
  await expect(protection?.set(true)).rejects.toThrow("not confirmed");
  response = {
    protection: {
      TaskArn: taskArn.replace("test-cluster", "other-cluster"),
      ProtectionEnabled: true,
      ExpirationDate: "2099-01-01T00:00:00Z",
    },
  };
  await expect(protection?.set(true)).rejects.toThrow("not confirmed");
});
