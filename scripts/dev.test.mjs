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
  usesLocalStorage,
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

test("creates a private dev env and fills its generated secret", async () => {
  const root = await fixture();
  const secret = Buffer.alloc(32, 7).toString("base64");

  const result = await prepareDevEnv(root, {
    generateSecret: () => secret,
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: {},
  });
  const content = await readFile(join(root, ".env"), "utf8");
  const mode = (await stat(join(root, ".env"))).mode & 0o777;

  assert.deepEqual(result, {
    created: true,
    filled: ["SECRET_MASTER_KEY", "FACILITY_OAUTH_JWKS"],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
    s3Endpoint: undefined,
    localStorage: true,
    devOrigins: undefined,
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
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: {},
  });
  const content = await readFile(join(root, ".env"), "utf8");

  assert.deepEqual(result, {
    created: false,
    filled: ["DATABASE_URL", "FACILITY_OAUTH_JWKS"],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
    s3Endpoint: undefined,
    localStorage: true,
    devOrigins: undefined,
  });
  assert.match(content, /^SECRET_MASTER_KEY=already-configured$/m);
  assert.match(content, /^CUSTOM_VALUE=keep-me$/m);
  assert.doesNotMatch(content, /must-not-be-used/);
  assert.match(content, /^FACILITY_OAUTH_JWKS=\{"keys":\[\{"kid":"test"\}\]\}$/m);
  assert.equal(generated, false);
});

test("rerunning env preparation is byte-stable", async () => {
  const root = await fixture();
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
  const second = await readFile(join(root, ".env"), "utf8");

  assert.deepEqual(result, {
    created: false,
    filled: [],
    databaseUrl: "postgres://facility:facility@localhost:5461/facility",
    s3Endpoint: undefined,
    localStorage: true,
    devOrigins: undefined,
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

test("classifies local and MinIO endpoints as bundled storage", () => {
  // Unset or blank keeps the local default.
  assert.equal(usesLocalStorage(undefined), true);
  assert.equal(usesLocalStorage(""), true);
  assert.equal(usesLocalStorage("   "), true);
  // Loopback and the compose service name are the bundled MinIO.
  assert.equal(usesLocalStorage("http://localhost:9000"), true);
  assert.equal(usesLocalStorage("http://127.0.0.1:9000"), true);
  assert.equal(usesLocalStorage("https://[::1]:9000"), true);
  assert.equal(usesLocalStorage("http://minio:9000"), true);
  // A loopback hostname can also host LocalStack or another external store;
  // only the bundled MinIO port selects the profile.
  assert.equal(usesLocalStorage("http://localhost:4566"), false);
});

test("classifies external S3-compatible endpoints as external storage", () => {
  assert.equal(usesLocalStorage("https://s3.us-east-1.amazonaws.com"), false);
  assert.equal(usesLocalStorage("https://accountid.r2.cloudflarestorage.com"), false);
  assert.equal(usesLocalStorage("https://minio.example.com:9000"), false);
  // An unparseable value must not be treated as local; we cannot classify it.
  assert.equal(usesLocalStorage("not a url"), false);
});

test("resolves the effective S3 endpoint from the env file", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), `${example}S3_ENDPOINT=http://localhost:9000\n`);

  const result = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: {},
  });

  assert.equal(result.s3Endpoint, "http://localhost:9000");
  assert.equal(result.localStorage, true);
});

test("an exported S3 endpoint overrides the env file and selects external storage", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), `${example}S3_ENDPOINT=http://localhost:9000\n`);

  const exported = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: { S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com" },
  });
  assert.equal(exported.s3Endpoint, "https://s3.us-east-1.amazonaws.com");
  assert.equal(exported.localStorage, false);

  // A blank exported endpoint falls back to the env file's local value.
  const blank = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: { S3_ENDPOINT: "   " },
  });
  assert.equal(blank.s3Endpoint, "http://localhost:9000");
  assert.equal(blank.localStorage, true);
});

test("requires Node.js 22 or newer", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.0.0"));
  assert.throws(() => assertSupportedNode("21.7.3"), /Node\.js 22 or newer is required/);
});

test("development services use the compose network unless the operator selects one", () => {
  const prepared = {
    databaseUrl: "postgres://facility:facility@localhost:5461/facility_e2e",
    devOrigins: "tunnel.example.dev",
  };
  assert.deepEqual(developmentServiceEnvironment(prepared, { KEEP: "yes" }), {
    KEEP: "yes",
    DATABASE_URL: prepared.databaseUrl,
    FACILITY_DEV_ORIGINS: "tunnel.example.dev",
    FACILITY_SANDBOX_DOCKER_NETWORK: "facility-dev_default",
  });
  assert.equal(
    developmentServiceEnvironment(prepared, {
      FACILITY_SANDBOX_DOCKER_NETWORK: "custom-runner-network",
    }).FACILITY_SANDBOX_DOCKER_NETWORK,
    "custom-runner-network",
  );
});

test("surfaces the development origins so the web server can receive them", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env"),
    `${example}FACILITY_DEV_ORIGINS=tunnel.example.dev, lab.example.dev\n`,
  );

  const result = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: {},
  });

  // Next is spawned from apps/web and never reads the repository-root .env,
  // so the value has to travel through the child environment instead.
  assert.equal(result.devOrigins, "tunnel.example.dev, lab.example.dev");
});

test("an exported development origin overrides the env file, and a blank one is absent", async () => {
  const root = await fixture();
  await writeFile(join(root, ".env"), `${example}FACILITY_DEV_ORIGINS=from-file.example.dev\n`);

  const exported = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: { FACILITY_DEV_ORIGINS: "from-shell.example.dev" },
  });
  assert.equal(exported.devOrigins, "from-shell.example.dev");

  const blank = await prepareDevEnv(root, {
    generateSecret: () => "local-secret",
    generateOauthJwks: () => '{"keys":[{"kid":"test"}]}',
    environment: { FACILITY_DEV_ORIGINS: "   " },
  });
  assert.equal(blank.devOrigins, "from-file.example.dev");
});
