import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_ROLES, newId } from "@facility/core";
import { config as loadDotenv } from "dotenv";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import postgres from "postgres";

const moduleRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = join(moduleRoot, "../../..");
const packagedAssetsRoot = join(moduleRoot, "seed-assets");
// Workspace builds read the canonical source files. Production deployments use
// the copy bundled into @facility/db/dist so first-org bootstrap does not depend
// on the monorepo existing beside node_modules.
const repoRoot = existsSync(join(packagedAssetsRoot, "packages/harness/contracts/po-agent.md"))
  ? packagedAssetsRoot
  : workspaceRoot;
loadDotenv({ path: join(workspaceRoot, ".env"), quiet: true });

export type SeedOptions = {
  includeDemoData?: boolean;
  log?: (message: string) => void;
};

type RegistryDb = {
  execute: (query: SQL) => Promise<unknown>;
};

type BundledRegistryEntry = {
  kind: string;
  name: string;
  description: string;
  content: string;
};

const BUNDLED_ACTION_TYPES = [
  { name: "plan_acceptance", required: [] },
  { name: "learning_validation", required: [] },
  { name: "kickstart_review", required: [] },
  { name: "budget_override", required: [] },
  { name: "task_creation", required: ["taskId", "title", "bodyMd", "wsjf", "target"] },
  { name: "issue_update", required: ["issueNumber", "title", "bodyMd"] },
  { name: "skill_proposal", required: ["name", "content", "evidence_refs"] },
  { name: "rule_proposal", required: ["name", "content", "evidence_refs"] },
  { name: "guard_candidate", required: ["title", "content", "evidence_refs"] },
  { name: "kb_amendment", required: ["type", "slug", "bodyMd", "evidence_refs"] },
  { name: "mcp_tool_call", required: ["toolName", "args", "requestedBy"] },
];

const ANALYSIS_AGENT_NAMES = ["architect", "codex-architect", "review", "security-sweep"] as const;
const DELIVERY_AGENT_NAMES = ["builder", "codex-builder", "address-review", "ci-doctor"] as const;

export function defaultSandboxProfileId(orgId: string): string {
  return orgId === "org_dev_the_agile_monkeys" ? "sbx_dev_default" : `sbx_default_${orgId}`;
}

export function analysisSandboxProfileId(orgId: string): string {
  return orgId === "org_dev_the_agile_monkeys" ? "sbx_dev_analysis" : `sbx_analysis_${orgId}`;
}

export function builderSandboxProfileId(orgId: string): string {
  return orgId === "org_dev_the_agile_monkeys" ? "sbx_dev_builder" : `sbx_builder_${orgId}`;
}

// The default sandbox profile must run the Facility runner (its ENTRYPOINT), or
// platform-lane runs never start. A bare base image like node:24-trixie only
// works for BYO-command runs. Keep this in sync with config.sandboxRunnerImage.
function defaultRunnerImage(): string {
  return process.env.FACILITY_RUNNER_IMAGE ?? "facility-runner:dev";
}

// Driver the default sandbox profile uses; must match the deployment ("docker"
// for local/self-host, "vercel" for managed Sandboxes, or "aws" for the
// CodeBuild development provider). Keep in sync with
// config.sandboxDriver.
function defaultSandboxDriver(): string {
  const configured = process.env.FACILITY_SANDBOX_DRIVER;
  return configured === "aws" || configured === "vercel" ? configured : "docker";
}

function defaultSandboxResources() {
  return defaultSandboxDriver() === "aws" || defaultSandboxDriver() === "vercel"
    ? { cpu: 8, memory_mb: 15_360, timeout_min: 180 }
    : { cpu: 2, memory_mb: 4_096, timeout_min: 60 };
}

function defaultSandboxResourcesDrizzleSql() {
  const resources = defaultSandboxResources();
  return drizzleSql`jsonb_build_object(
    'cpu', ${resources.cpu}::integer,
    'memory_mb', ${resources.memory_mb}::integer,
    'timeout_min', ${resources.timeout_min}::integer
  )`;
}

