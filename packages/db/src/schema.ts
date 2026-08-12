import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    login: text("login"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    unique("user_identities_provider_subject_uidx").on(table.provider, table.providerSubject),
    unique("user_identities_user_provider_uidx").on(table.userId, table.provider),
    index("user_identities_user_idx").on(table.userId),
  ],
);

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  ...timestamps,
});

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").references(() => orgs.id),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("roles_org_name_uidx").on(sql`coalesce(${table.orgId}, '__bundled__')`, table.name),
  ],
);

export const orgMembers = pgTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    ...timestamps,
  },
  (table) => [
    unique("org_members_org_user_uidx").on(table.orgId, table.userId),
    index("org_members_org_idx").on(table.orgId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    systemVersion: text("system_version").notNull().default("v1"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    unique("projects_org_slug_uidx").on(table.orgId, table.slug),
    index("projects_org_idx").on(table.orgId),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    last4: text("last4").notNull(),
    hash: text("hash").notNull(),
    scopeType: text("scope_type").notNull(),
    projectId: text("project_id").references(() => projects.id),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    createdBy: text("created_by"),
    // Run-scoped platform keys carry the run they belong to + an expiry, so the
    // reconciler can sweep them when the run goes terminal and auth rejects them
    // once expired. Null for ordinary (user/service) keys. (migration 0010)
    runId: text("run_id").references(() => runs.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("api_keys_org_idx").on(table.orgId),
    index("api_keys_prefix_idx").on(table.prefix),
  ],
);

export const githubInstallations = pgTable("github_installations", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  accountId: bigint("account_id", { mode: "number" }).notNull().default(0),
  accountLogin: text("account_login").notNull(),
  targetType: text("target_type").notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  ...timestamps,
});

/** Encrypted persistence used by the per-instance OAuth authorization server. */
export const oauthArtifacts = pgTable(
  "oauth_artifacts",
  {
    model: text("model").notNull(),
    idHash: text("id_hash").notNull(),
    payload: text("payload").notNull(),
    grantIdHash: text("grant_id_hash"),
    userCodeHash: text("user_code_hash"),
    uidHash: text("uid_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.model, table.idHash] }),
    index("oauth_artifacts_grant_idx").on(table.grantIdHash),
    index("oauth_artifacts_user_code_idx").on(table.userCodeHash),
    index("oauth_artifacts_uid_idx").on(table.uidHash),
    index("oauth_artifacts_expiry_idx").on(table.expiresAt),
  ],
);

export const repos = pgTable(
  "repos",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    installationId: text("installation_id").references(() => githubInstallations.id),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    fingerprintStatus: text("fingerprint_status").notNull().default("unknown"),
    fingerprint: jsonb("fingerprint"),
    fingerprintVerifiedAt: timestamp("fingerprint_verified_at", { withTimezone: true }),
    renderAnswers: jsonb("render_answers"),
    ...timestamps,
  },
  (table) => [
    // Per-org uniqueness (migration 0012): a repo registration is org-scoped, so
    // two orgs can reference the same GitHub repo and neither is an existence
    // oracle for the other.
    unique("repos_org_owner_name_uidx").on(table.orgId, table.owner, table.name),
    index("repos_org_project_idx").on(table.orgId, table.projectId),
  ],
);

export const ghIssues = pgTable(
  "gh_issues",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    author: text("author"),
    labels: jsonb("labels").notNull().default(sql`'[]'::jsonb`),
    assignees: jsonb("assignees").notNull().default(sql`'[]'::jsonb`),
    htmlUrl: text("html_url").notNull(),
    bodyMd: text("body_md"),
    commentsCount: integer("comments_count").notNull().default(0),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("gh_issues_repo_number_uidx").on(table.repoId, table.number),
    index("gh_issues_org_project_state_idx").on(table.orgId, table.projectId, table.state),
    index("gh_issues_org_project_updated_idx").on(
      table.orgId,
      table.projectId,
      table.ghUpdatedAt.desc(),
    ),
    check("gh_issues_state_check", sql`${table.state} in ('open', 'closed')`),
  ],
);

