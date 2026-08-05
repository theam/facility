import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitCode, trustClaudeWorkspace } from "../src/index.js";

describe("Claude Code workspace trust integration", () => {
  it("is readable by a non-interactive engine child through its HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "facility-claude-home-"));
    const workspace = join(home, "repo");
    await mkdir(workspace);
    await trustClaudeWorkspace(workspace, home, {});

    const script = [
      "const fs=require('node:fs')",
      "const path=require('node:path')",
      "const config=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude.json'),'utf8'))",
      "process.stdout.write(JSON.stringify(config.projects[process.cwd()]))",
    ].join(";");
    const child = spawn(process.execPath, ["-e", script], {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));

    await expect(exitCode(child)).resolves.toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ hasTrustDialogAccepted: true });
  });
});
