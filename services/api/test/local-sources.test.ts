import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newFilesPatch } from "../src/repositories/local-kickstart.js";
import {
  DEFAULT_LOCAL_GIT_IDENTITY,
  isLocalAlias,
  ProjectRepositoryAccess,
  projectSource,
} from "../src/repositories/sources.js";
import {
  base64Chunks,
  localSourceRef,
  manifestRepositoryName,
  ProjectEnvironmentError,
  parseProjectManifest,
  repositoryPath,
} from "../src/workspaces/project-environment.js";

const environment = `environment:
  start: pnpm dev
  services:
    app:
      port: 3000
`;

describe("local repository sources", () => {
  it("parses local aliases alongside unchanged GitHub repository names", () => {
    const local = parseProjectManifest(`version: 1
repositories:
  primary: local:payments
  related: [local:shared-lib, github.com/acme/tools]
${environment}`);
    expect(local.repositories).toEqual({
      primary: "local:payments",
      related: ["local:shared-lib", "acme/tools"],
    });
    const github = parseProjectManifest(`version: 1
repositories:
  primary: https://github.com/acme/app.git
${environment}`);
    expect(github.repositories.primary).toBe("acme/app");
  });

  it("rejects local references that could smuggle paths or GitHub names", () => {
    for (const reference of [
      "local:../escape",
      "local:/etc",
      "local:a/b",
      "local:app.git",
      "local:",
      "file:///srv/app",
      "/srv/app",
    ]) {
      expect(() =>
        parseProjectManifest(`version: 1
repositories:
  primary: ${JSON.stringify(reference)}
${environment}`),
      ).toThrow(ProjectEnvironmentError);
    }
    expect(isLocalAlias("payments-api_2.0")).toBe(true);
    for (const alias of ["", ".hidden", "a/b", "../x", "x.git", "a".repeat(101)]) {
      expect(isLocalAlias(alias)).toBe(false);
    }
  });

  it("validates configured review checks", () => {
    const parsed = parseProjectManifest(`version: 1
repositories:
  primary: local:app
environment:
  start: pnpm dev
  checks:
    unit: pnpm test
    lint: pnpm lint
`);
    expect(parsed.environment.checks).toEqual({ unit: "pnpm test", lint: "pnpm lint" });
    expect(() =>
      parseProjectManifest(`version: 1
repositories:
  primary: local:app
environment:
  start: pnpm dev
  checks:
    "Bad Name": pnpm test
`),
    ).toThrow(/checks/);
  });

  it("names local repositories in manifests and workspaces without host paths", () => {
    const repository = {
      source: "local" as const,
      owner: "_local",
      name: "payments",
      defaultBranch: "main",
    };
    expect(manifestRepositoryName(repository)).toBe("local:payments");
    expect(manifestRepositoryName({ ...repository, source: "github", owner: "acme" })).toBe(
      "acme/payments",
    );
    expect(repositoryPath(repository)).toBe("repos/_local/payments");
    expect(localSourceRef(repository)).toBe("refs/facility/source/main");
  });

  it("selects the project's source and refuses mixed projects", () => {
    expect(projectSource([])).toBe("github");
    expect(projectSource([{ role: "primary", source: "local" }])).toBe("local");
    expect(projectSource([{ role: "primary", source: "github" }])).toBe("github");
    expect(() =>
      projectSource([
        { role: "primary", source: "local" },
        { role: "related", source: "github" },
      ]),
    ).toThrow(/all be GitHub repositories or all be local/);
  });

  it("issues local access without touching the GitHub broker", async () => {
    const calls: string[] = [];
    const rows = [
      {
        id: "repo_local",
        role: "primary",
        source: "local",
        owner: "_local",
        name: "app",
        defaultBranch: "main",
      },
    ];
    const db = fakeRowsDb(rows);
    const access = new ProjectRepositoryAccess(db, {
      issue: async () => {
        calls.push("github");
        throw new Error("GitHub must not be called");
      },
    });
    const issued = await access.issue("org_1", "proj_1");
    expect(calls).toEqual([]);
    expect(issued.environment).toEqual({});
    expect(issued.gitIdentity).toEqual(DEFAULT_LOCAL_GIT_IDENTITY);
    expect(issued.repositories).toEqual([
      {
        id: "repo_local",
        source: "local",
        owner: "_local",
        name: "app",
        defaultBranch: "main",
        role: "primary",
      },
    ]);

    const github = new ProjectRepositoryAccess(fakeRowsDb([{ ...rows[0], source: "github" }]), {
      issue: async () => {
        calls.push("github");
        return {
          repositories: [],
          environment: { GH_TOKEN: "token" },
          expiresAt: new Date(),
          gitIdentity: { name: "bot", email: "bot@example.com" },
        };
      },
    });
    expect((await github.issue("org_1", "proj_1")).environment.GH_TOKEN).toBe("token");
    expect(calls).toEqual(["github"]);
  });

  it("encodes bundles in bounded chunks that concatenate to the whole encoding", () => {
    const bundle = Buffer.from(Array.from({ length: 10_001 }, (_, index) => (index * 7) % 256));
    const chunks = [...base64Chunks(bundle, 999)];
    expect(chunks.length).toBe(Math.ceil(10_001 / 999));
    expect(chunks.every((chunk) => chunk.length <= (999 / 3) * 4)).toBe(true);
    expect(chunks.join("")).toBe(bundle.toString("base64"));
    expect(Buffer.from(chunks.join(""), "base64").equals(bundle)).toBe(true);
    expect([...base64Chunks(Buffer.alloc(0))]).toEqual([]);
    expect(() => [...base64Chunks(bundle, 1000)]).toThrow(RangeError);
  });

  it("renders a starter patch that git applies without touching existing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "facility-kickstart-patch-"));
    try {
      await git(directory, ["init", "-q"]);
      await writeFile(join(directory, "README.md"), "# app\n");
      const patch = newFilesPatch([
        { path: ".facility.yml", content: "version: 1\nrepositories:\n  primary: local:app\n" },
        { path: ".agents/builder.md", content: "---\nname: builder\n---\nBuild." },
      ]);
      await writeFile(join(directory, "kickstart.patch"), patch);
      await git(directory, ["apply", "--check", "kickstart.patch"]);
      await git(directory, ["apply", "kickstart.patch"]);
      expect(await git(directory, ["status", "--porcelain", "--untracked-files=all"])).toContain(
        ".agents/builder.md",
      );
      expect(newFilesPatch([])).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fakeRowsDb(rows: unknown[]) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return chain as never;
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}
