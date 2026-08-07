import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkMigrationChanges,
  destructiveMigrationFindings,
  executableSql,
} from "./migrations.mjs";

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "facility-migrations-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, "packages/db/migrations"), { recursive: true });
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Facility Test");
  git(directory, "config", "user.email", "facility@example.test");
  await writeFile(
    join(directory, "packages/db/migrations/0001_initial.sql"),
    "CREATE TABLE example (id text PRIMARY KEY);\n",
  );
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "initial");
  git(directory, "branch", "-M", "main");
  return { base: git(directory, "rev-parse", "HEAD"), directory };
}

test("compatibility scanner ignores comments and values but identifies destructive DDL", () => {
  const harmless = `
    -- DROP TABLE users;
    /* ALTER TABLE users DROP COLUMN email; */
    INSERT INTO audit_events (body) VALUES ('TRUNCATE TABLE projects');
    CREATE TABLE "DROP TABLE" (id text);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login text;
  `;
  assert.deepEqual(destructiveMigrationFindings(harmless), []);
  assert.doesNotMatch(executableSql(harmless), /TRUNCATE TABLE projects/);
  assert.deepEqual(
    destructiveMigrationFindings(`
      ALTER TABLE users DROP COLUMN email;
      ALTER TABLE projects RENAME COLUMN slug TO old_slug;
      ALTER TABLE runs ALTER COLUMN trigger TYPE text;
      TRUNCATE TABLE outcomes;
      DROP TABLE audit_events;
    `),
    [
      "drop table/schema/database",
      "truncate data",
      "drop column",
      "rename table/column",
      "change column type",
    ],
  );
  assert.deepEqual(
    destructiveMigrationFindings("INSERT INTO t VALUES ('a\\'); DROP TABLE users;"),
    ["drop table/schema/database"],
  );
  assert.deepEqual(destructiveMigrationFindings(String.raw`SELECT E'DROP TABLE users;\'';`), []);
  assert.deepEqual(
    destructiveMigrationFindings(String.raw`SELECT E'quoted\''; DROP TABLE users;`),
    ["drop table/schema/database"],
  );
});

test("new expand-only migration passes the repository-range integration", async (t) => {
  const { base, directory } = await repository(t);
  await writeFile(
    join(directory, "packages/db/migrations/0002_expand.sql"),
    "ALTER TABLE example ADD COLUMN IF NOT EXISTS label text;\n",
  );
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "expand");
  assert.deepEqual(await checkMigrationChanges({ base, head: "HEAD", rootDir: directory }), {
    checked: 1,
  });
});

test("new destructive migration and edits to existing migrations fail closed", async (t) => {
  const destructive = await repository(t);
  await writeFile(
    join(destructive.directory, "packages/db/migrations/0002_contract.sql"),
    "ALTER TABLE example DROP COLUMN id;\n",
  );
  git(destructive.directory, "add", ".");
  git(destructive.directory, "commit", "-qm", "contract");
  await assert.rejects(
    checkMigrationChanges({
      base: destructive.base,
      head: "HEAD",
      rootDir: destructive.directory,
    }),
    /must be expand-compatible.*drop column/,
  );

  const modified = await repository(t);
  await writeFile(
    join(modified.directory, "packages/db/migrations/0001_initial.sql"),
    "CREATE TABLE changed (id text PRIMARY KEY);\n",
  );
  git(modified.directory, "add", ".");
  git(modified.directory, "commit", "-qm", "rewrite");
  await assert.rejects(
    checkMigrationChanges({ base: modified.base, head: "HEAD", rootDir: modified.directory }),
    /applied migration files are immutable/,
  );

  const renamed = await repository(t);
  git(
    renamed.directory,
    "mv",
    "packages/db/migrations/0001_initial.sql",
    "packages/db/0001_retired.sql",
  );
  git(renamed.directory, "commit", "-qm", "rename away");
  await assert.rejects(
    checkMigrationChanges({ base: renamed.base, head: "HEAD", rootDir: renamed.directory }),
    /applied migration files are immutable.*packages\/db\/migrations\/0001_initial\.sql/,
  );
});

test("a null before-SHA compares a first push against Git's empty tree", async (t) => {
  const { directory } = await repository(t);
  assert.deepEqual(
    await checkMigrationChanges({ base: "0".repeat(40), head: "HEAD", rootDir: directory }),
    { checked: 1 },
  );
});

test("a PR behind its base branch checks only changes since the merge base", async (t) => {
  const { base, directory } = await repository(t);
  git(directory, "switch", "-qc", "feature");
  await writeFile(
    join(directory, "packages/db/migrations/0002_feature.sql"),
    "ALTER TABLE example ADD COLUMN IF NOT EXISTS feature_label text;\n",
  );
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "feature migration");
  const featureHead = git(directory, "rev-parse", "HEAD");

  git(directory, "switch", "-q", "main");
  await writeFile(
    join(directory, "packages/db/migrations/0003_main.sql"),
    "ALTER TABLE example ADD COLUMN IF NOT EXISTS main_label text;\n",
  );
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "main migration");
  const advancedBase = git(directory, "rev-parse", "HEAD");
  assert.notEqual(advancedBase, base);
  git(directory, "switch", "-q", "feature");

  assert.deepEqual(
    await checkMigrationChanges({ base: advancedBase, head: featureHead, rootDir: directory }),
    { checked: 1 },
  );
});

test("default CI supplies the exact reviewed range to the migration guard", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /name: Enforce rollback-safe new migrations/);
  assert.match(workflow, /BASE_SHA:.*pull_request\.base\.sha.*github\.event\.before/);
  assert.match(workflow, /HEAD_SHA:.*pull_request\.head\.sha.*github\.sha/);
  assert.match(workflow, /pnpm migrations:check "\$BASE_SHA" "\$HEAD_SHA"/);
});
