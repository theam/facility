#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  const pattern = new RegExp(
    `^(\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=)([^\\r\\n]*)(\\r?)$`,
    "m",
  );
  return pattern.exec(content);
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
  { generateSecret = () => randomBytes(32).toString("base64"), environment = process.env } = {},
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

  const filled = [];
  const databaseUrl = envValue(example, "DATABASE_URL");
  if (!databaseUrl) throw new Error(".env.example must define DATABASE_URL");

  const required = [["DATABASE_URL", databaseUrl]];
  if (!envValue(content, "SECRET_MASTER_KEY")) {
    required.push(["SECRET_MASTER_KEY", generateSecret()]);
  }

  for (const [key, value] of required) {
    const next = setEnvIfBlank(content, key, value);
    if (next.changed) filled.push(key);
    content = next.content;
  }

  const exportedDatabaseUrl = environment.DATABASE_URL?.trim();
  const effectiveDatabaseUrl = exportedDatabaseUrl || envValue(content, "DATABASE_URL");
  assertLocalDatabaseUrl(effectiveDatabaseUrl);
  if (created || filled.length > 0) {
    await writeFile(envPath, content, { mode: 0o600 });
  }
  // Keep a pre-existing secrets file owner-only too; a no-op rerun must not
  // preserve accidentally broad permissions.
  await chmod(envPath, 0o600);
  return { created, filled, databaseUrl: effectiveDatabaseUrl };
}

export function assertSupportedNode(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or newer is required (found ${version})`);
  }
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
  const environment = { ...process.env, DATABASE_URL: prepared.databaseUrl };
  if (prepared.created) console.log("✓ Created .env from .env.example");
  if (prepared.filled.includes("DATABASE_URL"))
    console.log("✓ Added the local development database URL");
  if (prepared.filled.includes("SECRET_MASTER_KEY")) {
    console.log("✓ Generated SECRET_MASTER_KEY (stored only in .env)");
  }
  if (!prepared.created && prepared.filled.length === 0)
    console.log("✓ Preserved the existing .env");

  console.log("→ Starting Postgres and MinIO");
  const compose = ["compose", "-f", "docker-compose.dev.yml"];
  await run("docker", [...compose, "up", "-d", "--wait", "postgres", "minio"], {
    cwd: root,
    label: "Docker development infrastructure",
  });
  await run("docker", [...compose, "run", "--rm", "--no-deps", "createbuckets"], {
    cwd: root,
    label: "MinIO bucket setup",
  });

  console.log("→ Installing workspace dependencies");
  await run(pnpm, ["install"], {
    cwd: root,
    label: "pnpm install",
  });

  console.log("→ Building shared workspace packages");
  await run(
    pnpm,
    [
      "--filter",
      "@facility/core",
      "--filter",
      "@facility/db",
      "--filter",
      "@facility/sdk",
      "--filter",
      "@facility/harness",
      "build",
    ],
    { cwd: root, label: "shared package build" },
  );

  console.log("→ Migrating and seeding the database");
  await run(pnpm, ["--filter", "@facility/db", "migrate"], {
    cwd: root,
    environment,
    label: "database migration",
  });
  await run(pnpm, ["--filter", "@facility/db", "seed"], {
    cwd: root,
    environment,
    label: "database seed",
  });

  console.log("\n✓ Setup complete. Starting all development processes, including the worker.");
  console.log("  Web      http://localhost:3400");
  console.log("  API      http://localhost:4400");
  console.log("  Gateway  http://localhost:4410");
  console.log("  Docs     http://localhost:3500");
  console.log("\nCtrl-C stops the development processes; Docker infrastructure stays running.\n");
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