function actionTypeExecutor(name: string) {
  return {
    type: [
      "task_creation",
      "issue_update",
      "skill_proposal",
      "rule_proposal",
      "guard_candidate",
      "kb_amendment",
      "plan_acceptance",
    ].includes(name)
      ? "internal"
      : name === "mcp_tool_call"
        ? "mcp"
        : "none",
    config: {},
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      out.push(...(await walk(path)));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

function kindFor(path: string): string {
  if (path.includes("/guards/")) return "guard";
  if (path.includes("/agents/")) return "agent_contract";
  if (path.includes("/prompts/")) return "harness";
  if (path.includes("/modules/")) return "module";
  if (path.endsWith("STANDARD.md") || path.endsWith("standard-section.md"))
    return "standard_section";
  return "template_set";
}

export async function seed(
  connectionString = process.env.DATABASE_URL,
  options: SeedOptions = {},
): Promise<void> {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = postgres(connectionString, { max: 1 });
  try {
    await seedWithClient(sql, options);
  } finally {
    await sql.end();
  }
}

export async function seedWithClient(sql: postgres.Sql, options: SeedOptions = {}): Promise<void> {
  const includeDemoData = options.includeDemoData ?? process.env.FACILITY_SEED_DEMO !== "0";
  const log = options.log ?? console.log;
  for (const role of BUNDLED_ROLES) {
    await sql`
        INSERT INTO roles (id, org_id, name, description, permissions)
        VALUES (${`role_bundled_${role.name}`}, NULL, ${role.name}, ${role.description}, ${role.permissions})
        ON CONFLICT (coalesce(org_id, '__bundled__'), name)
        DO UPDATE SET description = EXCLUDED.description, permissions = EXCLUDED.permissions, updated_at = now()
      `;
  }
  const seededOrgs = await sql<{ id: string }[]>`SELECT id FROM orgs`;
  await seedOrgEssentialsForOrgsSql(
    sql,
    seededOrgs.map((org) => org.id),
  );
  if (!includeDemoData) {
    // Deploy-time seeds refresh bundled contracts and templates for existing
    // tenants too. Do this set-wise so an upgrade is not one database round
    // trip per file per tenant.
    await seedBundledRegistryForOrgsSql(
      sql,
      seededOrgs.map((org) => org.id),
    );
    log("seed complete");
    return;
  }

  await sql`
      INSERT INTO orgs (id, name, slug, settings)
      VALUES (
        'org_dev_the_agile_monkeys',
        'The Agile Monkeys',
        'the-agile-monkeys',
        '{"retention_days":90,"telemetry_opt_in":false}'::jsonb
      )
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    `;
  await sql`
      INSERT INTO users (id, email, name, status)
      VALUES ('user_dev_admin', 'admin@theagilemonkeys.com', 'Dev Admin', 'active')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    `;
  await sql`
      INSERT INTO org_members (id, org_id, user_id, role_id)
      VALUES ('member_dev_admin', 'org_dev_the_agile_monkeys', 'user_dev_admin', 'role_bundled_owner')
      ON CONFLICT (org_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, updated_at = now()
    `;

  await seedOrgEssentialsSql(sql, "org_dev_the_agile_monkeys");
  const devProjects = await sql<{ id: string }[]>`
      INSERT INTO projects (id, org_id, name, slug, description, settings)
      VALUES (
        'proj_dev_facility',
        'org_dev_the_agile_monkeys',
        'Facility Dev',
        'facility-dev',
        'Seeded development project',
        '{"default_branch":"main","check_cmds":[]}'::jsonb
      )
      ON CONFLICT (org_id, slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        updated_at = now()
      RETURNING id
    `;
  const devProjectId = devProjects[0]?.id;
  if (!devProjectId) throw new Error("failed to seed dev project");

  const bundled = await seedBundledRegistrySql(sql, "org_dev_the_agile_monkeys");
  await sql`
      INSERT INTO agent_defs (
        id,
        org_id,
        project_id,
        name,
        engine,
        model,
        contract_item_id,
        harness_item_id,
        triggers,
        sandbox_profile_id,
        permissions,
        enabled
      )
      VALUES (
        'agent_dev_project_owner',
        'org_dev_the_agile_monkeys',
        ${devProjectId},
        'project-owner',
        'claude_code',
        '{"model":"claude-sonnet-5"}'::jsonb,
        ${bundled.poContractId},
        ${bundled.productChainId},
        '[{"type":"schedule","config":{"cron":"0 6 * * *","timezone":"UTC"}},{"type":"manual","config":{}}]'::jsonb,
        'sbx_dev_default',
        ARRAY['kb:write','tasks:write','hitl:write']::text[],
        true
      )
      ON CONFLICT (id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        model = EXCLUDED.model,
        contract_item_id = EXCLUDED.contract_item_id,
        harness_item_id = EXCLUDED.harness_item_id,
        triggers = EXCLUDED.triggers,
        engine = EXCLUDED.engine,
        sandbox_profile_id = EXCLUDED.sandbox_profile_id,
        permissions = EXCLUDED.permissions,
        enabled = true,
        updated_at = now()
    `;
  await sql`
      INSERT INTO agent_defs (
        id,
        org_id,
        project_id,
        name,
        engine,
        model,
        contract_item_id,
        harness_item_id,
        triggers,
        sandbox_profile_id,
        permissions,
        enabled
      )
      VALUES (
        'agent_dev_learning',
        'org_dev_the_agile_monkeys',
        ${devProjectId},
        'learning',
        'codex',
        '{"primary":"gpt-5.5"}'::jsonb,
        ${bundled.learningContractId},
        ${bundled.productChainId},
        '[{"type":"schedule","config":{"cron":"0 3 * * *","timezone":"UTC"}}]'::jsonb,
        'sbx_dev_default',
        ARRAY['runs:read','hitl:write','kb:read']::text[],
        true
      )
      ON CONFLICT (id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        model = EXCLUDED.model,
        contract_item_id = EXCLUDED.contract_item_id,
        harness_item_id = EXCLUDED.harness_item_id,
        triggers = EXCLUDED.triggers,
        sandbox_profile_id = EXCLUDED.sandbox_profile_id,
        permissions = EXCLUDED.permissions,
        enabled = true,
        updated_at = now()
    `;
  log("seed complete");
}

export async function seedBundledRegistryForOrg(db: RegistryDb, orgId: string): Promise<void> {
  await seedOrgEssentialsDb(db, orgId);
  await seedBundledRegistryDb(db, orgId);
}

async function seedOrgEssentialsSql(sql: postgres.Sql, orgId: string): Promise<void> {
  await sql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${defaultSandboxProfileId(orgId)},
      ${orgId},
      'Default runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[]}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;

  await sql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${builderSandboxProfileId(orgId)},
      ${orgId},
      'Builder runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":true,"provisioning":"deps_only"}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;

  await sql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${analysisSandboxProfileId(orgId)},
      ${orgId},
      'Analysis runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":false,"provisioning":"deps_only"}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;

  for (const actionType of BUNDLED_ACTION_TYPES) {
    await sql`
      INSERT INTO action_types (id, org_id, name, payload_schema, resolver, executor, default_ttl_hours)
      VALUES (
        ${`act_${orgId}_${actionType.name}`},
        ${orgId},
        ${actionType.name},
        ${JSON.stringify({ type: "object", required: actionType.required })}::jsonb,
        '{"type":"permission","config":{"permission":"hitl:decide"}}'::jsonb,
        ${JSON.stringify(actionTypeExecutor(actionType.name))}::jsonb,
        72
      )
      ON CONFLICT (org_id, name) DO UPDATE SET
        payload_schema = EXCLUDED.payload_schema,
        resolver = EXCLUDED.resolver,
        executor = CASE
          WHEN action_types.name = 'plan_acceptance'
            AND coalesce(action_types.executor->>'type', 'none') <> 'none'
            THEN action_types.executor
          ELSE EXCLUDED.executor
        END,
        default_ttl_hours = EXCLUDED.default_ttl_hours,
        updated_at = now()
    `;
  }
}

async function seedOrgEssentialsForOrgsSql(sql: postgres.Sql, orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const orgInputs = orgIds.map((orgId) => ({
    org_id: orgId,
    profile_id: defaultSandboxProfileId(orgId),
    analysis_profile_id: analysisSandboxProfileId(orgId),
    builder_profile_id: builderSandboxProfileId(orgId),
  }));
  await sql`
    WITH inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text)
    )
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    SELECT
      inputs.profile_id,
      inputs.org_id,
      'Default runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[]}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    FROM inputs
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;
  await sql`
    WITH inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text, analysis_profile_id text, builder_profile_id text)
    )
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    SELECT
      inputs.builder_profile_id,
      inputs.org_id,
      'Builder runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":true,"provisioning":"deps_only"}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    FROM inputs
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;
  await sql`
    WITH inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text, analysis_profile_id text)
    )
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    SELECT
      inputs.analysis_profile_id,
      inputs.org_id,
      'Analysis runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":false,"provisioning":"deps_only"}'::jsonb,
      ${sql.json(defaultSandboxResources())}::jsonb,
      '{"egress":"restricted"}'::jsonb
    FROM inputs
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `;
  // One-time activation for legacy agents that still point at Facility's
  // canonical default. The newly introduced Builder profile is the rollout
  // marker for both managed sets, so architects created after the older
  // Analysis profile are still migrated once. A later operator assignment back
  // to the full profile remains durable; custom and NULL assignments also stay
  // untouched. The org joins prevent cross-tenant profile references.
  await sql`
    WITH inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text, analysis_profile_id text, builder_profile_id text)
    )
    UPDATE agent_defs AS agents
    SET sandbox_profile_id = inputs.analysis_profile_id, updated_at = now()
    FROM inputs
    INNER JOIN sandbox_profiles AS analysis_profiles
      ON analysis_profiles.id = inputs.analysis_profile_id
      AND analysis_profiles.org_id = inputs.org_id
    INNER JOIN sandbox_profiles AS rollout_markers
      ON rollout_markers.id = inputs.builder_profile_id
      AND rollout_markers.org_id = inputs.org_id
    WHERE agents.org_id = inputs.org_id
      AND agents.sandbox_profile_id = inputs.profile_id
      AND agents.name = ANY(${[...ANALYSIS_AGENT_NAMES]})
      AND agents.updated_at < rollout_markers.created_at
  `;
  await sql`
    WITH inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text, analysis_profile_id text, builder_profile_id text)
    )
    UPDATE agent_defs AS agents
    SET sandbox_profile_id = inputs.builder_profile_id, updated_at = now()
    FROM inputs
    INNER JOIN sandbox_profiles AS builder_profiles
      ON builder_profiles.id = inputs.builder_profile_id
      AND builder_profiles.org_id = inputs.org_id
    WHERE agents.org_id = inputs.org_id
      AND agents.sandbox_profile_id = inputs.profile_id
      AND agents.name = ANY(${[...DELIVERY_AGENT_NAMES]})
      AND agents.updated_at < builder_profiles.created_at
  `;
  const actionInputs = BUNDLED_ACTION_TYPES.map((actionType) => ({
    name: actionType.name,
    payload_schema: { type: "object", required: actionType.required },
    executor: actionTypeExecutor(actionType.name),
  }));
  await sql`
    WITH org_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text, profile_id text)
    ), action_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(actionInputs)}::jsonb)
        AS value(name text, payload_schema jsonb, executor jsonb)
    )
    INSERT INTO action_types (
      id, org_id, name, payload_schema, resolver, executor, default_ttl_hours
    )
    SELECT
      'act_' || org_inputs.org_id || '_' || action_inputs.name,
      org_inputs.org_id,
      action_inputs.name,
      action_inputs.payload_schema,
      '{"type":"permission","config":{"permission":"hitl:decide"}}'::jsonb,
      action_inputs.executor,
      72
    FROM org_inputs
    CROSS JOIN action_inputs
    ON CONFLICT (org_id, name) DO UPDATE SET
      payload_schema = EXCLUDED.payload_schema,
      resolver = EXCLUDED.resolver,
      executor = CASE
        WHEN action_types.name = 'plan_acceptance'
          AND coalesce(action_types.executor->>'type', 'none') <> 'none'
          THEN action_types.executor
        ELSE EXCLUDED.executor
      END,
      default_ttl_hours = EXCLUDED.default_ttl_hours,
      updated_at = now()
  `;
}

