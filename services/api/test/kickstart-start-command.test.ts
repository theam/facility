import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferStartCommand } from "../src/github/kickstart.js";

const files = (entries: Record<string, unknown>) =>
  new Map(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === "string" ? content : JSON.stringify(content),
    ]),
  );

describe("kickstart start command", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("proposes a package dev or start script detached, with its output in the workspace", () => {
    expect(inferStartCommand(files({ "package.json": { scripts: { dev: "vite" } } }), "npm")).toBe(
      "nohup npm run dev >>/workspace/.facility/start.log 2>&1 </dev/null &",
    );
    expect(
      inferStartCommand(
        files({ "package.json": { scripts: { start: "node server.js" } }, "pnpm-lock.yaml": "" }),
        "none",
      ),
    ).toBe("nohup pnpm start >>/workspace/.facility/start.log 2>&1 </dev/null &");
  });

  it("keeps Compose and the explicit failure unchanged", () => {
    expect(
      inferStartCommand(
        files({ "compose.yaml": "", "package.json": { scripts: { dev: "x" } } }),
        "npm",
      ),
    ).toBe("docker compose up -d");
    expect(inferStartCommand(files({ "package.json": { scripts: {} } }), "npm")).toBe(
      "echo 'Configure environment.start in .facility.yml' >&2; exit 1",
    );
  });

  it("returns while the server keeps running, even when the caller waits for its output to close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "facility-start-"));
    const server = `require("node:fs").writeFileSync("server.pid", String(process.pid)); setInterval(() => {}, 1000)`;
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: `node -e '${server}'` } }),
    );
    let serverPid = 0;
    cleanups.push(() => {
      if (serverPid) process.kill(serverPid);
      rmSync(dir, { recursive: true, force: true });
    });
    const command = inferStartCommand(
      files({ "package.json": readFileSync(join(dir, "package.json"), "utf8") }),
      "npm",
    ).replace("/workspace/.facility/start.log", join(dir, "start.log"));

    // A workspace exec resolves only after the command exits and its stdout and stderr close.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("sh", ["-c", command], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("start did not return"));
      }, 4_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);

    await expect
      .poll(() => {
        try {
          serverPid = Number(readFileSync(join(dir, "server.pid"), "utf8"));
          return serverPid > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    expect(() => process.kill(serverPid, 0)).not.toThrow();
  });
});
