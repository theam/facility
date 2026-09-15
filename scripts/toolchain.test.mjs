import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Add future even-numbered LTS lines only after they have explicit CI coverage.
const nodeRange = "^22.13.0 || ^24.0.0";
const packageManager = "pnpm@11.20.0";

async function read(path) {
  return readFile(join(root, path), "utf8");
}

test("first-party manifests share the supported Node LTS contract", async () => {
  for (const path of ["package.json", "apps/docs/package.json", "packages/cli/package.json"]) {
    const manifest = JSON.parse(await read(path));
    assert.equal(manifest.engines?.node, nodeRange, `${path} has a different Node contract`);
  }

  const rootManifest = JSON.parse(await read("package.json"));
  assert.equal(rootManifest.packageManager, packageManager);
  assert.equal((await read(".nvmrc")).trim(), "24");
});

test("CI defaults to Node 24 and tests the exact Node 22 floor once", async () => {
  const workflowDirectory = join(root, ".github", "workflows");
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  const declaredVersions = [];

  for (const name of workflowNames) {
    const workflow = await read(join(".github", "workflows", name));
    const versions = [...workflow.matchAll(/node-version:\s*([^\s#]+)/g)].map((match) => match[1]);
    declaredVersions.push(...versions.map((version) => ({ name, version })));
    for (const version of versions) {
      assert.ok(
        version === "24" || (name === "ci.yml" && version === "22.13.0"),
        `${name} declares unexpected Node version ${version}`,
      );
    }
  }

  assert.ok(declaredVersions.some(({ version }) => version === "24"), "CI must declare Node 24");
  assert.equal(
    declaredVersions.filter(({ version }) => version === "22.13.0").length,
    1,
    "CI must exercise the minimum Node version exactly once",
  );

  const ci = await read(".github/workflows/ci.yml");
  const minimumNodeJob = ci.split("\n  package-release:")[0].split("\n  minimum-node:")[1];
  assert.ok(minimumNodeJob, "CI must contain a minimum-node job");
  assert.match(minimumNodeJob, /node-version: 22\.13\.0/);
  assert.match(minimumNodeJob, /pnpm build\n/);
  assert.match(minimumNodeJob, /pnpm test:uncached\n/);
  assert.match(minimumNodeJob, /pnpm --filter @theagilemonkeys\/facility test\n/);
});

test("setup documentation installs the package-manager pin", async () => {
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "apps/docs/docs/self-host/quickstart.md",
    "apps/docs/docs/self-host/local-development.md",
  ]) {
    const documentation = await read(path);
    assert.match(documentation, /pnpm(?:@| )11\.20\.0/);
    assert.match(documentation, /corepack install --global pnpm@11\.20\.0/);
  }
});