async function seedOrgEssentialsDb(db: RegistryDb, orgId: string): Promise<void> {
  // New-org onboarding has no legacy agents to reassign. Existing-tenant
  // activation intentionally remains in the set-wise deploy seed above.
  await db.execute(drizzleSql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${defaultSandboxProfileId(orgId)},
      ${orgId},
      'Default runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[]}'::jsonb,
      ${defaultSandboxResourcesDrizzleSql()},
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `);

  await db.execute(drizzleSql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${builderSandboxProfileId(orgId)},
      ${orgId},
      'Builder runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":true,"provisioning":"deps_only"}'::jsonb,
      ${defaultSandboxResourcesDrizzleSql()},
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `);

  await db.execute(drizzleSql`
    INSERT INTO sandbox_profiles (id, org_id, name, driver, image, setup, resources, network)
    VALUES (
      ${analysisSandboxProfileId(orgId)},
      ${orgId},
      'Analysis runner',
      ${defaultSandboxDriver()},
      ${defaultRunnerImage()},
      '{"deps":[],"nested_docker":false,"provisioning":"deps_only"}'::jsonb,
      ${defaultSandboxResourcesDrizzleSql()},
      '{"egress":"restricted"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      driver = EXCLUDED.driver,
      image = EXCLUDED.image,
      setup = EXCLUDED.setup,
      resources = EXCLUDED.resources,
      network = EXCLUDED.network,
      updated_at = now()
  `);

  for (const actionType of BUNDLED_ACTION_TYPES) {
    await db.execute(drizzleSql`
      INSERT INTO action_types (id, org_id, name, payload_schema, resolver, executor, default_ttl_hours)
      VALUES (
        ${`act_${orgId}_${actionType.name}`},
        ${orgId},
        ${actionType.name},
        ${JSON.stringify({ type: "object", required: actionType.required })}::jsonb,
        '{"type":"permission","config":{"permission":"hitl:decide"}}'::jsonb,
        ${JSON.stringify(actionTypeExecutor(actionType.name))}::jsonb,
        72
      )
      ON CONFLICT (org_id, name) DO UPDATE SET
        payload_schema = EXCLUDED.payload_schema,
        resolver = EXCLUDED.resolver,
        executor = CASE
          WHEN action_types.name = 'plan_acceptance'
            AND coalesce(action_types.executor->>'type', 'none') <> 'none'
            THEN action_types.executor
          ELSE EXCLUDED.executor
        END,
        default_ttl_hours = EXCLUDED.default_ttl_hours,
        updated_at = now()
    `);
  }
}

