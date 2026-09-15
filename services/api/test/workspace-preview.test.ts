import type { FacilityDb } from "@facility/db";
import { describe, expect, it, vi } from "vitest";
import type { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import type { AppConfig } from "../src/types.js";
import { WorkspacePreviewService } from "../src/workspaces/preview.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";

const manifest = parseProjectManifest(`
repositories:
  primary: github.com/acme/app
environment:
  setup: reset-database
  start: start-app
  ready: check-app
  services:
    app:
      port: 3000
`);
const credentials = {
  gitIdentity: { name: "my-app[bot]", email: "12345+my-app[bot]@users.noreply.github.com" },
  repositories: [{ owner: "acme", name: "app", defaultBranch: "main", role: "primary" as const }],
  environment: {},
  expiresAt: new Date(Date.now() + 60_000),
};
const input = {
  orgId: "org_test",
  projectId: "proj_test",
  storyId: "story_test",
  userId: "user_test",
  service: "app",
};

function fixture(state: string, setupChecksum: string | null) {
  const story = { id: input.storyId, branch: "facility/story-test", deletedAt: null };
  const workspace = {
    id: "ws_test",
    state,
    setupChecksum,
    externalRef: "compute-test",
    volumeRef: "retained-volume",
    environment: { image: "runner:test" },
  };
  const rows = [story, workspace];
  const insert = vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [rows.shift()] }) }),
    })),
    insert,
  } as unknown as FacilityDb;
  const runtime = { wake: vi.fn().mockResolvedValue({ state: "running" }) };
  const result = { endpoints: [{ service: "app", port: 3000, url: "http://127.0.0.1:3000" }] };
  const environment = {
    prepare: vi.fn().mockResolvedValue(result),
    startPrepared: vi.fn().mockResolvedValue(result),
  };
  const service = new WorkspacePreviewService(
    db,
    {
      publicUrl: "https://api.example.com",
      previewUrl: "https://preview.example.net",
    } as AppConfig,
    runtime as unknown as WorkspaceRuntime,
    { issue: async () => credentials } as unknown as GithubWorkspaceCredentialBroker,
    { load: async () => manifest },
    environment as unknown as ProjectEnvironmentService,
  );
  return { service, environment, runtime, insert, workspace, db };
}

describe("preview workspace preparation", () => {
  it.each([
    "running",
    "sleeping",
  ])("reuses the prepared %s workspace and checksum", async (state) => {
    const f = fixture(state, "prepared-at-original-commit");
    await f.service.open(input);
    expect(f.runtime.wake).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.workspace.id, volumeRef: "retained-volume" }),
    );
    expect(f.environment.prepare).not.toHaveBeenCalled();
    expect(f.environment.startPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ id: f.workspace.id, volumeRef: "retained-volume" }),
        setupChecksum: "prepared-at-original-commit",
      }),
    );
    expect(f.insert).toHaveBeenCalledOnce();
  });

  it("prepares a workspace that has never completed setup", async () => {
    const f = fixture("running", null);
    await f.service.open(input);
    expect(f.environment.startPrepared).not.toHaveBeenCalled();
    expect(f.environment.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "facility/story-test" }),
    );
  });

  it.each(["wake", "startPrepared"])("does not mint a session when %s fails", async (phase) => {
    const f = fixture("sleeping", "prepared");
    const error = new Error("workspace unavailable");
    (phase === "wake" ? f.runtime.wake : f.environment.startPrepared).mockRejectedValue(error);
    await expect(f.service.open(input)).rejects.toBe(error);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.environment.prepare).not.toHaveBeenCalled();
  });

  it("does not mint a session for an undeclared service", async () => {
    const f = fixture("running", "prepared");
    await expect(f.service.open({ ...input, service: "other" })).rejects.toMatchObject({
      code: "preview_service_not_found",
    });
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("never writes a preview's previously read setup checksum back to the workspace", async () => {
    const set = vi.fn((_values: Record<string, unknown>) => ({
      where: () => ({ returning: async () => [{ nextEventSeq: 1 }] }),
    }));
    const db = {
      update: () => ({ set }),
      insert: () => ({ values: async () => undefined }),
    } as unknown as FacilityDb;
    const runtime = {
      exec: async () => ({ exitCode: 0 }),
      expose: async () => [{ service: "app", port: 3000, url: "http://127.0.0.1:3000" }],
    } as unknown as WorkspaceRuntime;
    await new ProjectEnvironmentService(db, runtime).startPrepared({
      orgId: input.orgId,
      projectId: input.projectId,
      workspace: {
        id: "ws_test",
        image: "runner:test",
        externalRef: "compute-test",
        volumeRef: "retained-volume",
      },
      manifest,
      credentials,
      setupChecksum: "stale-checksum",
    });
    expect(set).toHaveBeenCalled();
    for (const [update] of set.mock.calls) expect(update).not.toHaveProperty("setupChecksum");
  });

  it("validates repository scope and required environment before touching prepared services", async () => {
    const exec = vi.fn();
    const f = fixture("running", "prepared");
    const environment = new ProjectEnvironmentService(
      f.db,
      { exec } as unknown as WorkspaceRuntime,
      undefined,
      () => undefined,
    );
    const base = {
      ...input,
      workspace: {
        id: "ws_test",
        image: "runner:test",
        externalRef: "compute-test",
        volumeRef: "retained-volume",
      },
      manifest,
      credentials,
      setupChecksum: "prepared",
    };
    await expect(
      environment.startPrepared({ ...base, credentials: { ...credentials, repositories: [] } }),
    ).rejects.toMatchObject({ code: "project_repository_mismatch" });
    await expect(
      environment.startPrepared({
        ...base,
        manifest: {
          ...manifest,
          environment: { ...manifest.environment, secrets: ["DATABASE_URL"] },
        },
      }),
    ).rejects.toMatchObject({ code: "project_environment_missing" });
    expect(exec).not.toHaveBeenCalled();
  });
});

