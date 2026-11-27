import type { FacilityDb } from "@facility/db";
import { describe, expect, it, vi } from "vitest";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";

describe("repository identity during transactional session preparation", () => {
  const db = {} as FacilityDb;
  const tx = {} as FacilityDb;
  const input = {
    orgId: "org_fixture",
    projectId: "proj_fixture",
    workspace: {
      id: "ws_fixture",
      image: "facility-runner:test",
      externalRef: "fixture",
      volumeRef: "fixture",
    },
    branch: "feature/fixture",
    manifest: parseProjectManifest(
      "version: 1\nrepositories:\n  primary: github.com/acme/app\nenvironment:\n  start: node server.js",
    ),
    credentials: {
      repositories: [
        {
          owner: "acme",
          name: "app",
          role: "primary",
          defaultBranch: "main",
          githubRepositoryId: 123,
          installationNumber: 456,
        },
      ],
      environment: {},
      expiresAt: new Date(),
      gitIdentity: { name: "fixture[bot]", email: "fixture@example.test" },
    } as GithubWorkspaceCredentials,
  };
  const client = (id: number) =>
    ({ rest: { repos: { get: vi.fn(async () => ({ data: { id } })) } } }) as unknown as Octokit;

  it("retains the configured identity verifier and transaction before executing workspace commands", async () => {
    const factory = vi.fn<GithubClientFactory>(async () => client(123));
    const values = vi.fn(async () => ({}));
    const exec = vi.fn(async () => {
      throw new Error("fixture command boundary");
    });
    const environment = new ProjectEnvironmentService(
      db,
      { exec } as unknown as WorkspaceRuntime,
      undefined,
      undefined,
      values,
      factory,
    );
    await expect(environment.prepare(input, tx)).rejects.toThrow("fixture command boundary");
    expect(factory).toHaveBeenCalledWith(456, 123, tx);
    expect(values).toHaveBeenCalledWith(
      { orgId: input.orgId, projectId: input.projectId, workspaceId: input.workspace.id },
      tx,
    );
    expect(exec).toHaveBeenCalledOnce();
  });

  it("denies a replaced repository or missing verifier before any workspace execution", async () => {
    const exec = vi.fn();
    const runtime = { exec } as unknown as WorkspaceRuntime;
    const factory: GithubClientFactory = async () => client(999);
    for (const [verifier, code] of [
      [factory, "repository_identity_changed"],
      [undefined, "repository_identity_unavailable"],
    ] as const) {
      const environment = new ProjectEnvironmentService(
        db,
        runtime,
        undefined,
        undefined,
        undefined,
        verifier,
      );
      await expect(environment.prepare(input, tx)).rejects.toMatchObject({ code });
    }
    expect(exec).not.toHaveBeenCalled();
  });
});
