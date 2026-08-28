import { execFileSync, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeCodeArgs,
  buildCodexArgs,
  claudeDeliverySettings,
  composedPrompt,
  createWorkspaceCheckpoint,
  deliveryCliMain,
  deliveryHookDecision,
  deliveryReleaseImpact,
  deliveryStatusEvent,
  deliverySystemPrompt,
  emitEngineEventsBestEffort,
  engineEnv,
  engineResultError,
  exitCode,
  githubRequest,
  gitOutput,
  handleControlMessage,
  parseGitNameStatus,
  preparedWorkspaceBaseSha,
  prepareWorkspace,
  privateRegistryInstallCommand,
  privateRegistryNpmrc,
  publishVerifiedGithubBranchUpdate,
  publishVerifiedGithubChanges,
  readAgentDeliveryMetadata,
  readAgentProgress,
  readAgentUpdateMetadata,
  readOnlyEngineProgress,
  readSecurityReport,
  requiresAgentProgress,
  restoreWorkspaceCheckpoint,
  resumeContinuationPrompt,
  resumeRecoveryPrompt,
  runnerReceiptActivity,
  runPackageInstall,
  semanticDeliveryBranch,
  terminateChild,
  trustClaudeWorkspace,
  writeAgentDeliveryReceipt,
} from "../src/index.js";
import type { RunBundle } from "../src/types.js";