export const ghPullRequests = pgTable(
  "gh_pull_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    draft: boolean("draft").notNull().default(false),
    author: text("author"),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    htmlUrl: text("html_url").notNull(),
    bodyMd: text("body_md"),
    closingIssues: integer("closing_issues").array().notNull().default(sql`'{}'::integer[]`),
    ciState: text("ci_state"),
    ciHeadSha: text("ci_head_sha"),
    ciFailureNames: text("ci_failure_names").array().notNull().default(sql`'{}'::text[]`),
    ciUpdatedAt: timestamp("ci_updated_at", { withTimezone: true }),
    ghCreatedAt: timestamp("gh_created_at", { withTimezone: true }),
    ghUpdatedAt: timestamp("gh_updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("gh_pull_requests_repo_number_uidx").on(table.repoId, table.number),
    index("gh_pull_requests_org_project_state_idx").on(table.orgId, table.projectId, table.state),
    index("gh_pull_requests_repo_head_sha_idx").on(table.repoId, table.headSha),
    index("gh_pull_requests_closing_issues_idx").using("gin", table.closingIssues),
    check("gh_pull_requests_state_check", sql`${table.state} in ('open', 'closed', 'merged')`),
    check(
      "gh_pull_requests_ci_state_check",
      sql`${table.ciState} is null or ${table.ciState} in ('pending', 'success', 'failure')`,
    ),
  ],
);

export const ghCiEvents = pgTable(
  "gh_ci_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    state: text("state").notNull(),
    failureNames: text("failure_names").array().notNull().default(sql`'{}'::text[]`),
    sourceEventId: text("source_event_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("gh_ci_events_state_check", sql`${table.state} in ('pending', 'success', 'failure')`),
    index("gh_ci_events_repo_pull_observed_idx").on(
      table.repoId,
      table.pullNumber,
      table.observedAt,
    ),
    index("gh_ci_events_org_project_observed_idx").on(
      table.orgId,
      table.projectId,
      table.observedAt,
    ),
    uniqueIndex("gh_ci_events_source_pull_uidx")
      .on(table.sourceEventId, table.repoId, table.pullNumber)
      .where(sql`${table.sourceEventId} is not null`),
  ],
);

export const registryItems = pgTable(
  "registry_items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    scope: text("scope").notNull(),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    latestVersion: integer("latest_version").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("registry_items_scope_uidx").on(
      table.orgId,
      sql`coalesce(${table.projectId}, '__none__')`,
      table.kind,
      table.name,
    ),
    index("registry_items_org_idx").on(table.orgId),
  ],
);

export const registryVersions = pgTable(
  "registry_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    itemId: text("item_id")
      .notNull()
      .references(() => registryItems.id),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    changelog: text("changelog"),
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (table) => [
    unique("registry_versions_item_version_uidx").on(table.itemId, table.version),
    index("registry_versions_org_idx").on(table.orgId),
  ],
);

export const bundles = pgTable("bundles", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  description: text("description"),
  scope: text("scope").notNull(),
  ...timestamps,
});

export const bundleItems = pgTable(
  "bundle_items",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    bundleId: text("bundle_id")
      .notNull()
      .references(() => bundles.id),
    itemId: text("item_id")
      .notNull()
      .references(() => registryItems.id),
    versionPin: integer("version_pin"),
  },
  (table) => [
    primaryKey({ columns: [table.bundleId, table.itemId] }),
    index("bundle_items_org_idx").on(table.orgId),
  ],
);

export const sandboxProfiles = pgTable(
  "sandbox_profiles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    driver: text("driver").notNull(),
    image: text("image").notNull(),
    setup: jsonb("setup").notNull().default(sql`'{}'::jsonb`),
    resources: jsonb("resources").notNull().default(sql`'{}'::jsonb`),
    network: jsonb("network").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [index("sandbox_profiles_org_idx").on(table.orgId)],
);