async function seedBundledRegistrySql(sql: postgres.Sql, orgId: string) {
  const harnessRoot = join(repoRoot, "packages/harness");
  const poContract = await readFile(join(harnessRoot, "contracts/po-agent.md"), "utf8");
  const learningContract = await readFile(join(harnessRoot, "contracts/learning-agent.md"), "utf8");
  const poContractId = await upsertRegistrySql(
    sql,
    orgId,
    "agent_contract",
    "po-agent",
    "Bundled Project Owner contract",
    poContract,
  );
  const learningContractId = await upsertRegistrySql(
    sql,
    orgId,
    "agent_contract",
    "learning-agent",
    "Bundled learning mode contract",
    learningContract,
  );
  const productChainId = await upsertRegistrySql(
    sql,
    orgId,
    "harness",
    "product-chain",
    "Bundled product owner artifact chain",
    JSON.stringify(productChainSeed(), null, 2),
  );
  await upsertRegistrySql(
    sql,
    orgId,
    "harness",
    "research-chain",
    "Bundled Limina-compatible research artifact chain",
    JSON.stringify(researchChainSeed(), null, 2),
  );
  await seedTemplateRegistrySql(sql, orgId);
  return { poContractId, learningContractId, productChainId };
}

async function bundledRegistryEntries(): Promise<BundledRegistryEntry[]> {
  const harnessRoot = join(repoRoot, "packages/harness");
  const poContract = await readFile(join(harnessRoot, "contracts/po-agent.md"), "utf8");
  const learningContract = await readFile(join(harnessRoot, "contracts/learning-agent.md"), "utf8");
  const entries: BundledRegistryEntry[] = [
    {
      kind: "agent_contract",
      name: "po-agent",
      description: "Bundled Project Owner contract",
      content: poContract,
    },
    {
      kind: "agent_contract",
      name: "learning-agent",
      description: "Bundled learning mode contract",
      content: learningContract,
    },
    {
      kind: "harness",
      name: "product-chain",
      description: "Bundled product owner artifact chain",
      content: JSON.stringify(productChainSeed(), null, 2),
    },
    {
      kind: "harness",
      name: "research-chain",
      description: "Bundled Limina-compatible research artifact chain",
      content: JSON.stringify(researchChainSeed(), null, 2),
    },
  ];
  const templateRoot = join(repoRoot, "packages/cli/templates");
  const cliModuleRoot = join(repoRoot, "packages/cli/modules");
  const files = [...(await walk(templateRoot)), ...(await walk(cliModuleRoot))];
  entries.push({
    kind: "template_set",
    name: "facility-standard",
    description: "Facility standard template set",
    content: files.map((file) => relative(repoRoot, file)).join("\n"),
  });
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = relative(repoRoot, file);
    entries.push({
      kind: kindFor(rel),
      name:
        rel.replace(/^packages\/cli\/(templates|modules)\//, "").replace(extname(rel), "") ||
        basename(file),
      description: rel,
      content,
    });
  }
  return entries;
}

