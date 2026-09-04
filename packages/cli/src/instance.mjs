import { randomUUID } from "node:crypto";

export async function bootstrapInstance(flags, options = {}) {
  if (flags.help) {
    console.log("facility instance bootstrap --org-name <name> --org-slug <slug> --owner-email <email> --owner-name <name> --github-user-id <id> --github-login <login> --github-account-id <id> --github-account-login <login> --github-installation-id <id> [--github-account-type <organization|user>] [--json]");
    return 0;
  }
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) return failure(flags, "DATABASE_URL is required");
  const input = {
    orgName: stringFlag(flags, "org-name"),
    orgSlug: stringFlag(flags, "org-slug"),
    ownerEmail: stringFlag(flags, "owner-email")?.toLowerCase(),
    ownerName: stringFlag(flags, "owner-name"),
    githubUserId: positiveInteger(flags, "github-user-id"),
    githubLogin: stringFlag(flags, "github-login"),
    githubAccountId: positiveInteger(flags, "github-account-id"),
    githubInstallationId: positiveInteger(flags, "github-installation-id"),
    githubAccountLogin: stringFlag(flags, "github-account-login"),
    githubAccountType: (stringFlag(flags, "github-account-type") ?? "organization").toLowerCase(),
  };
  const missing = Object.entries(input).filter(([, value]) => value === undefined).map(([key]) => key);
  if (missing.length) return failure(flags, `Missing required bootstrap values: ${missing.join(", ")}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.orgSlug)) return failure(flags, "--org-slug must be a lowercase URL slug");
  if (!/^\S+@\S+\.\S+$/.test(input.ownerEmail)) return failure(flags, "--owner-email must be valid");
  if (!new Set(["organization", "user"]).has(input.githubAccountType))
    return failure(flags, "--github-account-type must be organization or user");
  const targetType = input.githubAccountType === "user" ? "User" : "Organization";

  // Imported here rather than at module scope: `facility init` and `doctor` are
  // documented as runnable straight from a checkout, where dependencies are not
  // installed, and `instance bootstrap` is the only command that needs a driver.
  const driver = options.postgres ?? (await import("postgres")).default;
  const sql = driver(databaseUrl, { max: 1 });
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('facility-instance-bootstrap'))`;
      const counts = (await tx`SELECT
        (SELECT count(*)::int FROM orgs) AS orgs,
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM org_members) AS members,
        (SELECT count(*)::int FROM user_identities) AS identities,
        (SELECT count(*)::int FROM github_installations) AS installations`)[0];
      const hasInstanceData = Object.values(counts).some((value) => Number(value) > 0);
      const existing = hasInstanceData ? await tx`SELECT
          o.id AS org_id,
          o.name AS org_name,
          o.slug,
          u.name AS owner_name,
          u.email,
          u.status,
          i.provider_subject,
          i.login AS github_login,
          g.installation_id,
          g.account_id,
          g.account_login,
          g.target_type
        FROM orgs o
        JOIN org_members m ON m.org_id = o.id
        JOIN users u ON u.id = m.user_id
        JOIN user_identities i ON i.user_id = u.id AND i.provider = 'github'
        JOIN github_installations g ON g.org_id = o.id
        LIMIT 2` : [];
      if (hasInstanceData) {
        const row = existing[0];
        const exactlyOneBinding = existing.length === 1 && Object.values(counts).every((value) => Number(value) === 1);
        const identical = exactlyOneBinding && row.org_name === input.orgName && row.slug === input.orgSlug &&
          row.owner_name === input.ownerName && row.email.toLowerCase() === input.ownerEmail && row.status === "active" &&
          row.provider_subject === String(input.githubUserId) && row.github_login === input.githubLogin &&
          Number(row.installation_id) === input.githubInstallationId && Number(row.account_id) === input.githubAccountId &&
          row.account_login === input.githubAccountLogin && row.target_type === targetType;
        if (!identical) throw new Error("Database already contains a different Facility instance");
        return { created: false, orgId: row.org_id };
      }
      const ownerRole = await tx`SELECT id FROM roles WHERE name = 'owner' AND org_id IS NULL LIMIT 1`;
      if (!ownerRole[0]) throw new Error("Bundled roles are missing; run Facility migrations and seed first");
      const orgId = id("org");
      const userId = id("user");
      await tx`INSERT INTO orgs (id, name, slug, settings) VALUES (${orgId}, ${input.orgName}, ${input.orgSlug}, ${tx.json({ githubAccountId: input.githubAccountId, githubInstallationId: input.githubInstallationId })})`;
      await tx`INSERT INTO users (id, email, name, status) VALUES (${userId}, ${input.ownerEmail}, ${input.ownerName}, 'active')`;
      await tx`INSERT INTO user_identities (id, user_id, provider, provider_subject, login, metadata)
        VALUES (${id("user")}, ${userId}, 'github', ${String(input.githubUserId)}, ${input.githubLogin}, ${tx.json({ accountIds: [input.githubAccountId] })})`;
      await tx`INSERT INTO org_members (id, org_id, user_id, role_id) VALUES (${id("member")}, ${orgId}, ${userId}, ${ownerRole[0].id})`;
      await tx`INSERT INTO github_installations (id, org_id, installation_id, account_id, account_login, target_type)
        VALUES (${id("int")}, ${orgId}, ${input.githubInstallationId}, ${input.githubAccountId}, ${input.githubAccountLogin}, ${targetType})`;
      return { created: true, orgId };
    });
    const output = { ok: true, created: result.created, orgId: result.orgId, slug: input.orgSlug };
    if (flags.json) console.log(JSON.stringify(output));
    else console.log(result.created ? `Bootstrapped Facility instance ${input.orgSlug}.` : `Facility instance ${input.orgSlug} is already bootstrapped.`);
    return 0;
  } catch (error) {
    return failure(flags, error instanceof Error ? error.message : String(error));
  } finally {
    await sql.end();
  }
}

function stringFlag(flags, name) {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(flags, name) {
  const value = Number(stringFlag(flags, name));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function failure(flags, message) {
  if (flags.json) console.log(JSON.stringify({ error: { code: "bootstrap_failed", message } }));
  else console.error(message);
  return 1;
}
