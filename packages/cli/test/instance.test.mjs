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

// The bootstrap writes into whatever search_path it is handed, so each test
// gets a schema of its own and drops it afterwards. Isolation is the point:
// these assert the rows that were written, and a shared schema would make the
// second test read the first one's binding.
async function withBootstrapSchema(t, run) {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try { await admin`select 1`; } catch { await admin.end(); t.skip("Postgres unreachable"); return; }
  const schema = `cli_bootstrap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
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
    await run({ admin, schema, databaseUrl: scoped.toString() });
  } finally {
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

// Every row the bootstrap is responsible for, in one shape, so a test can
// compare the whole binding before and after a refused attempt.
async function storedBinding(admin, schema) {
  const [org] = await admin.unsafe(`SELECT name, slug, settings FROM "${schema}".orgs`);
  const [user] = await admin.unsafe(`SELECT email, name, status FROM "${schema}".users`);
  const [identity] = await admin.unsafe(`SELECT provider, provider_subject, login FROM "${schema}".user_identities`);
  const [member] = await admin.unsafe(`SELECT role_id FROM "${schema}".org_members`);
  const [installation] = await admin.unsafe(`SELECT installation_id::int AS installation_id, account_id::int AS account_id, account_login, target_type FROM "${schema}".github_installations`);
  return { org, user, identity, member, installation };
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
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    assert.equal(await bootstrapInstance(valid, { databaseUrl }), 0);
    assert.equal(await bootstrapInstance(valid, { databaseUrl }), 0);
    assert.equal(await bootstrapInstance({ ...valid, "github-user-id": "124" }, { databaseUrl }), 1);
    assert.equal(await bootstrapInstance({ ...valid, "owner-name": "Different owner" }, { databaseUrl }), 1);
    const rows = await admin.unsafe(`SELECT count(*)::int AS count FROM "${schema}".orgs`);
    assert.equal(rows[0].count, 1);
  });
});

test("bootstrap from the environment writes the same binding the options write", async (t) => {
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    // No option carries a value: this is how the Compose bootstrap profile
    // invokes it, and the point of the PR is that this path reaches the rows.
    assert.equal(await bootstrapInstance({ json: true }, { databaseUrl, environment }), 0);

    const stored = await storedBinding(admin, schema);
    assert.deepEqual(stored.org, {
      name: "Facility Test",
      slug: "facility-test",
      settings: { githubAccountId: 456, githubInstallationId: 789 },
    });
    // FACILITY_OWNER_EMAIL is "Owner@Example.com": normalized on the way in,
    // exactly as the option path normalizes it.
    assert.deepEqual(stored.user, { email: "owner@example.com", name: "Owner", status: "active" });
    assert.deepEqual(stored.identity, { provider: "github", provider_subject: "123", login: "owner" });
    assert.equal(stored.member.role_id, "role_bundled_owner");
    assert.deepEqual(stored.installation, {
      installation_id: 789,
      account_id: 456,
      account_login: "facility-test",
      target_type: "Organization",
    });

    // Re-running a container task must not be a second organization.
    assert.equal(await bootstrapInstance({ json: true }, { databaseUrl, environment }), 0);
    const [{ count }] = await admin.unsafe(`SELECT count(*)::int AS count FROM "${schema}".orgs`);
    assert.equal(count, 1);
    assert.deepEqual(await storedBinding(admin, schema), stored);
  });
});

test("an option beats its variable in the row that is written, not only in validation", async (t) => {
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    assert.equal(
      await bootstrapInstance(
        { json: true, "org-slug": "from-option", "github-installation-id": "999" },
        {
          databaseUrl,
          environment: {
            ...environment,
            FACILITY_ORG_SLUG: "from-environment",
            FACILITY_GITHUB_INSTALLATION_ID: "789",
          },
        },
      ),
      0,
    );

    const stored = await storedBinding(admin, schema);
    assert.equal(stored.org.slug, "from-option");
    // Precedence has to hold everywhere the value lands, not just in the column
    // the flag is named after: the installation id is also copied into settings.
    assert.equal(stored.org.settings.githubInstallationId, 999);
    assert.equal(stored.installation.installation_id, 999);
  });
});

test("a conflicting binding from the environment is refused and leaves every row untouched", async (t) => {
  await withBootstrapSchema(t, async ({ admin, schema, databaseUrl }) => {
    assert.equal(await bootstrapInstance({ json: true }, { databaseUrl, environment }), 0);
    const before = await storedBinding(admin, schema);

    // One conflict per dimension the binding is made of: identity, person, and
    // installation. Each must be refused rather than merged into the existing
    // instance, and the refusal must not be a partial write.
    for (const conflict of [
      { FACILITY_GITHUB_USER_ID: "124" },
      { FACILITY_OWNER_NAME: "Different owner" },
      { FACILITY_GITHUB_INSTALLATION_ID: "790" },
      { FACILITY_ORG_SLUG: "other-instance" },
    ]) {
      assert.equal(
        await bootstrapInstance({ json: true }, { databaseUrl, environment: { ...environment, ...conflict } }),
        1,
      );
    }

    assert.deepEqual(await storedBinding(admin, schema), before);
    const [{ count }] = await admin.unsafe(`SELECT count(*)::int AS count FROM "${schema}".orgs`);
    assert.equal(count, 1);
  });
});