async function seedBundledRegistryForOrgsSql(sql: postgres.Sql, orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const entries = (await bundledRegistryEntries()).map((entry) => ({
    ...entry,
    content_hash: hash(entry.content),
  }));
  const orgInputs = orgIds.map((orgId) => ({ org_id: orgId }));
  await sql`
    WITH org_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text)
    ), entry_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(entries)}::jsonb)
        AS value(kind text, name text, description text, content text, content_hash text)
    )
    INSERT INTO registry_items (
      id, org_id, scope, kind, name, description, latest_version
    )
    SELECT
      'item_seed_' || md5(org_inputs.org_id || ':' || entry_inputs.kind || ':' || entry_inputs.name),
      org_inputs.org_id,
      'bundled',
      entry_inputs.kind,
      entry_inputs.name,
      entry_inputs.description,
      1
    FROM org_inputs
    CROSS JOIN entry_inputs
    ON CONFLICT (org_id, coalesce(project_id, '__none__'), kind, name)
    DO UPDATE SET
      description = EXCLUDED.description,
      latest_version = GREATEST(registry_items.latest_version, 1),
      updated_at = CASE
        WHEN registry_items.description IS DISTINCT FROM EXCLUDED.description
          OR registry_items.latest_version < 1
          THEN now()
        ELSE registry_items.updated_at
      END
  `;
  await sql`
    WITH org_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(orgInputs)}::jsonb)
        AS value(org_id text)
    ), entry_inputs AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(entries)}::jsonb)
        AS value(kind text, name text, description text, content text, content_hash text)
    ), inputs AS (
      SELECT
        registry_items.org_id,
        registry_items.id AS item_id,
        entry_inputs.content,
        entry_inputs.content_hash
      FROM registry_items
      JOIN org_inputs ON org_inputs.org_id = registry_items.org_id
      JOIN entry_inputs
        ON entry_inputs.kind = registry_items.kind
        AND entry_inputs.name = registry_items.name
      WHERE registry_items.project_id IS NULL
    )
    INSERT INTO registry_versions (
      id, org_id, item_id, version, content, content_hash, changelog, status, created_by
    )
    SELECT
      'ver_seed_' || md5(inputs.item_id || ':1'),
      inputs.org_id,
      inputs.item_id,
      1,
      inputs.content,
      inputs.content_hash,
      'seeded from CLI templates',
      'active',
      'seed'
    FROM inputs
    ON CONFLICT (item_id, version)
    DO UPDATE SET
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      updated_at = now()
    WHERE registry_versions.content_hash IS DISTINCT FROM EXCLUDED.content_hash
  `;
}

