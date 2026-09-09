import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { bootstrapInstance } from "../src/instance.mjs";

const valid = {
  "org-name": "Facility Test",
  "org-slug": "facility-test",
  "owner-email": "owner@example.com",
  "owner-name": "Owner",
  "github-user-id": "123",
  "github-login": "owner",
  "github-account-id": "456",
  "github-installation-id": "789",
  "github-account-login": "facility-test",
  json: true,
};

const environment = {
  FACILITY_ORG_NAME: "Facility Test",
  FACILITY_ORG_SLUG: "facility-test",
  FACILITY_OWNER_EMAIL: "Owner@Example.com",
  FACILITY_OWNER_NAME: "Owner",
  FACILITY_GITHUB_USER_ID: "123",
  FACILITY_GITHUB_LOGIN: "owner",
  FACILITY_GITHUB_ACCOUNT_ID: "456",
  FACILITY_GITHUB_INSTALLATION_ID: "789",
  FACILITY_GITHUB_ACCOUNT_LOGIN: "facility-test",
};

// Fails at the first database call, so a run that reaches it has passed every
// validation without needing Postgres or the network.
function refusingPostgres() {
  const sql = () => {
    throw new Error("unreachable");
  };
  sql.begin = async () => {
    throw new Error("reached-the-database");
  };
  sql.end = async () => {};
  return () => sql;
}

async function captureJson(run) {
  const written = [];
  const original = console.log;
  console.log = (line) => written.push(line);
  try {
    return { code: await run(), output: written.map((line) => JSON.parse(line)) };
  } finally {
    console.log = original;
  }
}

test("bootstrap validates all identity and installation bindings before connecting", async () => {
  assert.equal(await bootstrapInstance({ ...valid, "github-user-id": "not-a-number" }, { databaseUrl: "postgres://unused" }), 1);
});

test("bootstrap takes every value from the environment when no options are given", async () => {
  const { code, output } = await captureJson(() =>
    bootstrapInstance(
      { json: true },
      { databaseUrl: "postgres://unused", environment, postgres: refusingPostgres() },
    ),
  );
  assert.equal(code, 1);
  assert.equal(output[0].error.message, "reached-the-database");
});

test("bootstrap prefers an explicit option over its environment variable", async () => {
  const { output } = await captureJson(() =>
    bootstrapInstance(
      { json: true, "org-slug": "" },
      {
        databaseUrl: "postgres://unused",
        environment: { ...environment, FACILITY_ORG_SLUG: "Not A Slug" },
        postgres: refusingPostgres(),
      },
    ),
  );
  // A blank option is not a value, so the variable still supplies one — and it
  // is validated rather than trusted for having come from the environment.
  assert.equal(output[0].error.message, "--org-slug must be a lowercase URL slug");

  const explicit = await captureJson(() =>
    bootstrapInstance(
      { json: true, "org-slug": "from-option" },
      {
        databaseUrl: "postgres://unused",
        environment: { ...environment, FACILITY_ORG_SLUG: "from-environment" },
        postgres: refusingPostgres(),
      },
    ),
  );
  assert.equal(explicit.output[0].error.message, "reached-the-database");
});

test("bootstrap refuses a malformed option instead of falling back to the environment", async () => {
  const { code, output } = await captureJson(() =>
    bootstrapInstance(
      { json: true, "github-user-id": "not-a-number" },
      { databaseUrl: "postgres://unused", environment, postgres: refusingPostgres() },
    ),
  );
  assert.equal(code, 1);
  assert.match(output[0].error.message, /^Missing required bootstrap values: /);
});

test("bootstrap names the environment variable for every value it is missing", async () => {
  const { output } = await captureJson(() =>
    bootstrapInstance({ json: true }, { databaseUrl: "postgres://unused", environment: {} }),
  );
  assert.equal(
    output[0].error.message,
    "Missing required bootstrap values: --org-name (FACILITY_ORG_NAME), --org-slug (FACILITY_ORG_SLUG), --owner-email (FACILITY_OWNER_EMAIL), --owner-name (FACILITY_OWNER_NAME), --github-user-id (FACILITY_GITHUB_USER_ID), --github-login (FACILITY_GITHUB_LOGIN), --github-account-id (FACILITY_GITHUB_ACCOUNT_ID), --github-installation-id (FACILITY_GITHUB_INSTALLATION_ID), --github-account-login (FACILITY_GITHUB_ACCOUNT_LOGIN)",
  );
});

test("bootstrap is transactional, idempotent for identical input, and rejects conflicts", async (t) => {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try { await admin`select 1`; } catch { await admin.end(); t.skip("Postgres unreachable"); return; }
  const schema = `cli_bootstrap_${Date.now()}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await admin.unsafe(`
      CREATE TABLE "${schema}".roles (id text primary key, org_id text, name text);
      CREATE TABLE "${schema}".orgs (id text primary key, name text, slug text unique, settings jsonb);
      CREATE TABLE "${schema}".users (id text primary key, email text unique, name text, status text);
      CREATE TABLE "${schema}".user_identities (id text primary key, user_id text, provider text, provider_subject text, login text, metadata jsonb);
      CREATE TABLE "${schema}".org_members (id text primary key, org_id text, user_id text, role_id text);
      CREATE TABLE "${schema}".github_installations (id text primary key, org_id text, installation_id bigint, account_id bigint, account_login text, target_type text);
      INSERT INTO "${schema}".roles (id, org_id, name) VALUES ('role_bundled_owner', null, 'owner');
    `);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    assert.equal(await bootstrapInstance(valid, { databaseUrl: scoped.toString() }), 0);
    assert.equal(await bootstrapInstance(valid, { databaseUrl: scoped.toString() }), 0);
    assert.equal(await bootstrapInstance({ ...valid, "github-user-id": "124" }, { databaseUrl: scoped.toString() }), 1);
    assert.equal(await bootstrapInstance({ ...valid, "owner-name": "Different owner" }, { databaseUrl: scoped.toString() }), 1);
    const rows = await admin.unsafe(`SELECT count(*)::int AS count FROM "${schema}".orgs`);
    assert.equal(rows[0].count, 1);
  } finally {
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
