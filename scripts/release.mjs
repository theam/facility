#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@theagilemonkeys/facility";
export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

export function releaseMode({ eventName, ref, visibility, acceptancePassed, releaseDecided }) {
  if (eventName === "workflow_dispatch") return "dry-run";
  if (
    eventName === "push" &&
    ref === "refs/heads/main" &&
    releaseDecided === true &&
    visibility === "public" &&
    acceptancePassed === true
  ) {
    return "publish";
  }
  return "skip";
}

/**
 * What proves a release is no longer a tag someone pushed: it is the version
 * decided from the commit subjects (scripts/version.mjs), stamped into the two
 * package.json files inside this run. CI allocates the tag after acceptance
 * and before either registry can consume the version. The checks here are that
 * the run is a push of main, that the stamp matches the decision, and that the
 * commit really is the head of main — plus the guard that outlives all of them,
 * in `registryState`, which refuses a conflicting version npm already has.
 */
export function validateReleasePolicy({
  eventName,
  ref,
  visibility,
  rootVersion,
  packageVersion,
  decidedVersion,
  headSha,
  checkoutSha,
  isOnMain,
}) {
  if (eventName !== "push") throw new Error("a real release must come from a push event");
  if (visibility !== "public") throw new Error("npm publishing is disabled until the repository is public");
  if (ref !== "refs/heads/main") {
    throw new Error(`a release must come from main, not ${ref || "an unknown ref"}`);
  }
  if (!decidedVersion) {
    throw new Error("no release version was decided for this commit");
  }
  if (!rootVersion || rootVersion !== packageVersion) {
    throw new Error(
      `root package version (${rootVersion || "missing"}) does not match CLI package version (${packageVersion || "missing"})`,
    );
  }
  if (packageVersion !== decidedVersion) {
    throw new Error(
      `stamped version ${packageVersion} does not match the decided version ${decidedVersion}`,
    );
  }
  if (!headSha || checkoutSha !== headSha) {
    throw new Error(`checked-out commit ${checkoutSha || "missing"} does not match event SHA ${headSha || "missing"}`);
  }
  if (!isOnMain) throw new Error("release commit is not reachable from origin/main");

  return { packageName: PACKAGE_NAME, version: packageVersion, tag: `v${packageVersion}` };
}

export function validateReleaseCandidate({
  repoDir = process.cwd(),
  eventName = process.env.GITHUB_EVENT_NAME,
  ref = process.env.GITHUB_REF,
  visibility = process.env.GITHUB_REPOSITORY_VISIBILITY,
  headSha = process.env.GITHUB_SHA,
  decidedVersion = process.env.FACILITY_RELEASE_VERSION,
} = {}) {
  const rootVersion = readJson(join(repoDir, "package.json")).version;
  const cliPackage = readJson(join(repoDir, "packages/cli/package.json"));
  if (cliPackage.name !== PACKAGE_NAME) {
    throw new Error(`CLI package is ${cliPackage.name || "unnamed"}, expected ${PACKAGE_NAME}`);
  }

  const checkoutSha = git(repoDir, ["rev-parse", "HEAD"]);
  const isOnMain =
    spawnSync("git", ["merge-base", "--is-ancestor", checkoutSha, "origin/main"], {
      cwd: repoDir,
      stdio: "ignore",
    }).status === 0;

  return validateReleasePolicy({
    eventName,
    ref: ref || "",
    visibility,
    rootVersion,
    packageVersion: cliPackage.version,
    decidedVersion,
    headSha,
    checkoutSha,
    isOnMain,
  });
}

/**
 * Writes the decided version into the two package.json files the release reads.
 * This happens inside the run and is never committed: tags allocate immutable
 * versions, so main carries no version-bump commits and the two files cannot
 * drift apart between releases.
 */
export function stampVersion(version, { repoDir = process.cwd() } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error(`refusing to stamp a version that is not a semver triple: ${version || "missing"}`);
  }
  const stamped = [];
  for (const relative of ["package.json", "packages/cli/package.json"]) {
    const path = join(repoDir, relative);
    const manifest = readJson(path);
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    stamped.push(relative);
  }
  return { version, stamped };
}

export function inspectTarball(tarball, { exec = execFileSync } = {}) {
  const absolute = resolve(tarball);
  let manifest;
  try {
    manifest = JSON.parse(
      exec("tar", ["-xOf", absolute, "package/package.json"], { encoding: "utf8" }),
    );
  } catch (error) {
    throw new Error(`cannot read package/package.json from ${absolute}: ${error.message}`);
  }
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`tarball contains ${manifest.name || "an unnamed package"}, expected ${PACKAGE_NAME}`);
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("tarball package version is missing");
  }
  return { path: absolute, name: manifest.name, version: manifest.version };
}

