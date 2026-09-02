#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GUARDS_COMMAND = "node guards/run.mjs";

export function runPlatformChecks(env = process.env) {
  const output = env.FACILITY_RECEIPT_PLATFORM_CHECKS_FILE;
  if (!output) {
    throw new Error("FACILITY_RECEIPT_PLATFORM_CHECKS_FILE is required");
  }
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const commands = [...parseCommands(env.FACILITY_RECEIPT_CHECKS_COMMANDS), GUARDS_COMMAND];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, "", "utf8");

  const results = [];
  for (const command of commands) {
    const child = spawnSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = child.status ?? 1;
    const status = exitCode === 0 ? "passed" : "failed";
    appendFileSync(
      output,
      `${JSON.stringify({
        name: command,
        command,
        status,
        exit_code: exitCode,
        self_reported: false,
      })}\n`,
      "utf8",
    );
    results.push({ command, status, exit_code: exitCode });
  }
  return results;
}

export function parseCommands(raw) {
  if (!raw?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("FACILITY_RECEIPT_CHECKS_COMMANDS must be a JSON array of shell commands");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("FACILITY_RECEIPT_CHECKS_COMMANDS must be a JSON array of shell commands");
  }
  return parsed.map((command) => String(command).trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPlatformChecks();
}
