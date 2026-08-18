import { describe, expect, it } from "vitest";
import { type VercelSandboxClient, VercelSandboxDriver } from "../src/sandbox/vercel.js";

const credentials = {
  VERCEL_TOKEN: "vercel-test-token",
  VERCEL_TEAM_ID: "team_test",
  VERCEL_PROJECT_ID: "prj_test",
};

describe("VercelSandboxDriver", () => {
  it("launches the Facility runner in an ephemeral, project-bound sandbox", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);

    const launched = await driver.launch({
      runId: "run_vercel_agent",
      kind: "run",
      image: "facility-runner:stable",
      env: {
        RUNNER_TOKEN: "runner-secret",
        FACILITY_API_URL: "https://api.facility.example",
        FACILITY_GATEWAY_URL: "https://gateway.facility.example",
      },
      cpu: 3,
      memoryMb: 7_000,
      timeoutMin: 45,
      cmd: ["node", "/app/dist/index.js"],
      network: { egress: "restricted", allowed_domains: ["api.supabase.com"] },
    });

    expect(client.creates).toHaveLength(1);
    expect(client.creates[0]).toMatchObject({
      token: "vercel-test-token",
      teamId: "team_test",
      projectId: "prj_test",
      image: "facility-runner:stable",
      timeout: 300 * 60_000,
      resources: { vcpus: 4 },
      persistent: false,
      tags: { facility: "1", kind: "run" },
      networkPolicy: {
        allow: expect.arrayContaining([
          "api.facility.example",
          "gateway.facility.example",
          "api.supabase.com",
          "github.com",
          "registry.npmjs.org",
          "public.ecr.aws",
          "d2glxqk2uabbnd.cloudfront.net",
          "cdn.playwright.dev",
          "playwright.download.prss.microsoft.com",
          "storage.googleapis.com",
          "fonts.googleapis.com",
          "fonts.gstatic.com",
        ]),
        subnets: { deny: ["100.100.100.200/32", "169.254.0.0/16"] },
      },
    });
    expect(client.sandbox.runInputs).toEqual([
      {
        cmd: "/app/codebuild-runner.sh",
        args: ["node", "/app/dist/index.js"],
        cwd: "/work",
        env: {
          RUNNER_TOKEN: "runner-secret",
          FACILITY_API_URL: "https://api.facility.example",
          FACILITY_GATEWAY_URL: "https://gateway.facility.example",
          FACILITY_SANDBOX_PROVIDER: "vercel",
        },
        detached: true,
        timeoutMs: 300 * 60_000,
      },
    ]);
    expect(client.sandbox.updates[0]?.tags).toMatchObject({ command: "cmd-1" });
    expect(launched.ref).toMatch(/^v1\./);
    expect(launched.ref).not.toContain("vercel-test-token");
    expect(launched.ref).not.toContain("runner-secret");
  });

  it("exposes Vercel preview domains and requires an explicit command", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);
    const launched = await driver.launch({
      runId: "preview:sbx_1",
      kind: "preview",
      image: "preview-app:sha",
      env: { PORT: "3000" },
      cpu: 1,
      memoryMb: 1024,
      timeoutMin: 20,
      cmd: ["pnpm", "start"],
      network: { egress: "unrestricted" },
      servicePort: 3000,
    });

    expect(client.creates[0]).toMatchObject({
      ports: [3000],
      networkPolicy: {
        allow: ["*"],
        subnets: { deny: ["100.100.100.200/32", "169.254.0.0/16"] },
      },
    });
    expect(client.sandbox.runInputs[0]).toEqual({
      cmd: "pnpm",
      args: ["start"],
      env: { PORT: "3000" },
      detached: true,
      timeoutMs: 20 * 60_000,
    });
    expect(launched.endpoint).toBe("https://3000-facility-test.vercel.run");

    const noCommandClient = new FakeClient();
    await expect(
      new VercelSandboxDriver(noCommandClient, credentials).launch({
        runId: "preview:sbx_2",
        kind: "preview",
        image: "preview-app:sha",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 10,
        servicePort: 3000,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(noCommandClient.sandbox.deleted).toBe(true);
  });

  it("returns the live ref without waiting for Vercel's recovery-tag update", async () => {
    const client = new FakeClient();
    client.sandbox.updateGate = new Promise(() => undefined);
    const driver = new VercelSandboxDriver(client, credentials);

    const launched = await Promise.race([
      driver.launch(runSpec()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("launch waited for recovery tags")), 100),
      ),
    ]);

    expect(launched.ref).toMatch(/^v1\./);
    expect(client.sandbox.updates).toHaveLength(1);
  });

  it("uses the managed image alias instead of compiling its latest tag as custom VCR", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);
    await driver.launch({
      ...runSpec(),
      kind: "preview",
      image: "vercel/sandbox/universal:latest",
      cmd: ["node", "server.js"],
    });

    expect(client.creates[0]?.image).toBe("vercel/sandbox/universal");
  });

  it("maps command lifecycle, logs, signals, and idempotent deletion", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);
    const launched = await driver.launch(runSpec());

    client.sandbox.status = "pending";
    await expect(driver.status(launched.ref)).resolves.toBe("starting");
    client.sandbox.status = "running";
    await expect(driver.status(launched.ref)).resolves.toBe("running");
    client.sandbox.command.exitCode = 0;
    await expect(driver.status(launched.ref)).resolves.toBe("exited");
    client.sandbox.command.exitCode = null;
    client.sandbox.command.logEntries = [{ data: "first\nsecond\n" }, { data: "third" }];
    const lines: string[] = [];
    for await (const line of driver.logs(launched.ref, 1)) lines.push(line);
    expect(lines).toEqual(["second", "third"]);

    await driver.stop(launched.ref, { kill: true });
    expect(client.sandbox.command.signals).toEqual(["SIGKILL"]);
    expect(client.sandbox.stopped).toBe(true);
    await driver.destroy(launched.ref);
    expect(client.sandbox.deleted).toBe(true);

    client.getError = httpError(404);
    await expect(driver.destroy(launched.ref)).resolves.toBeUndefined();
    await expect(driver.status(launched.ref)).resolves.toBe("lost");
  });

  it("recovers only the matching Facility-owned launch", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);
    const launched = await driver.launch({
      ...runSpec(),
      runId: "preview:recover",
      servicePort: 3000,
    });

    await expect(
      driver.recoverLaunch({ runId: "preview:recover", servicePort: 3000 }),
    ).resolves.toEqual({
      ref: launched.ref,
      endpoint: "https://3000-facility-test.vercel.run",
    });

    client.sandbox.tags = { ...client.sandbox.tags, run: "foreign" };
    await expect(
      driver.recoverLaunch({ runId: "preview:recover", servicePort: 3000 }),
    ).resolves.toBeUndefined();
  });

  it("fails closed for missing credentials, malformed refs, and foreign name collisions", async () => {
    const client = new FakeClient();
    const unconfigured = new VercelSandboxDriver(client, { VERCEL_TOKEN: "token" });
    await expect(unconfigured.launch(runSpec())).rejects.toMatchObject({ code: "not_configured" });
    expect(client.creates).toHaveLength(0);

    const driver = new VercelSandboxDriver(client, credentials);
    await expect(driver.status("not-a-ref")).rejects.toMatchObject({ code: "invalid_ref" });
    expect(client.gets).toHaveLength(0);

    client.createError = httpError(409);
    client.sandbox.tags = { facility: "1", run: "another-run", kind: "run" };
    await expect(driver.launch(runSpec())).rejects.toMatchObject({
      code: "invalid_provider_config",
    });
    expect(client.sandbox.deleted).toBe(false);
  });

  it("rejects malformed restricted network configuration before contacting Vercel", async () => {
    const client = new FakeClient();
    const driver = new VercelSandboxDriver(client, credentials);
    await expect(
      driver.launch({ ...runSpec(), network: { egress: "restricted", allowed_domains: ["*"] } }),
    ).rejects.toMatchObject({ code: "invalid_provider_config" });
    expect(client.creates).toHaveLength(0);
  });
});