/**
 * A preview session outlives the request that opened it, so `authorize` re-reads
 * the opening permission on every use. These drive that read directly: the
 * integration suite covers the same ground against Postgres, and skips itself
 * when Postgres is unreachable.
 */
function accessFixture(permissions: string[] | undefined) {
  const session = {
    id: "psess_0123456789abcdef",
    orgId: input.orgId,
    projectId: input.projectId,
    storyId: input.storyId,
    userId: input.userId,
    workspaceId: "ws_test",
    service: input.service,
  };
  // `authorize` reads the session first, then `assertPreviewAccess` reads the
  // member row behind it. `undefined` stands for no active membership at all.
  const rows = [session, permissions ? { permissions } : undefined];
  const chain = () => {
    const step = {
      from: () => step,
      innerJoin: () => step,
      where: () => step,
      limit: async () => {
        const row = rows.shift();
        return row ? [row] : [];
      },
    };
    return step;
  };
  const db = { select: vi.fn(chain) } as unknown as FacilityDb;
  const service = new WorkspacePreviewService(
    db,
    {
      publicUrl: "https://api.example.com",
      previewUrl: "https://preview.example.net",
    } as AppConfig,
    { wake: vi.fn() } as unknown as WorkspaceRuntime,
    { issue: async () => credentials } as unknown as GithubWorkspaceCredentialBroker,
    { load: async () => manifest },
    {} as unknown as ProjectEnvironmentService,
  );
  return { service, session };
}

describe("preview session authorization", () => {
  it("authorizes a session whose role still grants workspace execution", async () => {
    const f = accessFixture(["workspaces:execute"]);
    await expect(f.service.authorize(f.session.id, "token")).resolves.toMatchObject({
      storyId: input.storyId,
    });
  });

  it.each([["workspaces:*"], ["*"]])("accepts the %s wildcard grant", async (grant) => {
    const f = accessFixture([grant]);
    await expect(f.service.authorize(f.session.id, "token")).resolves.toMatchObject({
      storyId: input.storyId,
    });
  });

  it("denies a session whose role lost workspace execution", async () => {
    // Membership and user stay active; only the permission is gone. Reading the
    // row and not reading its permissions is what let a demoted member keep
    // proxying into a live workspace for the rest of the session's hour.
    const f = accessFixture(["previews:read"]);
    await expect(f.service.authorize(f.session.id, "token")).rejects.toMatchObject({
      code: "preview_access_invalid",
      statusCode: 401,
    });
  });

  it("denies a session with no active membership behind it", async () => {
    const f = accessFixture(undefined);
    await expect(f.service.authorize(f.session.id, "token")).rejects.toMatchObject({
      code: "preview_access_invalid",
    });
  });
});
