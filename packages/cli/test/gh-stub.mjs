import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:process";

/** Prepend a directory to PATH using the host path separator. */
export function prependPath(entry, env = process.env) {
  const existing = env.PATH?.split(delimiter).filter(Boolean) ?? [];
  return { ...env, PATH: [entry, ...existing].join(delimiter) };
}

/** Fail closed if a test accidentally reaches the real GitHub CLI. */
export function isolateGhEnv(env = {}) {
  return {
    ...env,
    GH_HOST: "gh-stub.test.invalid",
    GH_TOKEN: "gh-stub-must-not-reach-github",
    GITHUB_TOKEN: "gh-stub-must-not-reach-github",
  };
}

/** Install a cross-platform `gh` shim that invokes `stubSource` as an ESM entrypoint. */
export function installGhStub(directory, stubSource) {
  const stubPath = join(directory, "_gh-stub.mjs");
  writeFileSync(stubPath, stubSource, "utf8");
  if (platform === "win32") {
    const cmdPath = join(directory, "gh.cmd");
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${stubPath}" %*\r\n`, "utf8");
    return cmdPath;
  }
  const ghPath = join(directory, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`, "utf8");
  chmodSync(ghPath, 0o755);
  return ghPath;
}

/** POSIX-only file modes are not meaningful on NTFS. */
export function expectPrivateConfigMode(mode) {
  if (platform === "win32") return;
  return (mode & 0o777).toString(8);
}