export const agentDefs = pgTable(
  "agent_defs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    engine: text("engine").notNull(),
    model: jsonb("model").notNull(),
    contractItemId: text("contract_item_id")
      .notNull()
      .references(() => registryItems.id),
    harnessItemId: text("harness_item_id").references(() => registryItems.id),
    triggers: jsonb("triggers").notNull().default(sql`'[]'::jsonb`),
    sandboxProfileId: text("sandbox_profile_id").references(() => sandboxProfiles.id),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("agent_defs_org_project_idx").on(table.orgId, table.projectId)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentDefId: text("agent_def_id").references(() => agentDefs.id),
    mode: text("mode").notNull(),
    engine: text("engine").notNull(),
    status: text("status").notNull().default("queued"),
    trigger: jsonb("trigger").notNull().default(sql`'{}'::jsonb`),
    sandbox: jsonb("sandbox").notNull().default(sql`'{}'::jsonb`),
    receipt: jsonb("receipt"),
    gh: jsonb("gh").notNull().default(sql`'{}'::jsonb`),
    engineSessionId: text("engine_session_id"),
    githubDeliveryId: text("github_delivery_id"),
    // A distinct GitHub delivery can report the same failing PR head. This
    // durable admission key prevents scaled workers from dispatching two
    // ci-doctor runs for that head after both observed the same history.
    ciRepairKey: text("ci_repair_key"),
    transcriptUri: text("transcript_uri"),
    sessionStateUri: text("session_state_uri"),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdBy: jsonb("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    index("runs_org_project_idx").on(table.orgId, table.projectId),
    uniqueIndex("runs_org_github_delivery_uidx")
      .on(table.orgId, table.githubDeliveryId)
      .where(sql`${table.githubDeliveryId} is not null`),
    uniqueIndex("runs_org_ci_repair_key_uidx")
      .on(table.orgId, table.ciRepairKey)
      .where(sql`${table.ciRepairKey} is not null`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index("run_events_org_idx").on(table.orgId),
    index("run_events_run_seq_idx").on(table.runId, table.seq),
  ],
);

export const runDeliveries = pgTable(
  "run_deliveries",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    owner: text("owner").notNull(),
    repoName: text("repo_name").notNull(),
    headBranch: text("head_branch").notNull(),
    expectedHeadSha: text("expected_head_sha").notNull(),
    baseBranch: text("base_branch").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    issueNumber: integer("issue_number"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    blockedReason: text("blocked_reason"),
    error: text("error"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("run_deliveries_pending_idx")
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'delivering')`),
    index("run_deliveries_org_project_idx").on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
    check(
      "run_deliveries_status_check",
      sql`${table.status} in ('pending', 'delivering', 'delivered', 'blocked')`,
    ),
    check("run_deliveries_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const steerMessages = pgTable(
  "steer_messages",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    authorUserId: text("author_user_id").references(() => users.id),
    kind: text("kind").notNull().default("steer"),
    body: text("body").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("steer_messages_org_idx").on(table.orgId),
    check("steer_messages_kind_check", sql`${table.kind} in ('steer', 'interrupt')`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentDefId: text("agent_def_id")
      .notNull()
      .references(() => agentDefs.id),
    title: text("title"),
    lastRunId: text("last_run_id").references(() => runs.id),
    engineSessionId: text("engine_session_id"),
    status: text("status").notNull().default("idle"),
    // sandbox = each turn spawns a containerized run (legacy conversation path)
    // assistant = turns execute in the API's in-process Product Owner loop
    kind: text("kind").notNull().default("sandbox"),
    createdBy: jsonb("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    index("conversations_org_project_idx").on(table.orgId, table.projectId),
    check("conversations_status_check", sql`${table.status} in ('idle', 'running')`),
    check("conversations_kind_check", sql`${table.kind} in ('sandbox', 'assistant')`),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    body: text("body").notNull(),
    runId: text("run_id").references(() => runs.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("conversation_messages_conversation_seq_uidx").on(table.conversationId, table.seq),
    index("conversation_messages_org_conversation_idx").on(table.orgId, table.conversationId),
    check("conversation_messages_role_check", sql`${table.role} in ('user', 'agent', 'system')`),
    check("conversation_messages_seq_positive_check", sql`${table.seq} > 0`),
  ],
);

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    authMode: text("auth_mode").notNull().default("api_key"),
    baseUrl: text("base_url"),
    sealedSecret: text("sealed_secret").notNull(),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (table) => [
    unique("provider_credentials_org_provider_name_uidx").on(
      table.orgId,
      table.provider,
      table.name,
    ),
    check("provider_credentials_auth_mode_check", sql`${table.authMode} in ('api_key', 'oauth')`),
    check(
      "provider_credentials_oauth_provider_check",
      sql`${table.authMode} <> 'oauth' or ${table.provider} = 'anthropic'`,
    ),
  ],
);

export const virtualKeys = pgTable(
  "virtual_keys",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    runId: text("run_id").references(() => runs.id),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    last4: text("last4").notNull(),
    hash: text("hash").notNull(),
    allowedModels: text("allowed_models").array(),
    budgetId: text("budget_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("virtual_keys_org_project_idx").on(table.orgId, table.projectId),
    // The gateway looks up by prefix on every model call — must be indexed.
    index("virtual_keys_prefix_idx").on(table.prefix),
  ],
);

export const llmRequests = pgTable(
  "llm_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    runId: text("run_id").references(() => runs.id),
    taskId: text("task_id").references(() => poTasks.id),
    agentDefId: text("agent_def_id").references(() => agentDefs.id),
    virtualKeyId: text("virtual_key_id").references(() => virtualKeys.id),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheRead: integer("cache_read").notNull().default(0),
    cacheWrite: integer("cache_write").notNull().default(0),
    costCents: numeric("cost_cents", { mode: "number" }),
    priced: boolean("priced").notNull().default(true),
    latencyMs: integer("latency_ms").notNull().default(0),
    requestUri: text("request_uri"),
    responseUri: text("response_uri"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("llm_requests_org_project_created_idx").on(table.orgId, table.projectId, table.createdAt),
    index("llm_requests_org_created_group_idx").on(
      table.orgId,
      table.createdAt,
      table.agentDefId,
      table.taskId,
      table.model,
    ),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    scope: text("scope").notNull(),
    projectId: text("project_id").references(() => projects.id),
    agentDefId: text("agent_def_id").references(() => agentDefs.id),
    period: text("period").notNull(),
    limitCents: integer("limit_cents").notNull(),
    mode: text("mode").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index("budgets_org_idx").on(table.orgId),
    // Enum-like invariants the gateway enforces against; backstops every write
    // path (see migration 0013).
    check("budgets_scope_check", sql`${table.scope} in ('org', 'project', 'agent_def')`),
    check("budgets_period_check", sql`${table.period} in ('daily', 'weekly', 'monthly')`),
    check("budgets_mode_check", sql`${table.mode} in ('soft', 'hard')`),
    check("budgets_limit_cents_check", sql`${table.limitCents} >= 0`),
    // Scope coherence (migration 0014): org ⇒ no project/agent; project ⇒ project,
    // no agent; agent_def ⇒ project AND agent.
    check(
      "budgets_scope_coherence_check",
      sql`(${table.scope} = 'org' and ${table.projectId} is null and ${table.agentDefId} is null)
        or (${table.scope} = 'project' and ${table.projectId} is not null and ${table.agentDefId} is null)
        or (${table.scope} = 'agent_def' and ${table.projectId} is not null and ${table.agentDefId} is not null)`,
    ),
  ],
);

export const spendCounters = pgTable(
  "spend_counters",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    budgetId: text("budget_id")
      .notNull()
      .references(() => budgets.id),
    windowStart: date("window_start").notNull(),
    spentCents: numeric("spent_cents", { mode: "number" }).notNull().default(0),
  },
  (table) => [unique("spend_counters_budget_window_uidx").on(table.budgetId, table.windowStart)],
);

export const actionTypes = pgTable(
  "action_types",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    payloadSchema: jsonb("payload_schema").notNull(),
    resolver: jsonb("resolver").notNull(),
    executor: jsonb("executor").notNull(),
    defaultTtlHours: integer("default_ttl_hours").notNull(),
    ...timestamps,
  },
  (table) => [unique("action_types_org_name_uidx").on(table.orgId, table.name)],
);

export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    runId: text("run_id").references(() => runs.id),
    actionTypeId: text("action_type_id")
      .notNull()
      .references(() => actionTypes.id),
    payload: jsonb("payload").notNull(),
    contextMd: text("context_md").notNull(),
    state: text("state").notNull().default("open"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("proposals_org_idx").on(table.orgId)],
);

export const proposalEvents = pgTable(
  "proposal_events",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    type: text("type").notNull(),
    actor: jsonb("actor").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    primaryKey({ columns: [table.proposalId, table.seq] }),
    index("proposal_events_org_idx").on(table.orgId),
  ],
);

export const kbSpaces = pgTable(
  "kb_spaces",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .unique(),
    charterMd: text("charter_md").notNull().default(""),
    activeMd: text("active_md").notNull().default(""),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    charterUpdatedAt: timestamp("charter_updated_at", { withTimezone: true }),
    activeUpdatedAt: timestamp("active_updated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("kb_spaces_org_idx").on(table.orgId)],
);

export const kbEntries = pgTable(
  "kb_entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    spaceId: text("space_id")
      .notNull()
      .references(() => kbSpaces.id),
    type: text("type").notNull(),
    number: integer("number").notNull(),
    slug: text("slug").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default(sql`'{}'::jsonb`),
    bodyMd: text("body_md").notNull(),
    status: text("status"),
    supersedes: text("supersedes"),
    ...timestamps,
  },
  (table) => [
    unique("kb_entries_space_type_number_uidx").on(table.spaceId, table.type, table.number),
    index("kb_entries_org_idx").on(table.orgId),
  ],
);

export const kbEntryVersions = pgTable(
  "kb_entry_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    entryId: text("entry_id")
      .notNull()
      .references(() => kbEntries.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    slug: text("slug").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default({}),
    bodyMd: text("body_md").notNull().default(""),
    status: text("status"),
    savedBy: jsonb("saved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("kb_entry_versions_unique").on(table.entryId, table.version),
    index("kb_entry_versions_entry_idx").on(table.entryId, table.version),
  ],
);

export const kbSpaceDocVersions = pgTable(
  "kb_space_doc_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    spaceId: text("space_id")
      .notNull()
      .references(() => kbSpaces.id, { onDelete: "cascade" }),
    doc: text("doc").notNull(),
    version: integer("version").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    savedBy: jsonb("saved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("kb_space_doc_versions_unique").on(table.spaceId, table.doc, table.version),
    index("kb_space_doc_versions_space_idx").on(table.spaceId, table.doc, table.version),
  ],
);

export const kbLinks = pgTable(
  "kb_links",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    spaceId: text("space_id")
      .notNull()
      .references(() => kbSpaces.id),
    fromEntry: text("from_entry")
      .notNull()
      .references(() => kbEntries.id),
    toEntry: text("to_entry")
      .notNull()
      .references(() => kbEntries.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.fromEntry, table.toEntry] }),
    index("kb_links_org_idx").on(table.orgId),
  ],
);

export const poTasks = pgTable(
  "po_tasks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kbEntryId: text("kb_entry_id").references(() => kbEntries.id),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    wsjf: jsonb("wsjf").notNull().default(sql`'{}'::jsonb`),
    gh: jsonb("gh"),
    status: text("status").notNull().default("draft"),
    ...timestamps,
  },
  (table) => [index("po_tasks_org_project_idx").on(table.orgId, table.projectId)],
);

export const platformIssues = pgTable(
  "platform_issues",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    fingerprint: text("fingerprint").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    state: text("state").notNull().default("open"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
    count: integer("count").notNull().default(1),
    ...timestamps,
  },
  (table) => [unique("platform_issues_org_fingerprint_uidx").on(table.orgId, table.fingerprint)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    actor: jsonb("actor").notNull(),
    action: text("action").notNull(),
    target: jsonb("target").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    ip: text("ip"),
    userAgent: text("user_agent"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("audit_events_org_seq_uidx").on(table.orgId, table.seq),
    index("audit_events_org_seq_idx").on(table.orgId, table.seq),
    index("audit_events_org_project_seq_idx").on(table.orgId, table.projectId, table.seq.desc()),
  ],
);

export const outcomes = pgTable(
  "outcomes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    runId: text("run_id").references(() => runs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    agentLane: text("agent_lane").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    fate: text("fate"),
    accepted: boolean("accepted"),
    issueNumber: integer("issue_number"),
    issueOpenedAt: timestamp("issue_opened_at", { withTimezone: true }),
    mergedBy: text("merged_by"),
    mergerType: text("merger_type"),
    mergeMethod: text("merge_method"),
    reviewRounds: integer("review_rounds").notNull().default(0),
    fixupCommits: integer("fixup_commits").notNull().default(0),
    hoursToTerminal: numeric("hours_to_terminal"),
    hoursIssueToMerge: numeric("hours_issue_to_merge"),
    ...timestamps,
  },
  (table) => [unique("outcomes_org_repo_pr_uidx").on(table.orgId, table.repo, table.prNumber)],
);

export const previewSandboxes = pgTable(
  "preview_sandboxes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id").references(() => repos.id),
    runId: text("run_id").references(() => runs.id),
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha"),
    driver: text("driver").notNull(),
    ref: text("ref"),
    status: text("status").notNull().default("provisioning"),
    authMode: text("auth_mode").notNull().default("facility_session"),
    originUrl: text("origin_url"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    provisionClaimedAt: timestamp("provision_claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    createdBy: jsonb("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("preview_sandboxes_run_uidx")
      .on(table.runId)
      .where(sql`${table.runId} is not null and ${table.status} in ('provisioning', 'running')`),
    index("preview_sandboxes_org_project_idx").on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
    index("preview_sandboxes_expiry_idx").on(table.status, table.expiresAt),
    index("preview_sandboxes_unbound_provision_idx")
      .on(table.status, table.provisionClaimedAt, table.createdAt)
      .where(sql`${table.status} = 'provisioning' and ${table.ref} is null`),
    check(
      "preview_sandboxes_status_check",
      sql`${table.status} in ('provisioning', 'running', 'failed', 'expired', 'destroyed')`,
    ),
    check("preview_sandboxes_auth_check", sql`${table.authMode} = 'facility_session'`),
    check("preview_sandboxes_driver_check", sql`${table.driver} in ('docker', 'aws', 'vercel')`),
  ],
);

export const previewAccessHandoffs = pgTable(
  "preview_access_handoffs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    previewId: text("preview_id")
      .notNull()
      .references(() => previewSandboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("preview_access_handoffs_expiry_idx").on(table.expiresAt),
    index("preview_access_handoffs_preview_user_idx").on(table.previewId, table.userId),
  ],
);

export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    day: date("day").notNull(),
    agentDefId: text("agent_def_id").references(() => agentDefs.id),
    model: text("model").notNull().default("none"),
    runsStarted: integer("runs_started").notNull().default(0),
    runsSucceeded: integer("runs_succeeded").notNull().default(0),
    runsFailed: integer("runs_failed").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheRead: bigint("cache_read", { mode: "number" }).notNull().default(0),
    cacheWrite: bigint("cache_write", { mode: "number" }).notNull().default(0),
    costCents: numeric("cost_cents", { mode: "number" }).notNull().default(0),
    outcomesTotal: integer("outcomes_total").notNull().default(0),
    outcomesAssessed: integer("outcomes_assessed").notNull().default(0),
    outcomesAccepted: integer("outcomes_accepted").notNull().default(0),
    outcomesMerged: integer("outcomes_merged").notNull().default(0),
    outcomesOneShot: integer("outcomes_one_shot").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("analytics_daily_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.day,
      sql`coalesce(${table.agentDefId}, '__none__')`,
      table.model,
    ),
    index("analytics_daily_org_day_idx").on(table.orgId, table.day),
  ],
);

export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    sealedSecret: text("sealed_secret"),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [index("integrations_org_idx").on(table.orgId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    eventType: text("event_type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    responseStatus: integer("response_status"),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("webhook_deliveries_integration_dedupe_uidx").on(table.integrationId, table.dedupeKey),
    index("webhook_deliveries_pending_idx").on(table.status, table.nextAttemptAt),
    index("webhook_deliveries_org_created_idx").on(table.orgId, table.createdAt),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    principalId: text("principal_id").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull().default("pending"),
    statusCode: integer("status_code"),
    responseBody: jsonb("response_body"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("idempotency_records_expiry_idx").on(table.expiresAt)],
);

export const schedulerWatermarks = pgTable("scheduler_watermarks", {
  name: text("name").primaryKey(),
  lastTick: timestamp("last_tick", { withTimezone: true }).notNull(),
  cursor: text("cursor"),
  scanStartedAt: timestamp("scan_started_at", { withTimezone: true }),
  ...timestamps,
});

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    verified: boolean("verified").notNull().default(false),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [index("inbound_events_org_idx").on(table.orgId)],
);
