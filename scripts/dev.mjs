#!/usr/bin/env node
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envLine(content, key) {
  return new RegExp(`^(\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=)([^\\r\\n]*)(\\r?)$`, "m").exec(
    content,
  );
}

function isBlankEnvValue(rawValue) {
  const value = rawValue.trim();
  return value === "" || value === "''" || value === '""' || value.startsWith("#");
}

export function envValue(content, key) {
  const match = envLine(content, key);
  if (!match || isBlankEnvValue(match[2])) return undefined;
  const value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function setEnvIfBlank(content, key, value) {
  const match = envLine(content, key);
  if (match && !isBlankEnvValue(match[2])) return { content, changed: false };
  if (match) {
    const comment = match[2].trim().startsWith("#") ? ` ${match[2].trim()}` : "";
    const replacement = `${match[1]}${value}${comment}${match[3]}`;
    return {
      content: `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`,
      changed: true,
    };
  }
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return { content: `${content}${separator}${key}=${value}\n`, changed: true };
}

export function assertLocalDatabaseUrl(value) {
  let databaseUrl;
  try {
    databaseUrl = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(databaseUrl.hostname.toLowerCase())) {
    throw new Error(
      `Development setup refuses the non-local DATABASE_URL host "${databaseUrl.hostname}"`,
    );
  }
}

export async function prepareDevEnv(
  root = repoRoot,
  {
    generateSecret = () => randomBytes(32).toString("base64"),
    generateOauthJwks = defaultOauthJwks,
    environment = process.env,
  } = {},
) {
  const envPath = join(root, ".env");
  const example = await readFile(join(root, ".env.example"), "utf8");
  let content;
  let created = false;
  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    content = example;
    created = true;
  }

  const databaseUrl = envValue(example, "DATABASE_URL");
  if (!databaseUrl) throw new Error(".env.example must define DATABASE_URL");
  const required = [["DATABASE_URL", databaseUrl]];
  if (!envValue(content, "SECRET_MASTER_KEY"))
    required.push(["SECRET_MASTER_KEY", generateSecret()]);
  if (!envValue(content, "FACILITY_OAUTH_JWKS")) {
    required.push(["FACILITY_OAUTH_JWKS", generateOauthJwks()]);
  }
  const filled = [];
  for (const [key, value] of required) {
    const next = setEnvIfBlank(content, key, value);
    if (next.changed) filled.push(key);
    content = next.content;
  }

  const effectiveDatabaseUrl =
    environment.DATABASE_URL?.trim() || envValue(content, "DATABASE_URL");
  assertLocalDatabaseUrl(effectiveDatabaseUrl);
  if (created || filled.length > 0) await writeFile(envPath, content, { mode: 0o600 });
  await chmod(envPath, 0o600);
  return {
    created,
    filled,
    databaseUrl: effectiveDatabaseUrl,
    devOrigins:
      environment.FACILITY_DEV_ORIGINS?.trim() || envValue(content, "FACILITY_DEV_ORIGINS"),
  };
}

function defaultOauthJwks() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify({
    keys: [
      { ...privateKey.export({ format: "jwk" }), alg: "ES256", use: "sig", kid: randomUUID() },
    ],
  });
}

export function assertSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number.parseInt(match?.[1] ?? "", 10);
  const minor = Number.parseInt(match?.[2] ?? "", 10);
  if (!((major === 22 && minor >= 13) || major === 24)) {
    throw new Error(
      `Node.js 24 LTS is recommended; supported versions are ^22.13.0 or ^24.0.0 (found ${version})`,
    );
  }
}

export function developmentServiceEnvironment(prepared, base = process.env) {
  const environment = { ...base, DATABASE_URL: prepared.databaseUrl };
  if (prepared.devOrigins) environment.FACILITY_DEV_ORIGINS = prepared.devOrigins;
  return environment;
}

export function run(
  command,
  args,
  { cwd = repoRoot, label = [command, ...args].join(" "), environment = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", (error) => {
      const hint =
        error.code === "ENOENT"
          ? ` Could not find ${command}; install it and make sure it is on PATH.`
          : "";
      reject(new Error(`Could not start ${label}.${hint}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new Error(`${label} stopped by ${signal}`));
      else reject(new Error(`${label} exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function startDevelopment(root = repoRoot) {
  assertSupportedNode();
  console.log("\nFacility development\n");
  const prepared = await prepareDevEnv(root);
  const environment = developmentServiceEnvironment(prepared);
  if (prepared.created) console.log("✓ Created .env from .env.example");
  if (prepared.filled.includes("SECRET_MASTER_KEY")) {
    console.log("✓ Generated SECRET_MASTER_KEY (stored only in .env)");
  }
  if (prepared.filled.includes("FACILITY_OAUTH_JWKS")) {
    console.log("✓ Generated FACILITY_OAUTH_JWKS (stored only in .env)");
  }

  await run(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", "up", "-d", "--wait", "postgres"],
    {
      cwd: root,
      label: "PostgreSQL development service",
    },
  );
  await run(pnpm, ["install"], { cwd: root, label: "pnpm install" });
  await run(
    pnpm,
    [
      "--filter",
      "@facility/core",
      "--filter",
      "@facility/agents",
      "--filter",
      "@facility/db",
      "--filter",
      "@facility/sdk",
      "--filter",
      "@facility/mcp",
      "build",
    ],
    { cwd: root, label: "shared package build" },
  );
  await run(pnpm, ["--filter", "@facility/db", "migrate"], {
    cwd: root,
    environment,
    label: "database migration",
  });
  await run(pnpm, ["--filter", "@facility/db", "seed"], {
    cwd: root,
    environment: { ...environment, FACILITY_SEED_DEMO: "1" },
    label: "database seed",
  });
  console.log("\n✓ Setup complete. Starting the UI, API, worker, and docs.");
  console.log("  Web   http://localhost:3400");
  console.log("  API   http://localhost:4400 (includes MCP)");
  console.log("  Docs  http://localhost:3500\n");
  await run(pnpm, ["run", "dev:services"], {
    cwd: root,
    environment,
    label: "Facility development processes",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startDevelopment().catch((error) => {
    console.error(`\nDevelopment startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