function runSpec() {
  return {
    runId: "run_test",
    kind: "run" as const,
    image: "facility-runner:test",
    env: {},
    cpu: 2,
    memoryMb: 4096,
    timeoutMin: 30,
  };
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

class FakeCommand {
  cmdId = "cmd-1";
  exitCode: number | null = null;
  logEntries: Array<{ data: string }> = [];
  signals: string[] = [];

  async *logs() {
    for (const entry of this.logEntries) yield entry;
  }

  async wait() {
    if (this.exitCode === null)
      throw Object.assign(new Error("still running"), { name: "TimeoutError" });
    return { exitCode: this.exitCode };
  }

  async kill(signal = "SIGTERM") {
    this.signals.push(signal);
  }
}

class FakeSandbox {
  name = "facility-test";
  status: "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting" =
    "running";
  tags: Record<string, string> = {};
  command = new FakeCommand();
  runInputs: unknown[] = [];
  updates: Array<{ tags: Record<string, string> }> = [];
  updateGate?: Promise<void>;
  stopped = false;
  deleted = false;

  async runCommand(input: unknown) {
    this.runInputs.push(input);
    return this.command;
  }

  async getCommand(commandId: string) {
    if (commandId !== this.command.cmdId) throw httpError(404);
    return this.command;
  }

  domain(port: number) {
    return `https://${port}-facility-test.vercel.run`;
  }

  async update(input: { tags: Record<string, string> }) {
    this.updates.push(input);
    await this.updateGate;
    this.tags = input.tags;
  }

  async stop() {
    this.stopped = true;
    this.status = "stopped";
    return {};
  }

  async delete() {
    this.deleted = true;
  }
}

class FakeClient implements VercelSandboxClient {
  sandbox = new FakeSandbox();
  creates: Array<Parameters<VercelSandboxClient["create"]>[0]> = [];
  gets: Array<Parameters<VercelSandboxClient["get"]>[0]> = [];
  createError?: Error;
  getError?: Error;

  async create(input: Parameters<VercelSandboxClient["create"]>[0]) {
    this.creates.push(input);
    if (this.createError) throw this.createError;
    this.sandbox.name = input.name;
    this.sandbox.tags = input.tags;
    return this.sandbox;
  }

  async get(input: Parameters<VercelSandboxClient["get"]>[0]) {
    this.gets.push(input);
    if (this.getError) throw this.getError;
    return this.sandbox;
  }
}