export function validateWorkspaceArtifact(tarball, { repoDir = process.cwd() } = {}) {
  const artifact = inspectTarball(tarball);
  const rootVersion = readJson(join(repoDir, "package.json")).version;
  const cliPackage = readJson(join(repoDir, "packages/cli/package.json"));
  if (cliPackage.name !== PACKAGE_NAME) {
    throw new Error(`CLI package is ${cliPackage.name || "unnamed"}, expected ${PACKAGE_NAME}`);
  }
  if (rootVersion !== cliPackage.version || artifact.version !== cliPackage.version) {
    throw new Error(
      `release versions disagree: root=${rootVersion || "missing"}, CLI=${cliPackage.version || "missing"}, tarball=${artifact.version || "missing"}`,
    );
  }
  return artifact;
}

export async function registryState({
  tarball,
  registryUrl = process.env.NPM_CONFIG_REGISTRY || OFFICIAL_REGISTRY,
  fetchImpl = globalThis.fetch,
  officialOnly = false,
  timeoutMs = 10_000,
} = {}) {
  const artifact = inspectTarball(tarball);
  const registry = normalizeRegistry(registryUrl, { officialOnly });
  const packageUrl = new URL(encodeURIComponent(artifact.name), registry);
  let response;
  try {
    response = await fetchImpl(packageUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`npm registry lookup failed closed: ${error.message}`);
  }

  if (response.status === 404) return { state: "missing", artifact, registry };
  if (!response.ok) {
    throw new Error(`npm registry lookup failed closed with HTTP ${response.status}`);
  }

  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new Error(`npm registry returned malformed package metadata: ${error.message}`);
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.name !== artifact.name ||
    !metadata.versions ||
    typeof metadata.versions !== "object" ||
    Array.isArray(metadata.versions)
  ) {
    throw new Error("npm registry returned malformed package metadata");
  }
  if (Object.hasOwn(metadata.versions, artifact.version)) {
    const published = metadata.versions[artifact.version];
    const publishedIntegrity =
      published && typeof published === "object" && !Array.isArray(published)
        ? published.dist?.integrity
        : undefined;
    const candidateIntegrity = tarballIntegrity(artifact.path);
    if (publishedIntegrity !== candidateIntegrity) {
      throw new Error(
        `${artifact.name}@${artifact.version} is already published with different contents; refusing conflicting replay`,
      );
    }
    return { state: "published", artifact, registry };
  }
  return { state: "existing", artifact, registry };
}