function bundle(overrides: Partial<RunBundle> = {}): RunBundle {
  return {
    runId: "run_test",
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

describe("workspace preparation", () => {
  it("writes scoped Claude trust without following an untrusted config symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-claude-trust-"));
    const repo = join(root, "repo");
    const protectedPath = join(root, "protected");
    await mkdir(repo);
    await writeFile(protectedPath, "do not replace\n");
    await symlink(protectedPath, join(root, ".claude.json"));
    const identity = {
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    };

    const configPath = await trustClaudeWorkspace(repo, root, identity);

    await expect(readFile(protectedPath, "utf8")).resolves.toBe("do not replace\n");
    await expect(readFile(configPath, "utf8").then(JSON.parse)).resolves.toEqual({
      projects: { [await realpath(repo)]: { hasTrustDialogAccepted: true } },
    });
    const info = await lstat(configPath);
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.uid).toBe(identity.uid);
    expect(info.gid).toBe(identity.gid);
  });

  it("fails closed when an untrusted process occupies the config path with a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-claude-trust-denied-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(root, ".claude.json"));

    await expect(trustClaudeWorkspace(repo, root, {})).rejects.toThrow();
    expect((await lstat(join(root, ".claude.json"))).isDirectory()).toBe(true);
  });

  it("never exposes package registry credentials to the engine environment", () => {
    const original = process.env.NODE_AUTH_TOKEN;
    const originalUpperConfig = process.env.NPM_CONFIG_USERCONFIG;
    const originalLowerConfig = process.env.npm_config_userconfig;
    process.env.NODE_AUTH_TOKEN = "package-token-for-test";
    process.env.NPM_CONFIG_USERCONFIG = "/tmp/facility-upper-npmrc";
    process.env.npm_config_userconfig = "/tmp/facility-lower-npmrc";
    try {
      expect(engineEnv().NODE_AUTH_TOKEN).toBeUndefined();
      expect(engineEnv().NPM_CONFIG_USERCONFIG).toBeUndefined();
      expect(engineEnv().npm_config_userconfig).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = original;
      if (originalUpperConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
      else process.env.NPM_CONFIG_USERCONFIG = originalUpperConfig;
      if (originalLowerConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = originalLowerConfig;
    }
  });

  it("limits private registry credentials to deterministic install commands", () => {
    expect(privateRegistryInstallCommand("pnpm install --frozen-lockfile")).toBe(true);
    expect(privateRegistryInstallCommand("npm ci")).toBe(true);
    expect(privateRegistryInstallCommand("pnpm install && curl example.com")).toBe(false);
  });

  it("creates a user-level npm config for the private package install only", () => {
    expect(privateRegistryNpmrc("github-package-token")).toBe(
      "//npm.pkg.github.com/:_authToken=github-package-token\n",
    );
    expect(() => privateRegistryNpmrc("token\nmalicious=true")).toThrow(
      "package_registry_token_invalid",
    );
  });

  it("scopes the package token to the install child and removes the npmrc", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-package-install-"));
    const capturePath = join(root, "captured.json");
    const npmrcPath = join(root, "install.npmrc");
    const script = [
      "const fs=require('node:fs')",
      `const npmrc=process.env.NPM_CONFIG_USERCONFIG`,
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({token:process.env.NODE_AUTH_TOKEN,npmrc,contents:fs.readFileSync(npmrc,'utf8'),mode:fs.statSync(npmrc).mode & 0o777}))`,
    ].join(";");

    await expect(
      runPackageInstall(
        `node -e ${JSON.stringify(script)}`,
        root,
        1,
        "github-package-token",
        npmrcPath,
      ),
    ).resolves.toBe(0);
    await expect(readFile(capturePath, "utf8").then(JSON.parse)).resolves.toEqual({
      token: "github-package-token",
      npmrc: npmrcPath,
      contents: "//npm.pkg.github.com/:_authToken=github-package-token\n",
      mode: 0o600,
    });
    await expect(readFile(npmrcPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the private npmrc after an install failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-package-install-failure-"));
    const npmrcPath = join(root, "install.npmrc");
    await expect(
      runPackageInstall("node -e 'process.exit(7)'", root, 1, "github-package-token", npmrcPath),
    ).resolves.toBe(7);
    await expect(readFile(npmrcPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves repository-owned skills when Facility has the same skill name", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const source = await mkdtemp(join(tmpdir(), "facility-repo-"));
    await mkdir(join(source, ".claude", "skills", "team-practice"), { recursive: true });
    await writeFile(
      join(source, ".claude", "skills", "team-practice", "SKILL.md"),
      "# Repository-owned practice\n",
    );
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Facility Test",
        "-c",
        "user.email=test@facility.local",
        "commit",
        "-m",
        "test: seed",
      ],
      { cwd: source },
    );

    await prepareWorkspace(
      bundle({
        repo: {
          cloneUrl: `file://${source}`,
          branch: "main",
          expectedHeadSha: null,
          installationTokenRef: null,
        },
        skills: [{ name: "team-practice", content: "# Facility catalog practice" }],
      }),
      "virtual-key",
      {
        platformKey: null,
        platformApiUrl: "https://api.test",
        projectId: "proj_test",
        repoToken: null,
      },
      root,
    );

    await expect(
      readFile(join(root, "repo", ".claude", "skills", "team-practice", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Repository-owned practice\n");
    await expect(
      readFile(join(root, "repo", ".agents", "skills", "team-practice", "SKILL.md"), "utf8"),
    ).resolves.toContain("Facility catalog practice");
  });

  it("rejects a repair clone whose head differs from deterministic admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-stale-head-"));
    const source = await mkdtemp(join(tmpdir(), "facility-stale-repo-"));
    await writeFile(join(source, "README.md"), "# Current head\n");
    execFileSync("git", ["init", "--initial-branch=feature/repair"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Facility Test",
        "-c",
        "user.email=test@facility.local",
        "commit",
        "-m",
        "test: seed stale repair fixture",
      ],
      { cwd: source },
    );

    await expect(
      prepareWorkspace(
        bundle({
          mode: "ci_doctor",
          repo: {
            cloneUrl: `file://${source}`,
            branch: "feature/repair",
            expectedHeadSha: "a".repeat(40),
            installationTokenRef: null,
          },
        }),
        "virtual-key",
        {
          platformKey: null,
          platformApiUrl: "https://api.test",
          projectId: "proj_test",
          repoToken: null,
        },
        root,
      ),
    ).rejects.toThrow("repository_head_sha_mismatch");
    await expect(lstat(join(root, "repo", ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps runner release classification aligned with the root policy", async () => {
    const rootPolicy = (await import(
      new URL("../../scripts/conventional-commit-subjects.mjs", import.meta.url).href
    )) as { releaseImpact(message: string): string };
    const messages = [
      ...[
        "feat",
        "fix",
        "perf",
        "revert",
        "docs",
        "style",
        "refactor",
        "test",
        "build",
        "ci",
        "chore",
      ].map((type) => `${type}: describe the change`),
      "docs!: replace the contract",
      "docs: replace the contract\n\nBREAKING CHANGE: migrate the client",
      "docs: replace the contract\n\nRefs: #42\ncontext for the reference\nBREAKING-CHANGE: migrate the client\nCloses #123",
      "docs: quote output\n\nThe tool printed:\nBREAKING CHANGE: example text",
      "docs: show a fence\n\n```text\nBREAKING CHANGE: example text\n```",
      "docs: missing separator\nBREAKING CHANGE: example text",
      "docs: malformed trailer\n\nBREAKING CHANGE:\texample text",
    ];

    for (const message of messages) {
      expect(deliveryReleaseImpact(message), message).toBe(rootPolicy.releaseImpact(message));
    }
  });

  it("accepts only a bounded structured security findings artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "security-findings.json");
    await writeFile(
      path,
      JSON.stringify({
        schema: "facility.security.findings.v1",
        findings: [
          {
            fingerprint: "auth-bypass",
            title: "Authorization bypass",
            severity: "high",
            confidence: "high",
            actionable: true,
            risk: "Reachable privileged path",
            locations: ["src/admin.ts:4"],
            smallest_fix: "Apply the shared guard",
            evidence: [],
          },
        ],
        dismissed: [],
        scanners_not_enabled: [],
      }),
    );
    await expect(readSecurityReport(path)).resolves.toMatchObject({
      schema: "facility.security.findings.v1",
    });
    await writeFile(path, JSON.stringify({ schema: "wrong", findings: [] }));
    await expect(readSecurityReport(path)).resolves.toBeNull();
  });

  it("observes a child exit even when close happened before the waiter was attached", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    await expect(exitCode(child)).resolves.toBe(0);
  });

  it("writes harness files into the workspace and points the prompt at SESSION.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const runBundle = bundle({
      skills: [{ name: "validation evidence", content: "# Validation evidence" }],
      harness: {
        files: {
          "harness/SESSION.md": "# Session",
          "harness/CHARTER.md": "# Charter",
        },
      },
    });

    await prepareWorkspace(
      runBundle,
      "virtual-key",
      {
        platformKey: null,
        platformApiUrl: "https://api.test",
        projectId: "proj_test",
        repoToken: null,
      },
      root,
    );

    await expect(readFile(join(root, "scratch", "harness", "SESSION.md"), "utf8")).resolves.toBe(
      "# Session",
    );
    await expect(readFile(join(root, "scratch", "harness", "CHARTER.md"), "utf8")).resolves.toBe(
      "# Charter",
    );
    await expect(
      readFile(
        join(root, "scratch", ".agents", "skills", "validation_evidence", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain(
      '---\nname: "validation_evidence"\ndescription: "Project-managed Facility skill: validation evidence"\n---\n\n# Validation evidence',
    );
    expect(composedPrompt(runBundle)).toContain(
      "Project harness/KB context is in ./harness/SESSION.md - read it first.",
    );
    expect(composedPrompt(bundle())).not.toContain("./harness/SESSION.md");
    expect(composedPrompt(bundle())).toContain(".agent-sdlc/progress.md");
    expect(composedPrompt(bundle({ mode: "custom" }))).not.toContain(".agent-sdlc/progress.md");
    expect(composedPrompt(bundle())).toContain(".agent-sdlc/delivery.json");
    expect(composedPrompt(bundle())).toContain("same release impact");
    expect(composedPrompt(bundle())).toContain("BREAKING CHANGE:");
    expect(composedPrompt(bundle({ mode: "address_review" }))).toContain(
      "release impact is no greater than the existing pull request range",
    );
    expect(composedPrompt(bundle({ mode: "ci_doctor" }))).toContain(
      "do not add `!` or a `BREAKING CHANGE:` footer unless that range is already breaking",
    );
    expect(composedPrompt(bundle({ mode: "address_review" }))).toContain(
      "PR title must be updated first",
    );
    expect(composedPrompt(bundle({ mode: "architect" }))).not.toContain(
      ".agent-sdlc/delivery.json",
    );
    expect(
      composedPrompt(
        bundle({
          repo: {
            cloneUrl: "https://github.com/acme/widget.git",
            branch: "main",
            expectedHeadSha: null,
            installationTokenRef: "installation",
          },
        }),
      ),
    ).toContain("Never emit sandbox-local paths");
    expect(composedPrompt(bundle())).not.toContain("Never emit sandbox-local paths");
    expect(
      composedPrompt(
        bundle({ skills: [{ name: "validation evidence", content: "# Validation evidence" }] }),
      ),
    ).toContain(".agents/skills/validation_evidence/SKILL.md");
    expect(
      composedPrompt(
        bundle({ mode: "review", scope: { type: "github_event", deliveryContext: {} } }),
      ),
    ).toContain("sandbox clone credential is intentionally contents-only");
  });

  it("validates agent-owned branch, commit, and pull request metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "delivery.json");
    await writeFile(
      path,
      JSON.stringify({
        branch: "feature/2-integer-subtraction",
        commitMessage: "feat: add integer subtraction",
        pullRequest: {
          title: "feat: add integer subtraction",
          body: "## Summary\n- Add subtraction.\n\n## Verification\n- `pnpm test`",
        },
      }),
    );

    await expect(readAgentDeliveryMetadata(path)).resolves.toMatchObject({
      branch: "feature/2-integer-subtraction",
      commitMessage: "feat: add integer subtraction",
    });
    await writeFile(
      path,
      JSON.stringify({
        branch: "facility/run-123",
        commitMessage: "generic message",
        pullRequest: { title: "Builder result", body: "Result" },
      }),
    );
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow("branch_not_semantic");
  });

  it("rejects invented delivery fields instead of silently accepting a nearby schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "delivery.json");
    await writeFile(
      path,
      JSON.stringify({
        issue: "acme/widget#2",
        branch: "feature/2-integer-subtraction",
        commit: { message: "feat: add integer subtraction" },
        pullRequest: {
          title: "feat: add integer subtraction",
          body: "## Summary\n- Add subtraction.",
        },
      }),
    );

    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow(
      "agent_delivery_metadata_shape_invalid",
    );
  });

  it("writes the exact governed receipt shape through the runner-owned writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, ".agent-sdlc", "delivery.json");

    await expect(
      writeAgentDeliveryReceipt(path, "builder", {
        branch: "feature/2-integer-subtraction",
        commitMessage: "feat: add integer subtraction",
        pullRequest: {
          title: "feat: add integer subtraction",
          body: "## Summary\n- Add subtraction.",
        },
      }),
    ).resolves.toMatchObject({ branch: "feature/2-integer-subtraction" });
    await expect(readFile(path, "utf8").then(JSON.parse)).resolves.toEqual({
      branch: "feature/2-integer-subtraction",
      commitMessage: "feat: add integer subtraction",
      pullRequest: {
        title: "feat: add integer subtraction",
        body: "## Summary\n- Add subtraction.",
      },
    });
  });

  it("writes and validates a builder receipt through the agent-facing CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-delivery-cli-"));
    const bodyPath = join(root, "pr-body.md");
    await writeFile(bodyPath, "## Summary\n- Add subtraction.\n");
    const previous = {
      kind: process.env.FACILITY_DELIVERY_KIND,
      repository: process.env.FACILITY_DELIVERY_REPOSITORY,
    };
    process.env.FACILITY_DELIVERY_KIND = "builder";
    process.env.FACILITY_DELIVERY_REPOSITORY = root;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await deliveryCliMain([
        "write",
        "--branch",
        "feature/2-integer-subtraction",
        "--commit-message",
        "feat: add integer subtraction",
        "--pr-title",
        "feat: add integer subtraction",
        "--pr-body-file",
        bodyPath,
      ]);
      await deliveryCliMain(["validate"]);
      await expect(
        readFile(join(root, ".agent-sdlc", "delivery.json"), "utf8").then(JSON.parse),
      ).resolves.toEqual({
        branch: "feature/2-integer-subtraction",
        commitMessage: "feat: add integer subtraction",
        pullRequest: {
          title: "feat: add integer subtraction",
          body: "## Summary\n- Add subtraction.",
        },
      });
      expect(stdout).toHaveBeenCalledWith("Facility delivery receipt written and validated.\n");
      expect(stdout).toHaveBeenCalledWith("Facility delivery receipt is valid.\n");
    } finally {
      stdout.mockRestore();
      for (const [key, value] of [
        ["FACILITY_DELIVERY_KIND", previous.kind],
        ["FACILITY_DELIVERY_REPOSITORY", previous.repository],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("blocks Claude from stopping with changes until the governed receipt validates", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-delivery-hook-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: root });
    await writeFile(join(root, "task.txt"), "before\n");
    execFileSync("git", ["add", "task.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "chore: initialize fixture"], { cwd: root });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    await writeFile(join(root, "task.txt"), "after\n");

    const previous = {
      kind: process.env.FACILITY_DELIVERY_KIND,
      repository: process.env.FACILITY_DELIVERY_REPOSITORY,
      baseBranch: process.env.FACILITY_DELIVERY_BASE_BRANCH,
    };
    process.env.FACILITY_DELIVERY_KIND = "builder";
    process.env.FACILITY_DELIVERY_REPOSITORY = root;
    process.env.FACILITY_DELIVERY_BASE_BRANCH = "main";
    try {
      await expect(deliveryHookDecision()).resolves.toMatchObject({
        decision: "block",
      });
      await writeAgentDeliveryReceipt(join(root, ".agent-sdlc", "delivery.json"), "builder", {
        branch: "feature/task",
        commitMessage: "feat: update task",
        pullRequest: { title: "feat: update task", body: "## Summary\n- Update task." },
      });
      await expect(deliveryHookDecision()).resolves.toBeNull();
    } finally {
      for (const [key, value] of [
        ["FACILITY_DELIVERY_KIND", previous.kind],
        ["FACILITY_DELIVERY_REPOSITORY", previous.repository],
        ["FACILITY_DELIVERY_BASE_BRANCH", previous.baseBranch],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails the Stop hook closed when receipt validation cannot run", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-delivery-hook-invalid-"));
    const previous = {
      kind: process.env.FACILITY_DELIVERY_KIND,
      repository: process.env.FACILITY_DELIVERY_REPOSITORY,
    };
    process.env.FACILITY_DELIVERY_KIND = "builder";
    process.env.FACILITY_DELIVERY_REPOSITORY = root;
    try {
      await expect(deliveryHookDecision()).resolves.toMatchObject({
        decision: "block",
        reason: expect.stringContaining("Facility cannot accept this delivery receipt"),
      });
    } finally {
      for (const [key, value] of [
        ["FACILITY_DELIVERY_KIND", previous.kind],
        ["FACILITY_DELIVERY_REPOSITORY", previous.repository],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("accepts style and punctuation scopes and rejects malformed conventional subjects", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "delivery.json");
    await writeFile(
      path,
      JSON.stringify({
        branch: "feature/format-auth-api",
        commitMessage:
          "style(web+api): normalize formatting\n\nBREAKING CHANGE: generated output changed",
        pullRequest: {
          title: "fix(api/auth)!: require scoped credentials",
          body: "## Summary\n- Normalize formatting and scope credentials.",
        },
      }),
    );

    await expect(readAgentDeliveryMetadata(path)).resolves.toMatchObject({
      commitMessage:
        "style(web+api): normalize formatting\n\nBREAKING CHANGE: generated output changed",
      pullRequest: { title: "fix(api/auth)!: require scoped credentials" },
    });

    await writeFile(
      path,
      JSON.stringify({
        branch: "feature/format-auth-api",
        commitMessage: "feature(web+api): normalize formatting",
        pullRequest: {
          title: "fix(api/auth): require scoped credentials",
          body: "Summary",
        },
      }),
    );
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow("commit_not_conventional");

    for (const commitMessage of [
      "  fix: normalize formatting",
      "fix((): normalize formatting",
      "fix(api)): normalize formatting",
      "fix( ): normalize formatting",
      "fix(api\tauth): normalize formatting",
      "fix: render \u001b[31mred output",
      "fix: render \u009b31mred output",
    ]) {
      await writeFile(
        path,
        JSON.stringify({
          branch: "feature/format-auth-api",
          commitMessage,
          pullRequest: {
            title: "fix(api/auth): require scoped credentials",
            body: "Summary",
          },
        }),
      );
      await expect(readAgentDeliveryMetadata(path)).rejects.toThrow("commit_not_conventional");
    }

    await writeFile(
      path,
      JSON.stringify({
        branch: "feature/format-auth-api",
        commitMessage: "style(web+api): normalize formatting",
        pullRequest: {
          title: "fix(api(auth)): require scoped credentials",
          body: "Summary",
        },
      }),
    );
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow("pr_title_not_conventional");

    await writeFile(
      path,
      JSON.stringify({
        branch: "feature/format-auth-api",
        commitMessage: "fix: normalize formatting",
        pullRequest: {
          title: "  fix: require scoped credentials",
          body: "Summary",
        },
      }),
    );
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow("pr_title_not_conventional");
  });

  it("requires matching commit and PR-title impact using only an actual breaking footer", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "delivery.json");
    const writeDelivery = (commitMessage: string, title: string) =>
      writeFile(
        path,
        JSON.stringify({
          branch: "feature/release-impact",
          commitMessage,
          pullRequest: { title, body: "## Summary\n- Preserve release semantics." },
        }),
      );

    await writeDelivery(
      "fix: document the migration phrase\n\nBREAKING CHANGE: appears in an example\n\nThe behavior remains compatible.",
      "fix: document the migration phrase",
    );
    await expect(readAgentDeliveryMetadata(path)).resolves.toMatchObject({
      pullRequest: { title: "fix: document the migration phrase" },
    });

    await writeDelivery(
      "fix: document malformed input\nBREAKING CHANGE: missing footer separator",
      "fix: document malformed input",
    );
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow(
      "github_signed_delivery_commit_body_separator_invalid",
    );

    for (const nonFooter of [
      "fix: quote output\n\nThe tool printed:\nBREAKING CHANGE: example text",
      "fix: show a fence\n\n```text\nBREAKING CHANGE: example text\n```",
      "fix: show indented code\n\n    BREAKING CHANGE: example text",
      "fix: use a tab separator\n\nBREAKING CHANGE:\tmigrate the client",
    ]) {
      await writeDelivery(nonFooter, "fix: preserve compatible behavior");
      await expect(readAgentDeliveryMetadata(path)).resolves.toMatchObject({
        pullRequest: { title: "fix: preserve compatible behavior" },
      });
    }

    const breakingCommit =
      "fix: replace the public contract\n\nExplain the migration.\n\nBREAKING CHANGE: migrate the client\ncontinue with the second step\nCloses #123";
    await writeDelivery(breakingCommit, "fix: replace the public contract");
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow(
      "agent_delivery_release_impact_mismatch",
    );

    await writeDelivery(breakingCommit, "fix!: replace the public contract");
    await expect(readAgentDeliveryMetadata(path)).resolves.toMatchObject({
      commitMessage: breakingCommit,
      pullRequest: { title: "fix!: replace the public contract" },
    });

    await writeDelivery("docs: explain the public contract", "fix: explain the public contract");
    await expect(readAgentDeliveryMetadata(path)).rejects.toThrow(
      "agent_delivery_release_impact_mismatch",
    );
  });

  it("publishes agent-owned metadata through GitHub's signed commit mutation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "POST" && url.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ ref: "refs/heads/feature/task" }), { status: 201 });
      }
      if (url.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: "signed_sha" } } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    await expect(
      publishVerifiedGithubChanges({
        repo: "acme/widget",
        token: "installation-token",
        requestedBranch: "feature/task",
        baseSha: "base_sha",
        commitMessage:
          "feat!: deliver task\n\nExplain the migration.\n\nBREAKING CHANGE: use the new task API",
        changes: [{ kind: "addition", path: "src/task.js", contents: "Y29udGVudA==" }],
        runId: "run_12345678",
        fetchImpl,
      }),
    ).resolves.toEqual({ branch: "feature/task", headSha: "signed_sha" });
    const mutation = JSON.parse(String(requests[2]?.init?.body));
    expect(mutation.variables.input.message).toEqual({
      headline: "feat!: deliver task",
      body: "Delivered by Facility run run_12345678.\n\nExplain the migration.\n\nBREAKING CHANGE: use the new task API",
    });
    expect(mutation.variables.input.fileChanges.additions[0]).toEqual({
      path: "src/task.js",
      contents: "Y29udGVudA==",
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: "Bearer installation-token",
    });
  });

  it("fails before publishing when a Conventional Commit prefix cannot fit GitHub", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ message: "unexpected request" }), { status: 500 });
    };

    await expect(
      publishVerifiedGithubChanges({
        repo: "acme/widget",
        token: "installation-token",
        requestedBranch: "feature/task",
        baseSha: "base_sha",
        commitMessage: `feat(${"a".repeat(112)}): x`,
        changes: [{ kind: "addition", path: "src/task.js", contents: "Y29udGVudA==" }],
        runId: "run_12345678",
        fetchImpl,
      }),
    ).rejects.toThrow("commit_subject_too_long");
    expect(requests).toHaveLength(0);
  });

  it("keeps multipart signed commit headlines conventional at the Unicode limit", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          data: {
            createCommitOnBranch: { commit: { oid: `updated_${requests.length}` } },
          },
        }),
        { status: 200 },
      );
    };
    const changes = Array.from({ length: 101 }, (_, index) => ({
      kind: "addition" as const,
      path: `src/task-${index}.js`,
      contents: "Y29udGVudA==",
    }));

    await expect(
      publishVerifiedGithubBranchUpdate({
        repo: "acme/widget",
        token: "installation-token",
        branch: "automation/dependency-refresh",
        expectedHeadSha: "current_sha",
        commitMessage: `feat(web+api)!: ${"x".repeat(92)}😀tail\n\nBREAKING CHANGE: use the new task API`,
        changes,
        runId: "run_12345678",
        fetchImpl,
      }),
    ).resolves.toEqual({
      branch: "automation/dependency-refresh",
      headSha: "updated_2",
    });

    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      const mutation = JSON.parse(String(request.init?.body));
      const message = mutation.variables.input.message;
      expect([...message.headline]).toHaveLength(120);
      expect(message.headline).toMatch(
        /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()]+\))?!?: \S.*$/,
      );
      expect(message.headline.endsWith(`😀 (part ${index + 1}/2)`)).toBe(true);
      expect(message.body).toBe(
        "Delivered by Facility run run_12345678.\n\nBREAKING CHANGE: use the new task API",
      );
    }
  });

  it("updates the existing PR branch without creating a generic branch", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: "updated_sha" } } } }),
        { status: 200 },
      );
    };
    await expect(
      publishVerifiedGithubBranchUpdate({
        repo: "acme/widget",
        token: "installation-token",
        branch: "automation/dependency-refresh",
        expectedHeadSha: "current_sha",
        commitMessage: "fix: address review\n\nKeep the explanation in the commit body.",
        changes: [{ kind: "addition", path: "src/task.js", contents: "Y29udGVudA==" }],
        runId: "run_12345678",
        fetchImpl,
      }),
    ).resolves.toEqual({ branch: "automation/dependency-refresh", headSha: "updated_sha" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/graphql");
    const mutation = JSON.parse(String(requests[0]?.init?.body));
    expect(mutation.variables.input.branch.branchName).toBe("automation/dependency-refresh");
    expect(mutation.variables.input.expectedHeadOid).toBe("current_sha");
    expect(mutation.variables.input.message).toEqual({
      headline: "fix: address review",
      body: "Delivered by Facility run run_12345678.\n\nKeep the explanation in the commit body.",
    });
  });

  it("parses null-delimited git changes and preserves semantic branches", () => {
    expect(parseGitNameStatus("M\0src/math.js\0D\0old.js\0")).toEqual([
      { status: "M", path: "src/math.js" },
      { status: "D", path: "old.js" },
    ]);
    expect(semanticDeliveryBranch("feature/2-subtract", "main")).toBe("feature/2-subtract");
    expect(() => semanticDeliveryBranch("main", "main")).toThrow("branch_not_semantic");
  });

  it("accepts minimal agent-owned metadata for an existing PR update", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, "delivery.json");
    await writeFile(
      path,
      JSON.stringify({
        branch: "automation/dependency-refresh",
        commitMessage: "fix: address review\n\nKeep the explanation in the commit body.",
      }),
    );
    await expect(readAgentUpdateMetadata(path)).resolves.toEqual({
      branch: "automation/dependency-refresh",
      commitMessage: "fix: address review\n\nKeep the explanation in the commit body.",
    });
    await writeFile(
      path,
      JSON.stringify({
        branch: "automation/dependency-refresh",
        commitMessage: "  fix: address review",
      }),
    );
    await expect(readAgentUpdateMetadata(path)).rejects.toThrow("commit_not_conventional");
    await writeFile(
      path,
      JSON.stringify({ branch: "bad..branch", commitMessage: "fix: address review" }),
    );
    await expect(readAgentUpdateMetadata(path)).rejects.toThrow("branch_invalid");
  });

  it("reads bounded task-specific progress and requires it for governed agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const path = join(root, ".agent-sdlc", "progress.md");
    await mkdir(join(root, ".agent-sdlc"), { recursive: true });
    await writeFile(path, "Context\n\n- [x] Inspect\n- [ ] Verify\n");

    await expect(readAgentProgress(path)).resolves.toContain("- [ ] Verify");
    expect(requiresAgentProgress("codex-builder")).toBe(true);
    expect(requiresAgentProgress("ci-doctor")).toBe(true);
    expect(requiresAgentProgress("custom")).toBe(false);
    expect(readOnlyEngineProgress(false)).toContain("- [ ] Inspect");
    expect(readOnlyEngineProgress(true)).toContain("- [x] Inspect");
  });

  it("installs registry skills as discoverable SKILL.md packages for both engines", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    await prepareWorkspace(
      bundle({ skills: [{ name: "working to standard", content: "# Working to standard" }] }),
      "virtual-key",
      {
        platformKey: null,
        platformApiUrl: "https://api.test",
        projectId: "proj_test",
        repoToken: null,
      },
      root,
    );

    for (const engineRoot of [".claude", ".agents"]) {
      await expect(
        readFile(
          join(root, "scratch", engineRoot, "skills", "working_to_standard", "SKILL.md"),
          "utf8",
        ),
      ).resolves.toContain(
        '---\nname: "working_to_standard"\ndescription: "Project-managed Facility skill: working to standard"\n---\n\n# Working to standard',
      );
    }
  });

  it("keeps platform-managed skills and harness context out of a cloned repository diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const origin = join(root, "origin");
    await mkdir(origin);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: origin });
    execFileSync("git", ["config", "user.email", "facility@example.invalid"], { cwd: origin });
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: origin });
    await writeFile(join(origin, "README.md"), "# Fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: origin });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: origin });

    await prepareWorkspace(
      bundle({
        repo: {
          cloneUrl: origin,
          branch: "main",
          expectedHeadSha: null,
          installationTokenRef: null,
        },
        skills: [{ name: "validation evidence", content: "# Validation evidence" }],
        harness: {
          files: {
            "harness/SESSION.md": "# Session",
            "harness/ACTIVE.md": "## Objective",
          },
        },
      }),
      "virtual-key",
      {
        platformKey: null,
        platformApiUrl: "https://api.test",
        projectId: "proj_test",
        repoToken: null,
      },
      root,
    );

    const cloned = join(root, "repo");
    expect(execFileSync("git", ["status", "--short"], { cwd: cloned, encoding: "utf8" })).toBe("");
    await expect(readFile(join(cloned, ".git", "info", "exclude"), "utf8")).resolves.toContain(
      ".agents/skills/validation_evidence/",
    );
    await expect(readFile(join(cloned, ".git", "info", "exclude"), "utf8")).resolves.toContain(
      "harness/SESSION.md",
    );
    await expect(readFile(join(cloned, ".git", "info", "exclude"), "utf8")).resolves.toContain(
      ".agent-sdlc/progress.md",
    );
    await expect(readFile(join(cloned, "harness", "ACTIVE.md"), "utf8")).resolves.toBe(
      "## Objective",
    );
  });

  it("does not write live engine or platform key values into the agent cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-"));
    const previousEnv = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      anthropicOauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      openai: process.env.OPENAI_API_KEY,
      platform: process.env.FACILITY_PLATFORM_KEY,
    };
    try {
      await prepareWorkspace(
        bundle(),
        "virtual-key-secret",
        {
          platformKey: "platform-key-secret",
          platformApiUrl: "https://api.test",
          projectId: "proj_test",
          repoToken: null,
        },
        root,
      );

      await expect(
        readFile(join(root, "scratch", ".facility-engine-env"), "utf8"),
      ).rejects.toThrow();
      expect(process.env.ANTHROPIC_API_KEY).toBe("virtual-key-secret");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(process.env.OPENAI_API_KEY).toBe("virtual-key-secret");
      expect(process.env.FACILITY_PLATFORM_KEY).toBe("platform-key-secret");

      const files = await workspaceFiles(join(root, "scratch"));
      const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
      expect(contents.join("\n")).not.toContain("virtual-key-secret");
      expect(contents.join("\n")).not.toContain("platform-key-secret");
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", previousEnv.anthropic);
      restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", previousEnv.anthropicOauth);
      restoreEnv("OPENAI_API_KEY", previousEnv.openai);
      restoreEnv("FACILITY_PLATFORM_KEY", previousEnv.platform);
    }
  });

  it("uses mutually exclusive Claude Code OAuth virtual-key authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-oauth-"));
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      process.env.ANTHROPIC_API_KEY = "inherited-api-key-must-be-removed";
      await prepareWorkspace(
        bundle({ engine: "claude_code", anthropicAuthMode: "oauth" }),
        "fvk_oauth_virtual_key",
        {
          platformKey: null,
          platformApiUrl: "https://api.test",
          projectId: "proj_test",
          repoToken: null,
        },
        root,
      );

      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fvk_oauth_virtual_key");
      expect(engineEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe("fvk_oauth_virtual_key");
      expect(engineEnv().ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", previousApiKey);
      restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", previousOauthToken);
    }
  });
});

