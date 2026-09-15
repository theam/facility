import { BUNDLED_ROLES } from "@facility/core";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ quiet: true });

export type SeedOptions = {
  includeDemoData?: boolean;
  log?: (message: string) => void;
};

export async function seed(
  connectionString = process.env.DATABASE_URL,
  options: SeedOptions = {},
): Promise<void> {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const sql = postgres(connectionString, { max: 1 });
  try {
    await seedWithClient(sql, options);
  } finally {
    await sql.end();
  }
}

export async function seedWithClient(sql: postgres.Sql, options: SeedOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  for (const role of BUNDLED_ROLES) {
    await sql`
      INSERT INTO roles (id, org_id, name, description, permissions)
      VALUES (
        ${`role_bundled_${role.name}`},
        NULL,
        ${role.name},
        ${role.description},
        ${role.permissions}
      )
      ON CONFLICT (coalesce(org_id, '__bundled__'), name)
      DO UPDATE SET
        description = EXCLUDED.description,
        permissions = EXCLUDED.permissions,
        updated_at = now()
    `;
  }

  if (options.includeDemoData === true) await seedLocalDemo(sql);
  log("seed complete");
}

async function seedLocalDemo(sql: postgres.Sql): Promise<void> {
  const orgId = "org_local";
  const userId = "user_local_admin";
  await sql`
    INSERT INTO orgs (id, name, slug, settings)
    VALUES (${orgId}, 'Facility Local', 'facility-local', '{}'::jsonb)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  `;
  await sql`
    INSERT INTO users (id, email, name, status)
    VALUES (${userId}, 'admin@facility.local', 'Local Admin', 'active')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  `;
  await sql`
    INSERT INTO org_members (id, org_id, user_id, role_id)
    VALUES (
      'member_local_admin',
      ${orgId},
      ${userId},
      'role_bundled_owner'
    )
    ON CONFLICT (org_id, user_id)
    DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()
  `;
}