export function publishTarball({
  tarball,
  authMode,
  registryUrl = process.env.NPM_CONFIG_REGISTRY || OFFICIAL_REGISTRY,
  npmCommand = "npm",
  env = process.env,
  spawn = spawnSync,
  allowNonOfficialRegistry = false,
} = {}) {
  const artifact = inspectTarball(tarball);
  const registry = normalizeRegistry(registryUrl, {
    officialOnly: authMode !== "dry-run" && !allowNonOfficialRegistry,
  });
  const childEnv = scrubNpmCredentials({ ...env });
  const args = [
    "publish",
    artifact.path,
    "--access",
    "public",
    "--registry",
    registry.href,
    "--ignore-scripts",
  ];

  const isolatedCwd = mkdtempSync(join(tmpdir(), "facility-publish-"));
  const userConfig = join(isolatedCwd, "user.npmrc");
  const globalConfig = join(isolatedCwd, "global.npmrc");
  try {
    childEnv.NPM_CONFIG_REGISTRY = registry.href;
    childEnv.NPM_CONFIG_USERCONFIG = userConfig;
    childEnv.NPM_CONFIG_GLOBALCONFIG = globalConfig;
    writeFileSync(globalConfig, "", { mode: 0o600 });

    if (authMode === "bootstrap") {
      if (!env.NODE_AUTH_TOKEN) {
        throw new Error("NPM_BOOTSTRAP_TOKEN is required for the first package publication");
      }
      childEnv.NODE_AUTH_TOKEN = env.NODE_AUTH_TOKEN;
      writeFileSync(
        userConfig,
        `registry=${registry.href}\n//${registry.host}${registry.pathname}:_authToken=\${NODE_AUTH_TOKEN}\n`,
        { mode: 0o600 },
      );
      if (!allowNonOfficialRegistry) args.push("--provenance");
    } else if (authMode === "oidc" || authMode === "dry-run") {
      writeFileSync(userConfig, `registry=${registry.href}\n`, { mode: 0o600 });
      if (authMode === "oidc" && !allowNonOfficialRegistry) args.push("--provenance");
      if (authMode === "dry-run") {
        delete childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        delete childEnv.ACTIONS_ID_TOKEN_REQUEST_URL;
        args.push("--dry-run");
      }
    } else {
      throw new Error(`unsupported npm authentication mode: ${authMode || "missing"}`);
    }

    const result = spawn(npmCommand, args, { cwd: isolatedCwd, env: childEnv, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm publish failed with exit ${result.status ?? "unknown"}`);
    }
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
  return artifact;
}

export async function publishRelease({
  tarball,
  authMode,
  registryUrl = OFFICIAL_REGISTRY,
  fetchImpl = globalThis.fetch,
  env = process.env,
  spawn = spawnSync,
  npmCommand = "npm",
  allowNonOfficialRegistry = false,
} = {}) {
  if (authMode !== "bootstrap" && authMode !== "oidc") {
    throw new Error(`unsupported npm authentication mode: ${authMode || "missing"}`);
  }

  const probe = () =>
    registryState({
      tarball,
      registryUrl,
      fetchImpl,
      officialOnly: !allowNonOfficialRegistry,
    });
  const firstState = await probe();
  if (firstState.state === "published") {
    return firstState.artifact;
  }
  if (authMode === "bootstrap" && firstState.state !== "missing") {
    throw new Error("bootstrap credentials are allowed only for the first publication");
  }
  if (authMode === "oidc" && firstState.state !== "existing") {
    throw new Error("trusted publishing requires the package to exist first");
  }
  const finalState = await probe();
  if (finalState.state !== firstState.state) {
    throw new Error("npm registry state changed during release; refusing to expose credentials");
  }

  return publishTarball({
    tarball,
    authMode,
    registryUrl,
    npmCommand,
    env,
    spawn,
    allowNonOfficialRegistry,
  });
}

export function normalizeRegistry(registryUrl, { officialOnly = false, githubActions = false } = {}) {
  let registry;
  try {
    registry = new URL(registryUrl);
  } catch {
    throw new Error(`invalid npm registry URL: ${registryUrl}`);
  }
  if (registry.username || registry.password || registry.search || registry.hash) {
    throw new Error("npm registry URL must not contain credentials, a query, or a fragment");
  }
  if (!registry.pathname.endsWith("/")) registry.pathname += "/";
  if ((officialOnly || githubActions) && registry.href !== OFFICIAL_REGISTRY) {
    throw new Error(`GitHub releases must use exactly ${OFFICIAL_REGISTRY}`);
  }
  return registry;
}

function scrubNpmCredentials(env) {
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "node_auth_token" ||
      normalized === "npm_token" ||
      (normalized.startsWith("npm_config_") &&
        (normalized.includes("auth") ||
          normalized.includes("token") ||
          normalized.endsWith("userconfig") ||
          normalized.endsWith("globalconfig") ||
          normalized.endsWith("registry")))
    ) {
      delete env[key];
    }
  }
  return env;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tarballIntegrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (/\r|\n/.test(String(value))) {
      throw new Error(`GitHub output ${key} contains a forbidden line break`);
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
  }
  console.log(JSON.stringify(values));
}

async function main([command, ...args]) {
  if (command === "stamp") {
    const version = args[0];
    const result = stampVersion(version, { repoDir: resolve(args[1] || ".") });
    output({ version: result.version, stamped: result.stamped.join(",") });
    return;
  }
  if (command === "validate") {
    if (args.length > 1 || args[0]?.startsWith("--")) {
      throw new Error("validate accepts only an optional repository directory");
    }
    output(validateReleaseCandidate({ repoDir: resolve(args[0] || ".") }));
    return;
  }

  const tarballCommands = new Set(["artifact", "registry-state", "dry-run", "publish"]);
  if (!tarballCommands.has(command)) {
    throw new Error(`unknown release command: ${command || "missing"}`);
  }

  const options = args.filter((arg) => arg.startsWith("--"));
  const tarballs = args.filter((arg) => !arg.startsWith("--"));
  if (tarballs.length !== 1) throw new Error(`${command || "command"} requires exactly one tarball`);
  const tarball = tarballs[0];

  let auth;
  if (command === "publish") {
    if (options.length !== 1 || !options[0].startsWith("--auth=")) {
      throw new Error("publish requires exactly one --auth=oidc or --auth=bootstrap option");
    }
    auth = options[0].slice("--auth=".length);
    if (auth !== "oidc" && auth !== "bootstrap") {
      throw new Error("publish requires exactly one --auth=oidc or --auth=bootstrap option");
    }
  } else if (options.length > 0) {
    throw new Error(`${command} does not accept options`);
  }

  if (command === "artifact") {
    const artifact = validateWorkspaceArtifact(tarball);
    output({ package: artifact.name, version: artifact.version, path: artifact.path });
    return;
  }

  validateWorkspaceArtifact(tarball);

  if (command === "registry-state") {
    const result = await registryState({
      tarball,
      registryUrl: OFFICIAL_REGISTRY,
      officialOnly: true,
    });
    output({ state: result.state, package: result.artifact.name, version: result.artifact.version });
    return;
  }
  if (command === "dry-run") {
    publishTarball({ tarball, authMode: "dry-run" });
    return;
  }
  if (command === "publish") {
    await publishRelease({ tarball, authMode: auth });
    return;
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