async function seedBundledRegistryDb(db: RegistryDb, orgId: string) {
  const harnessRoot = join(repoRoot, "packages/harness");
  const poContract = await readFile(join(harnessRoot, "contracts/po-agent.md"), "utf8");
  const learningContract = await readFile(join(harnessRoot, "contracts/learning-agent.md"), "utf8");
  await upsertRegistryDb(
    db,
    orgId,
    "agent_contract",
    "po-agent",
    "Bundled Project Owner contract",
    poContract,
  );
  await upsertRegistryDb(
    db,
    orgId,
    "agent_contract",
    "learning-agent",
    "Bundled learning mode contract",
    learningContract,
  );
  await upsertRegistryDb(
    db,
    orgId,
    "harness",
    "product-chain",
    "Bundled product owner artifact chain",
    JSON.stringify(productChainSeed(), null, 2),
  );
  await upsertRegistryDb(
    db,
    orgId,
    "harness",
    "research-chain",
    "Bundled Limina-compatible research artifact chain",
    JSON.stringify(researchChainSeed(), null, 2),
  );
  await seedTemplateRegistryDb(db, orgId);
}

async function seedTemplateRegistrySql(sql: postgres.Sql, orgId: string) {
  const templateRoot = join(repoRoot, "packages/cli/templates");
  const moduleRoot = join(repoRoot, "packages/cli/modules");
  const files = [...(await walk(templateRoot)), ...(await walk(moduleRoot))];
  const allContent = files.map((file) => relative(repoRoot, file)).join("\n");
  await upsertRegistrySql(
    sql,
    orgId,
    "template_set",
    "facility-standard",
    "Facility standard template set",
    allContent,
  );
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = relative(repoRoot, file);
    const name =
      rel.replace(/^packages\/cli\/(templates|modules)\//, "").replace(extname(rel), "") ||
      basename(file);
    await upsertRegistrySql(sql, orgId, kindFor(rel), name, rel, content);
  }
}

