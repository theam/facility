import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });

export async function migrate(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const client = postgres(connectionString, { max: 1 });
  try {
    // Deploys commonly start API, gateway, worker, and a migration job together.
    // Serialize the entire lexical scan on one session so two processes cannot
    // both observe a migration as missing and execute it concurrently.
    await client`SELECT pg_advisory_lock(hashtext('facility:migrations'))`;
    await client`CREATE TABLE IF NOT EXISTS _facility_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const migrationsDir = join(here, "..", "migrations");
    // Apply every *.sql file in lexical order, each once, in its own tx.
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await client<
        { name: string }[]
      >`SELECT name FROM _facility_migrations WHERE name = ${file}`;
      if (existing.length > 0) {
        console.log(`${file} already applied`);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.begin(async (tx) => {
        await tx.unsafe(sql);
        await tx`INSERT INTO _facility_migrations (name) VALUES (${file})`;
      });
      console.log(`applied ${file}`);
    }
  } finally {
    await client`SELECT pg_advisory_unlock(hashtext('facility:migrations'))`.catch(() => undefined);
    await client.end();
  }
}