describe("runner receipt activity", () => {
  it("counts repository changes for delivery and repair modes without runtime artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-receipt-"));
    const repo = join(root, "repo");
    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, ".agent-sdlc"), { recursive: true });
      await mkdir(join(repo, "harness"), { recursive: true });
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "facility@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: repo });
      await writeFile(join(repo, "src", "changed.ts"), "export const value = 1;\n");
      await writeFile(join(repo, "src", "deleted.ts"), "export const removed = true;\n");
      await writeFile(join(repo, ".agent-sdlc", "delivery.json"), "{}\n");
      await writeFile(join(repo, "harness", "SESSION.md"), "# Original\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "test: initialize receipt fixture"], { cwd: repo });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });

      await writeFile(join(repo, "src", "changed.ts"), "export const value = 2;\n");
      await rm(join(repo, "src", "deleted.ts"));
      await writeFile(join(repo, "src", "added.ts"), "export const added = true;\n");
      await writeFile(join(repo, ".agent-sdlc", "delivery.json"), '{"branch":"feature/task"}\n');
      await writeFile(join(repo, "harness", "SESSION.md"), "# Injected\n");
      await mkdir(join(repo, ".claude", "skills", "receipt_skill"), { recursive: true });
      await writeFile(
        join(repo, ".claude", "skills", "receipt_skill", "SKILL.md"),
        "# Injected skill\n",
      );
      await mkdir(join(repo, "node_modules", "runtime-only"), { recursive: true });
      await writeFile(join(repo, "node_modules", "runtime-only", "index.js"), "generated\n");

      const repoBundle = bundle({
        repo: {
          cloneUrl: "https://github.com/acme/widget.git",
          branch: "main",
          expectedHeadSha: null,
          installationTokenRef: "installation",
        },
        skills: [{ name: "receipt skill", content: "# Receipt skill" }],
        harness: { files: { "harness/SESSION.md": "# Injected" } },
      });
      for (const mode of ["builder", "codex-builder", "address-review", "ci-doctor"]) {
        await expect(
          runnerReceiptActivity({ ...repoBundle, mode }, "succeeded", root),
        ).resolves.toMatchObject({ file_changes: 3 });
      }
      await expect(runnerReceiptActivity(repoBundle, "failed", root)).resolves.toMatchObject({
        file_changes: 3,
        errors: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "architect",
    "review",
    "security-sweep",
    "custom",
  ])("keeps %s receipt file changes at zero", async (mode) => {
    await expect(runnerReceiptActivity(bundle({ mode }), "succeeded")).resolves.toMatchObject({
      file_changes: 0,
    });
  });
});

