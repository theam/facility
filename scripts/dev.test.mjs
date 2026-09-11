import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLocalDatabaseUrl,
  assertSupportedNode,
  developmentServiceEnvironment,
  prepareDevEnv,
  setEnvIfBlank,
} from "./dev.mjs";

const example = [
  "DATABASE_URL=postgres://facility:facility@localhost:5461/facility",
  "SECRET_MASTER_KEY=",
  "FACILITY_OAUTH_JWKS=",
  "FACILITY_INSECURE_DEV=1",
  "",
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "facility-dev-"));
  await writeFile(join(root, ".env.example"), example);
  return root;
}

test("creates a private local env and fills generated secrets", async () => {
  const root = await fixture();
  const result = await prepareDevEnv(root, {
    generateSecret: () => Buffer.alloc(32, 7).toString("base64"),
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: {},
  });
  assert.deepEqual(result, {
    created: true,
    filled: ["SECRET_MASTER_KEY", "FACILITY_OAUTH_JWKS"],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
    devOrigins: undefined,
  });
  assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o600);
});

test("preserves configured values and is byte-stable on rerun", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), `${example}CUSTOM_VALUE=keep-me\n`);
  await prepareDevEnv(root, {
    generateSecret: () => "first-secret",
    generateOauthJwks: () => "first-jwks",
    environment: {},
  });
  const first = await readFile(join(root, ".env"), "utf8");
  const result = await prepareDevEnv(root, {
    generateSecret: () => "second-secret",
    generateOauthJwks: () => "second-jwks",
    environment: {},
  });
  assert.deepEqual(result.filled, []);
  assert.equal(await readFile(join(root, ".env"), "utf8"), first);
  assert.doesNotMatch(first, /second-secret/);
});

test("replaces an empty assignment without dropping its comment", () => {
  const result = setEnvIfBlank(
    "SECRET_MASTER_KEY= # generated locally\n",
    "SECRET_MASTER_KEY",
    "secret",
  );
  assert.equal(result.content, "SECRET_MASTER_KEY=secret # generated locally\n");
});

test("refuses a remote database before changing the env file", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), example);
  assert.doesNotThrow(() =>
    assertLocalDatabaseUrl("postgres://facility:facility@127.0.0.1:5461/facility"),
  );
  await assert.rejects(
    prepareDevEnv(root, {
      environment: { DATABASE_URL: "postgres://facility:secret@db.example.com/facility" },
    }),
    /refuses the non-local DATABASE_URL host "db.example.com"/,
  );
  assert.equal(await readFile(join(root, ".env"), "utf8"), example);
});

test("supports the declared Node LTS lines", () => {
  for (const version of ["22.13.0", "24.0.0", "24.11.1"]) {
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
  for (const version of ["22.12.0", "23.11.1", "25.1.0", "not-a-version"]) {
    assert.throws(() => assertSupportedNode(version), /Node\.js 24 LTS is recommended/);
  }
});

test("passes only current development process settings", () => {
  const prepared = {
    databaseUrl: "postgres://facility:facility@localhost:5461/facility_test",
    devOrigins: "tunnel.example.dev",
  };
  assert.deepEqual(developmentServiceEnvironment(prepared, { KEEP: "yes" }), {
    KEEP: "yes",
    DATABASE_URL: prepared.databaseUrl,
    FACILITY_DEV_ORIGINS: "tunnel.example.dev",
  });
});
