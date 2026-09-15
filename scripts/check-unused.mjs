#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageFiles = walk(root).filter((path) => basename(path) === "package.json");
const packages = new Set(
  packageFiles.map((path) => JSON.parse(readFileSync(path, "utf8")).name).filter(Boolean),
);
const violations = [];

for (const path of packageFiles) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (dependency.startsWith("@facility/") && !packages.has(dependency)) {
        violations.push(`${relative(root, path)}: ${section} references missing ${dependency}`);
      }
    }
  }
}

for (const removed of [
  "services/gateway",
  "services/mcp",
  "services/preview",
  "services/watchtower",
  "packages/harness",
  "packages/run-objective",
]) {
  if (walk(join(root, removed)).length > 0) {
    violations.push(`${removed}: removed component still contains source files`);
  }
}

const forbiddenReferences = [
  "@facility/harness",
  "@facility/run-objective",
  "FACILITY_SANDBOX_DRIVER",
  "FACILITY_RUNNER_IMAGE",
  "SANDBOX_API_URL",
  "SANDBOX_GATEWAY_URL",
  "GATEWAY_PORT",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
];
const productionFiles = [
  ...walk(join(root, "apps", "web")),
  ...walk(join(root, "services")),
  ...walk(join(root, "packages")),
  ...walk(join(root, "runner")),
  ...walk(join(root, ".github")),
  join(root, "docker-compose.yml"),
  join(root, "docker-compose.dev.yml"),
  join(root, ".env.example"),
].filter(
  (path) =>
    existsSync(path) &&
    !path.includes("/node_modules/") &&
    !path.includes("/dist/") &&
    !path.includes("/.next/") &&
    !path.includes("/migrations/") &&
    !path.includes("/test/") &&
    !path.endsWith("/scripts/check-unused.mjs"),
);
for (const path of productionFiles) {
  if (!statSync(path).isFile()) continue;
  const source = readFileSync(path, "utf8");
  for (const reference of forbiddenReferences) {
    if (source.includes(reference)) {
      violations.push(`${relative(root, path)}: references removed ${reference}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Removed Facility components still have consumers:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `No removed package, import, environment, or deployment references found (${packageFiles.length} package manifests checked).`,
);

function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".next", ".turbo", "build", "dist", "node_modules"].includes(entry.name)) {
        return [];
      }
      return walk(path);
    }
    return entry.isFile() ? [path] : [];
  });
}