describe("bounded Git delivery commands", () => {
  it("terminates a Git process group that exceeds its delivery deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-git-timeout-"));
    const pidPath = join(root, ".facility-hang.pid");
    try {
      await expect(
        gitOutput(
          root,
          [
            "-c",
            "alias.facility-hang=!sleep 30 & echo $! > .facility-hang.pid; wait",
            "facility-hang",
          ],
          true,
          100,
        ),
      ).rejects.toThrow("git -c timed out after 100ms");

      const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      await expectProcessToExit(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("escalates after the Git parent exits when a descendant ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-git-kill-timeout-"));
    const pidPath = join(root, ".facility-resistant.pid");
    try {
      await expect(
        gitOutput(
          root,
          [
            "-c",
            "alias.facility-hang=!sh -c 'trap \"\" TERM; echo $$ > .facility-resistant.pid; while :; do sleep 1; done' >/dev/null 2>&1 & wait",
            "facility-hang",
          ],
          true,
          100,
        ),
      ).rejects.toThrow("git -c timed out after 100ms");

      const descendantPid = Number((await readFile(pidPath, "utf8")).trim());
      expect(Number.isInteger(descendantPid)).toBe(true);
      await expectProcessToExit(descendantPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts a signed-delivery HTTP request at its deadline", async () => {
    const requestSignals: AbortSignal[] = [];
    const request = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const requestSignal = init?.signal;
      if (requestSignal) requestSignals.push(requestSignal);
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), {
          once: true,
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      githubRequest(request, "https://api.github.test/graphql", "installation-token", {}, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignals[0]?.aborted).toBe(true);
  });
});

