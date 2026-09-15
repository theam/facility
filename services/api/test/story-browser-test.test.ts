import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { registerStoryWorkspaceRoutes } from "../src/routes/v1/story-workspaces.js";
import type { StoryDomain } from "../src/story-domain.js";
import type { AppConfig, Principal } from "../src/types.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(
  options: {
    configured?: boolean;
    prepared?: boolean;
    deleted?: boolean;
    authenticated?: boolean;
  } = {},
) {
  const app = Fastify();
  apps.push(app);
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => JSON.stringify);
  const workspace = {
    id: "ws-retained",
    externalRef: "provider-retained",
    volumeRef: "snapshot-retained",
    state: options.deleted ? "destroyed" : "running",
    setupChecksum: options.prepared === false ? null : "checksum-before-agent-commit",
    environment: { image: "runner:test" },
  };
  const domain = {
    stories: { get: vi.fn(async () => ({ story: { branch: "agent-changed-branch" }, workspace })) },
    projectManifests: {
      load: vi.fn(async () => ({
        environment: options.configured === false ? {} : { browser_test: "run-tests" },
      })),
    },
    credentials: { issue: vi.fn(async () => ({})) },
    environment: {
      prepare: vi.fn(async () => ({})),
      startPrepared: vi.fn(async () => ({})),
      runBrowserTest: vi.fn(async () => ({
        result: { exitCode: 0, durationMs: 10 },
        artifacts: [],
      })),
    },
  };
  app.decorate("storyDomain", domain as unknown as StoryDomain);
  app.decorateRequest("principal", undefined);
  if (options.authenticated !== false)
    app.addHook("onRequest", async (request) => {
      request.principal = { orgId: "org-current", type: "user", id: "user-current" } as Principal;
    });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send({ code: error.code });
    return reply.status(500).send({ code: "unexpected" });
  });
  await registerStoryWorkspaceRoutes(app, {} as AppConfig);
  const request = (action = "browser-test") =>
    app.inject({
      method: "POST",
      url: `/v1/projects/project-current/workspace-stories/story-current/environment/${action}`,
    });
  return { domain, request };
}

describe("browser test workspace lifecycle", () => {
  it("reuses preparation without synchronizing Git or recomputing the setup checksum", async () => {
    const { domain, request } = await fixture();
    expect((await request()).statusCode).toBe(200);
    expect(domain.environment.prepare).not.toHaveBeenCalled();
    expect(domain.environment.startPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        setupChecksum: "checksum-before-agent-commit",
        workspace: expect.objectContaining({ id: "ws-retained" }),
      }),
    );
    expect(domain.environment.runBrowserTest).toHaveBeenCalledOnce();
  });

  it.each([
    [{ configured: false }, "browser_test_not_configured", 409],
    [{ prepared: false }, "workspace_not_prepared", 409],
    [{ deleted: true }, "workspace_deleted", 409],
    [{ authenticated: false }, "unauthorized", 401],
  ] as const)("rejects unavailable tests before any workspace side effects: %j", async (options, code, status) => {
    const { domain, request } = await fixture(options);
    const response = await request();
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    expect(domain.credentials.issue).not.toHaveBeenCalled();
    expect(domain.environment.prepare).not.toHaveBeenCalled();
    expect(domain.environment.startPrepared).not.toHaveBeenCalled();
    expect(domain.environment.runBrowserTest).not.toHaveBeenCalled();
  });

  it("reserves reinitialization for the explicit Clean setup action", async () => {
    const { domain, request } = await fixture({ configured: false });
    expect((await request("clean-setup")).statusCode).toBe(200);
    expect(domain.environment.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ cleanSetup: true, branch: "agent-changed-branch" }),
    );
    expect(domain.environment.startPrepared).not.toHaveBeenCalled();
    expect(domain.environment.runBrowserTest).not.toHaveBeenCalled();
  });
});
