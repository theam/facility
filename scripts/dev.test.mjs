import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLocalDatabaseUrl,
  assertSupportedNode,
  prepareDevEnv,
  setEnvIfBlank,
} from "./dev.mjs";

const example = [
  "DATABASE_URL=postgres://facility:facility@localhost:5461/facility",
  "SECRET_MASTER_KEY=",
  "FACILITY_INSECURE_DEV=1",
  "",
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "facility-dev-"));
  await writeFile(join(root, ".env.example"), example);
  return root;
}

test("creates a private dev env and fills its generated secret", async () => {
  const root = await fixture();
  const secret = Buffer.alloc(32, 7).toString("base64");

  const result = await prepareDevEnv(root, { generateSecret: () => secret, environment: {} });
  const content = await readFile(join(root, ".env"), "utf8");
  const mode = (await stat(join(root, ".env"))).mode & 0o777;

  assert.deepEqual(result, {
    created: true,
    filled: ["SECRET_MASTER_KEY"],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
  });
  assert.match(content, new RegExp(`^SECRET_MASTER_KEY=${secret}$`, "m"));
  assert.match(content, /^DATABASE_URL=postgres:\/\//m);
  assert.equal(mode, 0o600);
});

test("fills only missing required values and preserves existing values", async () => {
  const root = await fixture();
  let generated = false;
  const existing = [
    "# keep this file intact",
    "SECRET_MASTER_KEY=already-configured",
    "CUSTOM_VALUE=keep-me",
    "",
  ].join("\n");
  await writeFile(join(root, ".env"), existing);

  const result = await prepareDevEnv(root, {
    generateSecret: () => {
      generated = true;
      return "must-not-be-used";
    },
    environment: {},
  });
  const content = await readFile(join(root, ".env"), "utf8");

  assert.deepEqual(result, {
    created: false,
    filled: ["DATABASE_URL"],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
  });
  assert.match(content, /^SECRET_MASTER_KEY=already-configured$/m);
  assert.match(content, /^CUSTOM_VALUE=keep-me$/m);
  assert.doesNotMatch(content, /must-not-be-used/);
  assert.equal(generated, false);
});

test("rerunning env preparation is byte-stable", async () => {
  const root = await fixture();
  await prepareDevEnv(root, { generateSecret: () => "first-secret", environment: {} });
  const first = await readFile(join(root, ".env"), "utf8");

  const result = await prepareDevEnv(root, {
    generateSecret: () => "second-secret",
    environment: {},
  });
  const second = await readFile(join(root, ".env"), "utf8");

  assert.deepEqual(result, {
    created: false,
    filled: [],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
  });
  assert.equal(second, first);
  assert.doesNotMatch(second, /second-secret/);
});

test("replaces an empty assignment without dropping its comment", () => {
  const result = setEnvIfBlank(
    "SECRET_MASTER_KEY= # generated locally\n",
    "SECRET_MASTER_KEY",
    "secret",
  );
  assert.equal(result.content, "SECRET_MASTER_KEY=secret # generated locally\n");
  assert.equal(result.changed, true);
});

test("development setup refuses to migrate or seed a remote database", () => {
  assert.doesNotThrow(() =>
    assertLocalDatabaseUrl("postgres://facility:facility@127.0.0.1:5461/facility"),
  );
  assert.throws(
    () => assertLocalDatabaseUrl("postgres://facility:secret@db.example.com/facility"),
    /refuses the non-local DATABASE_URL host "db.example.com"/,
  );
});

test("refuses an exported remote database without changing the env file", async () => {
  const root = await fixture();
  const existing = `${example}CUSTOM_VALUE=keep-me\n`;
  await writeFile(join(root, ".env"), existing);

  await assert.rejects(
    prepareDevEnv(root, {
      environment: { DATABASE_URL: "postgres://facility:secret@db.example.com/facility" },
    }),
    /refuses the non-local DATABASE_URL host "db.example.com"/,
  );

  assert.equal(await readFile(join(root, ".env"), "utf8"), existing);
});

test("falls back to the env file when the exported database is blank", async () => {
  const root = await fixture();

  const result = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    environment: { DATABASE_URL: "  " },
  });

  assert.equal(result.databaseUrl, "postgres://facility:facility@localhost:5461/facility");
});

test("requires Node.js 22 or newer", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.0.0"));
  assert.throws(() => assertSupportedNode("21.7.3"), /Node\.js 22 or newer is required/);
});