async function seedTemplateRegistryDb(db: RegistryDb, orgId: string) {
  const templateRoot = join(repoRoot, "packages/cli/templates");
  const moduleRoot = join(repoRoot, "packages/cli/modules");
  const files = [...(await walk(templateRoot)), ...(await walk(moduleRoot))];
  const allContent = files.map((file) => relative(repoRoot, file)).join("\n");
  await upsertRegistryDb(
    db,
    orgId,
    "template_set",
    "facility-standard",
    "Facility standard template set",
    allContent,
  );
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = relative(repoRoot, file);
    const name =
      rel.replace(/^packages\/cli\/(templates|modules)\//, "").replace(extname(rel), "") ||
      basename(file);
    await upsertRegistryDb(db, orgId, kindFor(rel), name, rel, content);
  }
}

function productChainSeed() {
  return {
    id: "product",
    types: {
      S: { name: "Signal", parentTypes: [] },
      D: { name: "Decision", parentTypes: ["S"] },
      T: { name: "Task", parentTypes: ["D"] },
      V: { name: "Verification", parentTypes: ["T"] },
    },
  };
}

function researchChainSeed() {
  return {
    id: "research",
    types: {
      H: { name: "Hypothesis", parentTypes: [] },
      E: { name: "Experiment", parentTypes: ["H"] },
      F: { name: "Finding", parentTypes: ["E"] },
      L: { name: "Literature", parentTypes: [] },
      CR: { name: "Challenge Review", parentTypes: [] },
      SR: { name: "Strategic Review", parentTypes: ["CR"] },
    },
  };
}