describe("delivery phase reporting", () => {
  it.each([
    {
      name: "a signed delivery failure",
      git: { changed: true, pushError: "github request timed out" },
      deliveryError: "delivery_push_failed",
      expectedError: "github request timed out",
    },
    {
      name: "a builder without a repository",
      git: undefined,
      deliveryError: "delivery_repo_not_configured",
      expectedError: "delivery_repo_not_configured",
    },
    {
      name: "a builder without changes",
      git: { changed: false },
      deliveryError: "delivery_no_changes",
      expectedError: "delivery_no_changes",
    },
  ])("does not announce $name as prepared", ({ git, deliveryError, expectedError }) => {
    expect(deliveryStatusEvent(git, deliveryError)).toEqual({
      type: "delivery",
      data: {
        status: "failed",
        changed: git?.changed === true,
        error: expectedError,
      },
    });
  });

  it("announces a valid delivery as prepared", () => {
    expect(deliveryStatusEvent({ changed: true }, null)).toEqual({
      type: "delivery",
      data: { status: "prepared", changed: true },
    });
  });
});

async function expectProcessToExit(pid: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} survived its Git command timeout`);
}

describe("run prompt composition", () => {
  it("promotes a manual run message to an explicit objective", () => {
    const prompt = composedPrompt(
      bundle({ scope: { type: "manual", source: "agent-page", message: "  Fix the builder  " } }),
    );

    expect(prompt).toContain("## Run objective\nFix the builder");
  });

  it("promotes CLI text input to the same explicit objective", () => {
    const prompt = composedPrompt(
      bundle({ scope: { source: "cli", agentName: "builder", input: "Fix the CLI builder" } }),
    );

    expect(prompt).toContain("## Run objective\nFix the CLI builder");
  });

  it("promotes approved plans, structured input, and governed issues", () => {
    const objectives: Array<[Record<string, unknown>, string]> = [
      [{ approvedPlan: "Ship the approved plan" }, "Ship the approved plan"],
      [
        { input: { objective: "Fix the structured CLI builder" } },
        '{\n  "objective": "Fix the structured CLI builder"\n}',
      ],
      [{ issue: { number: 42 } }, "Implement the governed GitHub issue #42 described in Scope."],
    ];

    for (const [scope, objective] of objectives) {
      expect(composedPrompt(bundle({ scope }))).toContain(`## Run objective\n${objective}`);
    }
  });

  it("keeps conversation messages in their conversation section", () => {
    const prompt = composedPrompt(
      bundle({ scope: { type: "conversation", message: "Continue the discussion" } }),
    );

    expect(prompt).toContain("## Conversation\nContinue the discussion");
    expect(prompt).not.toContain("## Run objective");
  });
});

