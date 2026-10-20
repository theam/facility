#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [operation, turnId] = process.argv.slice(2);
if (!/^turn_[a-z0-9]+$/.test(turnId ?? "")) throw new Error("Invalid turn identity");
const directory = `/workspace/.facility/interactive/${turnId}`;
const socket = `${directory}/tty`;
const configPath = `${directory}/launch.json`;
const config = () => JSON.parse(readFileSync(configPath, "utf8"));

if (operation === "start") {
  const payload = readFileSync(0, "utf8");
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
    throw new Error("Native launch payload is too large");
  const input = JSON.parse(payload);
  if (!["claude_code", "codex"].includes(input.engine) || !Array.isArray(input.args))
    throw new Error("Invalid engine launch");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(socket) && !existsSync(`${directory}/exit`)) {
    writeFileSync(`${directory}/instructions.md`, String(input.instructions ?? ""), {
      mode: 0o600,
    });
    if (input.engine === "codex") {
      const hooksPath = "/workspace/.facility/codex/hooks.json";
      const existing = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : {};
      existing.hooks ??= {};
      for (const name of ["UserPromptSubmit", "PermissionRequest", "Stop"]) {
        const groups = existing.hooks[name] ?? [];
        existing.hooks[name] = [
          ...groups.filter(
            (group) => !group.hooks?.some((hook) => hook.command === "facility-session-hook"),
          ),
          { hooks: [{ type: "command", command: "facility-session-hook", timeout: 3 }] },
        ];
      }
      writeFileSync(hooksPath, JSON.stringify(existing), { mode: 0o600 });
    }
    const { instructions: _instructions, ...configuration } = input;
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    const started = spawnSync(
      "dtach",
      ["-n", socket, "-E", process.execPath, process.argv[1], "run", turnId],
      {
        cwd: input.cwd,
        env: { ...process.env, FACILITY_SESSION_DIRECTORY: directory },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (started.status !== 0) throw new Error("Could not start native terminal");
    const deadline = Date.now() + 10_000;
    while (
      !existsSync(`${directory}/pid`) &&
      !existsSync(`${directory}/exit`) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (!existsSync(`${directory}/pid`) && !existsSync(`${directory}/exit`))
      throw new Error("Native terminal launch has not been acknowledged");
  }
} else if (operation === "probe") {
  console.log(JSON.stringify({ started: existsSync(socket) || existsSync(`${directory}/exit`) }));
} else if (operation === "run") {
  const input = config();
  const child = spawn(input.engine === "codex" ? "codex" : "claude", input.args, {
    stdio: "inherit",
  });
  writeFileSync(`${directory}/pid`, String(child.pid), { mode: 0o600 });
  // SIGTERM lets the native agent flush its session before the slot is released.
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("error", () => {
    writeFileSync(`${directory}/exit`, "127", { mode: 0o600 });
    process.exit(127);
  });
  child.on("exit", (code) => {
    writeFileSync(`${directory}/exit`, String(code ?? 1), { mode: 0o600 });
    process.exit(code ?? 1);
  });
} else if (operation === "stop") {
  if (existsSync(socket) && !existsSync(`${directory}/pid`) && !existsSync(`${directory}/exit`))
    throw new Error("Native terminal is still starting; retry shutdown before releasing ownership");
  if (existsSync(`${directory}/pid`) && !existsSync(`${directory}/exit`)) {
    const pid = Number(readFileSync(`${directory}/pid`, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid native process");
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!environment.split("\0").includes(`FACILITY_SESSION_DIRECTORY=${directory}`))
      throw new Error("Native process identity changed");
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${directory}/exit`) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!existsSync(`${directory}/exit`)) throw new Error("Native process has not stopped");
  }
} else if (operation === "read") {
  const input = JSON.parse(process.env.FACILITY_SESSION_READ);
  const base =
    input.engine === "codex"
      ? "/workspace/.facility/codex/sessions"
      : "/workspace/.facility/claude/projects";
  const files = [];
  function walk(path) {
    if (!existsSync(path)) return;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, item.name);
      if (item.isDirectory()) walk(name);
      else if (item.isFile() && item.name.endsWith(".jsonl")) files.push(name);
    }
  }
  walk(base);
  const candidates = input.empty
    ? []
    : files.filter(
        (file) =>
          !file.includes("/subagents/") &&
          (input.nativeSessionId
            ? file.includes(input.nativeSessionId)
            : statSync(file).mtimeMs >= input.notBefore),
      );
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const file = candidates[0];
  const result = {
    records: [],
    hooks: [],
    bytes: 0,
    nativeSessionId: input.nativeSessionId ?? null,
    exited: existsSync(`${directory}/exit`),
  };
  if (file) {
    if (statSync(file).size > 32 * 1024 * 1024)
      throw new Error("Native session exceeds the import size limit");
    const data = readFileSync(file, "utf8");
    const complete = data.lastIndexOf("\n") + 1;
    result.bytes = complete;
    for (const line of data.slice(0, complete).split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "session_meta")
        result.nativeSessionId = event.payload?.id ?? result.nativeSessionId;
      if (event.sessionId) result.nativeSessionId = event.sessionId;
      result.records.push(event);
    }
  }
  if (existsSync(`${directory}/hooks.jsonl`)) {
    const hooks = readFileSync(`${directory}/hooks.jsonl`, "utf8");
    result.hooks = hooks
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-100);
  }
  console.log(JSON.stringify(result));
} else throw new Error("Unknown session operation");