async function upsertRegistrySql(
  sql: postgres.Sql,
  orgId: string,
  kind: string,
  name: string,
  description: string,
  content: string,
): Promise<string> {
  const contentHash = hash(content);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO registry_items (id, org_id, scope, kind, name, description, latest_version)
    VALUES (${newId("item")}, ${orgId}, 'bundled', ${kind}, ${name}, ${description}, 1)
    ON CONFLICT (org_id, coalesce(project_id, '__none__'), kind, name)
    DO UPDATE SET description = EXCLUDED.description,
      latest_version = GREATEST(registry_items.latest_version, 1),
      updated_at = now()
    RETURNING id
  `;
  const itemId = rows[0]?.id;
  if (!itemId) throw new Error(`failed to seed registry item ${name}`);
  // Refresh bundled v1 content but DO NOT force status back to 'active' — after an
  // operator publishes v2 (v1 deprecated), reactivating v1 would create two active
  // versions and violate the one-active partial unique index (migration 0011),
  // breaking re-seed on the next restart. (Mirrors upsertRegistryDb.)
  await sql`
    INSERT INTO registry_versions (id, org_id, item_id, version, content, content_hash, changelog, status, created_by)
    VALUES (${newId("ver")}, ${orgId}, ${itemId}, 1, ${content}, ${contentHash}, 'seeded from CLI templates', 'active', 'seed')
    ON CONFLICT (item_id, version)
    DO UPDATE SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, updated_at = now()
  `;
  return itemId;
}

async function upsertRegistryDb(
  db: RegistryDb,
  orgId: string,
  kind: string,
  name: string,
  description: string,
  content: string,
): Promise<string> {
  const contentHash = hash(content);
  const rows = await db.execute(drizzleSql`
    INSERT INTO registry_items (id, org_id, scope, kind, name, description, latest_version)
    VALUES (${newId("item")}, ${orgId}, 'bundled', ${kind}, ${name}, ${description}, 1)
    ON CONFLICT (org_id, coalesce(project_id, '__none__'), kind, name)
    DO UPDATE SET description = EXCLUDED.description,
      latest_version = GREATEST(registry_items.latest_version, 1),
      updated_at = now()
    RETURNING id
  `);
  const itemId = Array.from(rows as Iterable<{ id: string }>)[0]?.id;
  if (!itemId) throw new Error(`failed to seed registry item ${name}`);
  // Refresh the bundled v1 content, but DO NOT force status back to 'active' — if
  // an operator has since published a newer version (v1 deprecated, v2 active),
  // reactivating v1 would create two active versions and violate the one-active
  // partial unique index (migration 0011), breaking re-seed on the next restart.
  await db.execute(drizzleSql`
    INSERT INTO registry_versions (id, org_id, item_id, version, content, content_hash, changelog, status, created_by)
    VALUES (${newId("ver")}, ${orgId}, ${itemId}, 1, ${content}, ${contentHash}, 'seeded from CLI templates', 'active', 'seed')
    ON CONFLICT (item_id, version)
    DO UPDATE SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, updated_at = now()
  `);
  return itemId;
}