describe("Claude resume controls", () => {
  it("restores tracked, binary, untracked, managed, and branch state from a checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-resume-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const checkpoint = join(root, "checkpoint");
    await mkdir(source);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: source });
    await writeFile(join(source, ".gitignore"), "node_modules/\n");
    await writeFile(join(source, "task.txt"), "before\n");
    await writeFile(join(source, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    execFileSync("git", ["add", ".gitignore", "task.txt", "asset.bin"], { cwd: source });
    execFileSync("git", ["commit", "-m", "chore: initialize resume fixture"], { cwd: source });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: source });
    execFileSync("git", ["checkout", "-b", "feature/resumed-task"], { cwd: source });
    await writeFile(join(source, "task.txt"), "after\n");
    await writeFile(join(source, "asset.bin"), Buffer.from([3, 2, 1, 0]));
    await writeFile(join(source, "new-file.txt"), "new work\n");
    await mkdir(join(source, "node_modules", "generated"), { recursive: true });
    await writeFile(join(source, "node_modules", "generated", "cache.js"), "ignored\n");
    await mkdir(join(source, ".agent-sdlc"));
    await writeFile(join(source, ".agent-sdlc", "progress.md"), "- [x] restored work\n");
    await writeFile(join(source, ".git", "info", "exclude"), ".agent-sdlc/progress.md\n", {
      flag: "a",
    });

    await createWorkspaceCheckpoint(source, checkpoint, "main");
    // Checkpoint metadata is deliberately lifecycle-only. Restore must pass
    // the patch over stdin instead of asking the untrusted Git process to open
    // this root-owned 0600 path directly.
    expect((await stat(join(checkpoint, "tracked.patch"))).mode & 0o777).toBe(0o600);
    execFileSync("git", ["clone", "--branch", "main", source, target]);

    await expect(restoreWorkspaceCheckpoint(target, checkpoint, "main")).resolves.toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: target, encoding: "utf8" }).trim(),
    ).toBe("feature/resumed-task");
    await expect(readFile(join(target, "task.txt"), "utf8")).resolves.toBe("after\n");
    await expect(readFile(join(target, "asset.bin"))).resolves.toEqual(Buffer.from([3, 2, 1, 0]));
    await expect(readFile(join(target, "new-file.txt"), "utf8")).resolves.toBe("new work\n");
    await expect(lstat(join(target, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(target, ".agent-sdlc", "progress.md"), "utf8")).resolves.toBe(
      "- [x] restored work\n",
    );
  });

  it("replays a workspace checkpoint when the admitted base changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-resume-stale-"));
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    const target = join(workspace, "repo");
    const checkpoint = join(root, "checkpoint");
    await mkdir(source);
    await mkdir(workspace);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: source });
    await writeFile(join(source, "task.txt"), "before\n");
    execFileSync("git", ["add", "task.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "chore: initialize stale fixture"], { cwd: source });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: source });
    const originalBaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    await writeFile(join(source, "task.txt"), "resumable work\n");
    await createWorkspaceCheckpoint(source, checkpoint, "main");

    execFileSync("git", ["clone", "--branch", "main", source, target]);
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: target });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: target });
    await writeFile(join(target, "new-base.txt"), "new base\n");
    execFileSync("git", ["add", "new-base.txt"], { cwd: target });
    execFileSync("git", ["commit", "-m", "chore: advance admitted base"], { cwd: target });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: target });
    const currentBaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf8",
    }).trim();

    await expect(restoreWorkspaceCheckpoint(target, checkpoint, "main")).resolves.toBe(true);
    await expect(
      preparedWorkspaceBaseSha(
        bundle({
          repo: {
            cloneUrl: "https://github.com/acme/widget.git",
            branch: "main",
            expectedHeadSha: null,
            installationTokenRef: null,
          },
        }),
        workspace,
      ),
    ).resolves.toBe(currentBaseSha);
    expect(currentBaseSha).not.toBe(originalBaseSha);
    await expect(
      readFile(join(target, "task.txt"), "utf8").then((body) => body.replace(/\r\n/g, "\n")),
    ).resolves.toBe("resumable work\n");
    await expect(
      readFile(join(target, "new-base.txt"), "utf8").then((body) => body.replace(/\r\n/g, "\n")),
    ).resolves.toBe("new base\n");
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: target, encoding: "utf8" }).trim(),
    ).toBe("main");
  });

  it("preserves three-way conflicts for the resumed agent to reconcile", async () => {
    const root = await mkdtemp(join(tmpdir(), "facility-runner-resume-conflict-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const checkpoint = join(root, "checkpoint");
    await mkdir(source);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: source });
    await writeFile(join(source, "task.txt"), "shared baseline\n");
    execFileSync("git", ["add", "task.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "chore: initialize conflict fixture"], { cwd: source });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: source });
    await writeFile(join(source, "task.txt"), "checkpoint version\n");
    await createWorkspaceCheckpoint(source, checkpoint, "main");

    execFileSync("git", ["clone", "--branch", "main", source, target]);
    execFileSync("git", ["config", "user.name", "Facility Test"], { cwd: target });
    execFileSync("git", ["config", "user.email", "facility@example.test"], { cwd: target });
    await writeFile(join(target, "task.txt"), "upstream version\n");
    execFileSync("git", ["add", "task.txt"], { cwd: target });
    execFileSync("git", ["commit", "-m", "chore: advance conflicting base"], { cwd: target });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: target });

    await expect(restoreWorkspaceCheckpoint(target, checkpoint, "main")).resolves.toBe(true);
    expect(
      execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: target,
        encoding: "utf8",
      }).trim(),
    ).toBe("task.txt");
    const conflicted = await readFile(join(target, "task.txt"), "utf8");
    expect(conflicted).toContain("checkpoint version");
    expect(conflicted).toContain("upstream version");
  });

  it("runs architects in native plan mode and keeps builders writable", () => {
    const architectArgs = buildClaudeCodeArgs(bundle({ mode: "architect" }), false);
    const builderArgs = buildClaudeCodeArgs(bundle({ mode: "builder" }), false);

    expect(architectArgs[architectArgs.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(architectArgs).not.toContain("bypassPermissions");
    expect(builderArgs).toContain("bypassPermissions");
    expect(architectArgs).not.toContain("--max-turns");
    expect(builderArgs).not.toContain("--max-turns");
    expect(architectArgs).not.toContain("--append-system-prompt");
    expect(builderArgs).toContain("--append-system-prompt");
    expect(deliverySystemPrompt("builder")).toContain("facility-delivery write");
    expect(deliverySystemPrompt("architect")).toBeNull();
    expect(JSON.parse(claudeDeliverySettings("builder") ?? "null")).toMatchObject({
      disableAllHooks: false,
      hooks: { Stop: [{ hooks: [{ command: "/usr/local/bin/facility-delivery" }] }] },
    });
  });

  it("reports the provider terminal boundary instead of the last assistant prose", () => {
    expect(
      engineResultError({
        type: "engine_result",
        data: { is_error: true, subtype: "error_max_turns", errors: [] },
      }),
    ).toBe("engine_error_max_turns");
    expect(engineResultError({ type: "assistant", data: { text: "looks done" } })).toBeNull();
  });

  it("uses --resume only after session state has been restored", () => {
    const runBundle = bundle({
      engine: "claude_code",
      resume: {
        sessionId: "sess_123",
        sessionStateFrom: "run_parent",
        prompt: "continue",
      },
    });
    const restoredArgs = buildClaudeCodeArgs(runBundle, true);
    expect(restoredArgs.slice(0, 1)).toEqual(["-p"]);
    expect(restoredArgs[1]).toContain("## Restored continuation");
    expect(restoredArgs[1]).toContain("## Resume instruction\ncontinue");
    expect(restoredArgs.slice(2, 4)).toEqual(["--resume", "sess_123"]);
    expect(buildClaudeCodeArgs(runBundle, false)).not.toContain("--resume");
    expect(buildClaudeCodeArgs(runBundle, false)).toContain(composedPrompt(runBundle));
    expect(buildClaudeCodeArgs(runBundle, true)).toContain("--append-system-prompt");
    expect(buildClaudeCodeArgs(runBundle, true)).toContain("--settings");
  });

  it("recovers the governed parent objective when session state is missing", () => {
    const runBundle = bundle({
      engine: "claude_code",
      scope: { type: "resume", message: "Continue the implementation" },
      resume: {
        sessionId: "sess_123",
        sessionStateFrom: "run_parent",
        prompt: "Continue the implementation",
        fallbackScope: {
          approvedPlan: "Deduplicate the helpers described in issue 557",
          issue: { number: 557 },
        },
      },
    });

    const prompt = resumeRecoveryPrompt(runBundle);
    expect(prompt).toContain("Deduplicate the helpers described in issue 557");
    expect(prompt).toContain(
      "prior Claude session or governed workspace checkpoint from run run_parent was unavailable",
    );
    expect(prompt).toContain("## Resume instruction\nContinue the implementation");
    expect(buildClaudeCodeArgs(runBundle, false)).not.toContain("--resume");
  });

  it("reinjects the governed parent objective into a restored compacted session", () => {
    const runBundle = bundle({
      engine: "claude_code",
      scope: { type: "resume", message: "Continue the implementation" },
      resume: {
        sessionId: "sess_123",
        sessionStateFrom: "run_parent",
        prompt: "Continue the implementation",
        fallbackScope: {
          approvedPlan: "Implement the complete approved hiring portal plan",
          issue: { number: 937 },
        },
      },
    });

    const prompt = resumeContinuationPrompt(runBundle);
    expect(prompt).toContain("Implement the complete approved hiring portal plan");
    expect(prompt).toContain("remain authoritative even if the conversation was compacted");
    expect(prompt).toContain("## Resume instruction\nContinue the implementation");
  });

  it("keeps live engine-event transport failures off the execution boundary", async () => {
    const event = [{ type: "assistant", data: { text: "work completed" } }];
    await expect(
      emitEngineEventsBestEffort(event, async () => {
        throw new Error("transient network failure");
      }),
    ).resolves.toBe(false);
    await expect(emitEngineEventsBestEffort(event, async () => undefined)).resolves.toBe(true);
  });

  it("branches steer and interrupt control messages", async () => {
    const events: unknown[] = [];
    const steers: string[] = [];
    let interrupted = false;
    await expect(
      handleControlMessage(
        { id: "msg_1", kind: "steer", body: "please adjust" },
        {
          appendSteer: async (body) => {
            steers.push(body);
          },
          emit: async (batch) => {
            events.push(...batch);
          },
          interrupt: async () => {
            interrupted = true;
          },
        },
      ),
    ).resolves.toBe("steer");
    expect(steers).toEqual(["please adjust"]);
    expect(interrupted).toBe(false);

    await expect(
      handleControlMessage(
        { id: "msg_2", kind: "interrupt", body: "stop" },
        {
          appendSteer: async (body) => {
            steers.push(body);
          },
          emit: async (batch) => {
            events.push(...batch);
          },
          interrupt: async () => {
            interrupted = true;
          },
        },
      ),
    ).resolves.toBe("interrupt");
    expect(interrupted).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "status", data: { message: "human interrupt" } },
        { type: "steer", data: { id: "msg_2", kind: "interrupt" } },
      ]),
    );
  });

  it("signals SIGTERM before SIGKILL on interrupt termination", () => {
    const signals: string[] = [];
    const timers: Array<() => void> = [];
    const clear = terminateChild(
      {
        kill: (signal) => {
          signals.push(String(signal));
          return true;
        },
      },
      15_000,
      ((callback: () => void) => {
        timers.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    );
    expect(signals).toEqual(["SIGTERM"]);
    timers[0]?.();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    clear();
  });
});

