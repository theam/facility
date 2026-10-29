import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCredentialRenewal } from "../src/github/workspace-credential-renewal.js";
import {
  GithubWorkspaceCredentialError,
  type GithubWorkspaceCredentials,
} from "../src/github/workspace-credentials.js";
import type {
  WorkspaceCommand,
  WorkspaceLocator,
  WorkspaceRuntime,
} from "../src/workspaces/runtime.js";

function credential(token = "synthetic-current"): GithubWorkspaceCredentials {
  return {
    repositories: [{ owner: "acme", name: "app", defaultBranch: "main", role: "primary" }],
    gitIdentity: { name: "bot", email: "bot@example.com" },
    expiresAt: new Date(Date.now() + 3_600_000),
    environment: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": token }),
    },
  };
}
function setup() {
  const exec = vi.fn(async (_workspace: WorkspaceLocator, _command: WorkspaceCommand) => ({
    exitCode: 0,
    stdout: JSON.stringify({
      root: "/workspace/.facility/github/turn_test",
      bin: "/workspace/.facility/github/turn_test/bin",
      helper: "!node helper",
      originalPath: "/usr/bin",
    }),
    stderr: "",
    durationMs: 1,
  }));
  const issue = vi.fn(async () => credential("synthetic-renewed"));
  const authorized = vi.fn(async () => true);
  const rememberSecrets = vi.fn();
  const report = vi.fn(async () => undefined);
  const revoked = vi.fn();
  const renewal = new WorkspaceCredentialRenewal(
    { exec } as unknown as WorkspaceRuntime,
    {} as WorkspaceLocator,
    "turn_test",
    credential(),
    { issue, authorized, rememberSecrets, report, revoked },
  );
  return { renewal, exec, issue, authorized, rememberSecrets, report, revoked };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("native workspace credential renewal", () => {
  it("renews before each hourly expiry through a three-hour turn", async () => {
    const s = setup();
    await s.renewal.start();
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(s.issue).toHaveBeenCalledTimes(3);
    expect(s.authorized).toHaveBeenCalledTimes(7);
    const updates = s.exec.mock.calls.filter(
      ([, _command]) => _command?.env?.FACILITY_CREDENTIAL_ROOT,
    );
    expect(updates).toHaveLength(3);
    expect(s.rememberSecrets).toHaveBeenCalledWith(["synthetic-renewed"]);
    await s.renewal.stop();
  });
  it("makes gh config renewable even when a child resets PATH", async () => {
    const s = setup();
    await s.renewal.start();
    const env = s.renewal.environment(
      { GH_TOKEN: "stale", GITHUB_TOKEN: "stale", OTHER: "preserved" },
      true,
    );
    expect(env.GH_TOKEN).toBe("");
    expect(env.GITHUB_TOKEN).toBe("");
    expect(env.GH_CONFIG_DIR).toBe("/workspace/.facility/github/turn_test/gh");
    expect(env.OTHER).toBe("preserved");
    await s.renewal.stop();
  });
  it("coalesces refresh and waits for it before removing credentials", async () => {
    const s = setup();
    let finish!: (value: GithubWorkspaceCredentials) => void;
    s.issue.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await s.renewal.start();
    const first = s.renewal.renew();
    expect(s.renewal.renew()).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    const stop = s.renewal.stop();
    finish(credential("late-token"));
    await Promise.all([first, stop]);
    expect(s.issue).toHaveBeenCalledTimes(1);
    expect(s.exec).toHaveBeenCalledTimes(2); // install and cleanup, no late write
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(s.issue).toHaveBeenCalledTimes(1);
  });
  it("does not issue credentials after execution authorization is revoked", async () => {
    const s = setup();
    await s.renewal.start();
    s.authorized.mockResolvedValue(false);
    await s.renewal.renew();
    expect(s.issue).not.toHaveBeenCalled();
    expect(s.revoked).toHaveBeenCalledTimes(1);
    expect(s.report).toHaveBeenCalledWith("revoked");
    await s.renewal.stop();
  });
  it("revalidates authorization after issuance before workspace delivery", async () => {
    const s = setup();
    await s.renewal.start();
    s.authorized.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await s.renewal.renew();
    expect(s.revoked).toHaveBeenCalledTimes(1);
    expect(
      s.exec.mock.calls.filter(([, command]) => command?.env?.FACILITY_CREDENTIAL_PAYLOAD),
    ).toHaveLength(1);
    await s.renewal.stop();
  });
  it("refuses repository expansion instead of widening a running turn", async () => {
    const s = setup();
    await s.renewal.start();
    const expanded = credential();
    expanded.repositories.push({
      owner: "other",
      name: "private",
      defaultBranch: "main",
      role: "related",
    });
    s.issue.mockResolvedValue(expanded);
    await s.renewal.renew();
    expect(s.revoked).toHaveBeenCalledTimes(1);
    await s.renewal.stop();
  });
  it("retries transient issuance failure without recording secrets or raw errors", async () => {
    const s = setup();
    await s.renewal.start();
    s.issue.mockRejectedValueOnce(new Error("synthetic-secret-provider-error"));
    await s.renewal.renew();
    expect(s.report).toHaveBeenCalledWith("retrying");
    expect(JSON.stringify(s.report.mock.calls)).not.toContain("synthetic-secret");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.issue).toHaveBeenCalledTimes(2);
    expect(s.report).toHaveBeenCalledWith("renewed");
    await s.renewal.stop();
  });
  it("stops on revoked installation rather than retrying with broader credentials", async () => {
    const s = setup();
    await s.renewal.start();
    s.issue.mockRejectedValue(
      new GithubWorkspaceCredentialError("github_installation_unavailable", "private detail"),
    );
    await s.renewal.renew();
    expect(s.revoked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.issue).toHaveBeenCalledTimes(1);
    await s.renewal.stop();
  });
  it.each([
    "expired",
    "invalid-map",
    "newline-token",
  ])("rejects %s initial credentials", async (kind) => {
    const initial = credential();
    if (kind === "expired") initial.expiresAt = new Date(Date.now() - 1);
    if (kind === "invalid-map") initial.environment.FACILITY_GITHUB_CREDENTIALS = "null";
    if (kind === "newline-token")
      initial.environment.FACILITY_GITHUB_CREDENTIALS = JSON.stringify({
        "acme/app": "token\npassword=bad",
      });
    const s = setup();
    const renewal = new WorkspaceCredentialRenewal(
      { exec: s.exec } as unknown as WorkspaceRuntime,
      {} as WorkspaceLocator,
      "turn_test",
      initial,
      {
        issue: s.issue,
        authorized: s.authorized,
        rememberSecrets: s.rememberSecrets,
        report: s.report,
        revoked: s.revoked,
      },
    );
    await expect(renewal.start()).rejects.toBeInstanceOf(GithubWorkspaceCredentialError);
    expect(s.exec).not.toHaveBeenCalled();
  });
});