describe("Codex model controls", () => {
  it("runs architects in the read-only sandbox and keeps builders writable", () => {
    const architectArgs = buildCodexArgs(bundle({ mode: "codex-architect" }));
    const builderArgs = buildCodexArgs(bundle({ mode: "codex-builder" }));

    expect(
      architectArgs.slice(architectArgs.indexOf("-s"), architectArgs.indexOf("-s") + 2),
    ).toEqual(["-s", "read-only"]);
    expect(builderArgs).toContain("danger-full-access");
  });

  it("applies the configured model and reasoning effort", () => {
    const args = buildCodexArgs(
      bundle({
        engineConfig: { primary: "gpt-5.6", reasoning_effort: "high" },
      }),
    );
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.6");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('model_provider="facility_gateway"');
    expect(args).toContain('model_providers.facility_gateway.base_url="https://openai.test/v1"');
    expect(args).toContain('model_providers.facility_gateway.env_key="OPENAI_API_KEY"');
    expect(args).toContain("model_providers.facility_gateway.supports_websockets=false");
    expect(args.at(-1)).toBe("-");
    expect(args.some((value) => value.includes("Do the work."))).toBe(false);
  });

  it("does not duplicate an existing gateway API version", () => {
    const args = buildCodexArgs(
      bundle({
        gatewayUrls: { anthropic: "https://anthropic.test", openai: "https://openai.test/v1" },
      }),
    );
    expect(args).toContain('model_providers.facility_gateway.base_url="https://openai.test/v1"');
    expect(args.join(" ")).not.toContain("/v1/v1");
  });

  it("keeps large learning packets out of argv", () => {
    const args = buildCodexArgs(
      bundle({ mode: "learning", scope: { packet: "x".repeat(512_000) } }),
    );
    expect(args.at(-1)).toBe("-");
    expect(Math.max(...args.map((value) => value.length))).toBeLessThan(2_000);
  });
});

async function workspaceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
