import type {
  DeliveryAcceptanceSnapshot,
  PlanActor,
  PlanAgent,
  PlanRepository,
  PreviewGenerationRepository,
  StoryPlan,
} from "@facility/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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

export const reconciliationCursors = pgTable("reconciliation_cursors", {
  name: text("name").primaryKey(),
  lastId: text("last_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    environmentSecrets: jsonb("environment_secrets").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    unique("projects_org_slug_uidx").on(table.orgId, table.slug),
    uniqueIndex("projects_org_id_uidx").on(table.orgId, table.id),
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
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("api_keys_org_idx").on(table.orgId),
    index("api_keys_prefix_idx").on(table.prefix),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
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
  },
  (table) => [uniqueIndex("github_installations_org_id_uidx").on(table.orgId, table.id)],
);

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

// Facility 0.12 persistent story-workspace domain.
export const projectRepositories = pgTable(
  "project_repositories",
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
    role: text("role").notNull().default("related"),
    ...timestamps,
  },
  (table) => [
    unique("project_repositories_org_owner_name_uidx").on(table.orgId, table.owner, table.name),
    uniqueIndex("project_repositories_org_project_id_uidx").on(
      table.orgId,
      table.projectId,
      table.id,
    ),
    index("project_repositories_org_project_idx").on(table.orgId, table.projectId),
    uniqueIndex("project_repositories_primary_uidx")
      .on(table.projectId)
      .where(sql`${table.role} = 'primary'`),
    check("project_repositories_role_check", sql`${table.role} in ('primary', 'related')`),
    foreignKey({
      name: "project_repositories_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "project_repositories_installation_scope_fk",
      columns: [table.orgId, table.installationId],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
    }),
  ],
);

export const githubWebhookEvents = pgTable(
  "github_webhook_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    installationId: text("installation_id")
      .notNull()
      .references(() => githubInstallations.id),
    projectId: text("project_id").references(() => projects.id),
    repositoryId: text("repository_id").references(() => projectRepositories.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    verified: boolean("verified").notNull().default(true),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("github_webhook_events_org_received_idx").on(table.orgId, table.receivedAt.desc()),
    index("github_webhook_events_project_received_idx").on(
      table.orgId,
      table.projectId,
      table.receivedAt.desc(),
    ),
    foreignKey({
      name: "github_webhook_events_installation_scope_fk",
      columns: [table.orgId, table.installationId],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
    }),
    foreignKey({
      name: "github_webhook_events_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "github_webhook_events_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const githubIssues = pgTable(
  "github_issues",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull(),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    assignees: text("assignees").array().notNull().default(sql`'{}'::text[]`),
    author: text("author"),
    htmlUrl: text("html_url").notNull(),
    commentsCount: integer("comments_count").notNull().default(0),
    githubCreatedAt: timestamp("github_created_at", { withTimezone: true }),
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("github_issues_repository_number_uidx").on(table.repositoryId, table.number),
    index("github_issues_project_state_idx").on(table.orgId, table.projectId, table.state),
    check("github_issues_state_check", sql`${table.state} in ('open', 'closed')`),
    foreignKey({
      name: "github_issues_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "github_issues_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const githubPullRequests = pgTable(
  "github_pull_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull(),
    draft: boolean("draft").notNull().default(false),
    author: text("author"),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    htmlUrl: text("html_url").notNull(),
    closingIssues: integer("closing_issues").array().notNull().default(sql`'{}'::integer[]`),
    ciState: text("ci_state"),
    ciHeadSha: text("ci_head_sha"),
    ciFailureNames: text("ci_failure_names").array().notNull().default(sql`'{}'::text[]`),
    ciUpdatedAt: timestamp("ci_updated_at", { withTimezone: true }),
    githubCreatedAt: timestamp("github_created_at", { withTimezone: true }),
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("github_pull_requests_repository_number_uidx").on(table.repositoryId, table.number),
    index("github_pull_requests_project_state_idx").on(table.orgId, table.projectId, table.state),
    check("github_pull_requests_state_check", sql`${table.state} in ('open', 'closed', 'merged')`),
    check(
      "github_pull_requests_ci_state_check",
      sql`${table.ciState} is null or ${table.ciState} in ('pending', 'success', 'failure')`,
    ),
    foreignKey({
      name: "github_pull_requests_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "github_pull_requests_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const githubCiEvents = pgTable(
  "github_ci_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    state: text("state").notNull(),
    failureNames: text("failure_names").array().notNull().default(sql`'{}'::text[]`),
    sourceEventId: text("source_event_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("github_ci_events_project_observed_idx").on(
      table.orgId,
      table.projectId,
      table.observedAt.desc(),
    ),
    uniqueIndex("github_ci_events_source_uidx")
      .on(table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    check("github_ci_events_state_check", sql`${table.state} in ('pending', 'success', 'failure')`),
    foreignKey({
      name: "github_ci_events_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "github_ci_events_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const stories = pgTable(
  "stories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id").references(() => projectRepositories.id),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("ready"),
    activeAgentName: text("active_agent_name"),
    branch: text("branch"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestUrl: text("pull_request_url"),
    titleSource: text("title_source").notNull().default("user"),
    titleGeneration: jsonb("title_generation"),
    integrationState: jsonb("integration_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    integrationStateRevision: integer("integration_state_revision").notNull().default(0),
    createdBy: jsonb("created_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedFromStatus: text("archived_from_status"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("stories_project_repository_external_uidx").on(
      table.projectId,
      table.provider,
      sql`coalesce(${table.repositoryId}, '__none__')`,
      table.externalId,
    ),
    uniqueIndex("stories_org_project_id_uidx").on(table.orgId, table.projectId, table.id),
    index("stories_org_project_status_idx").on(table.orgId, table.projectId, table.status),
    check(
      "stories_status_check",
      sql`${table.status} in ('ready', 'working', 'attention', 'review', 'done', 'archived')`,
    ),
    check("stories_provider_check", sql`${table.provider} in ('github', 'manual', 'schedule')`),
    check(
      "stories_integration_state_check",
      sql`jsonb_typeof(${table.integrationState}) = 'object' and octet_length(${table.integrationState}::text) <= 16384`,
    ),
    check("stories_integration_state_revision_check", sql`${table.integrationStateRevision} >= 0`),
    check(
      "stories_title_source_check",
      sql`${table.titleSource} in ('user', 'github', 'schedule', 'pending', 'generated', 'fallback')`,
    ),
    foreignKey({
      name: "stories_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "stories_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const storyDeliveryScopes = pgTable(
  "story_delivery_scopes",
  {
    storyId: text("story_id")
      .primaryKey()
      .references(() => stories.id),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    revision: integer("revision").notNull(),
    executionAuthorization: jsonb("execution_authorization").$type<{
      revision: number;
      actor: { type: "user" | "key"; id: string };
    }>(),
    declaredComplete: boolean("declared_complete").notNull().default(false),
    updatedBy: jsonb("updated_by").$type<{ type: "user" | "service"; id: string }>().notNull(),
    ...timestamps,
  },
  (table) => [
    check("story_delivery_scopes_revision_check", sql`${table.revision} > 0`),
    check(
      "story_delivery_scopes_actor_check",
      sql`jsonb_typeof(${table.updatedBy}) = 'object' and octet_length(${table.updatedBy}::text) <= 512`,
    ),
    foreignKey({
      name: "story_delivery_scopes_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const storyDeliveryPullRequests = pgTable(
  "story_delivery_pull_requests",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    pullNumber: integer("pull_number").notNull(),
    required: boolean("required").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.storyId, table.repositoryId, table.pullNumber] }),
    uniqueIndex("story_delivery_pull_requests_primary_uidx")
      .on(table.storyId)
      .where(sql`${table.isPrimary}`),
    index("story_delivery_pull_requests_scope_idx").on(table.orgId, table.projectId, table.storyId),
    index("story_delivery_pull_requests_repository_idx").on(table.repositoryId, table.pullNumber),
    check("story_delivery_pull_requests_number_check", sql`${table.pullNumber} > 0`),
    check(
      "story_delivery_pull_requests_primary_required_check",
      sql`not ${table.isPrimary} or ${table.required}`,
    ),
    foreignKey({
      name: "story_delivery_pull_requests_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_delivery_pull_requests_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
    foreignKey({
      name: "story_delivery_pull_requests_observed_pr_fk",
      columns: [table.repositoryId, table.pullNumber],
      foreignColumns: [githubPullRequests.repositoryId, githubPullRequests.number],
    }),
  ],
);

export const storyPreviewGenerations = pgTable(
  "story_preview_generations",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    generation: text("generation").notNull(),
    deliveryRevision: text("delivery_revision").notNull(),
    repositories: jsonb("repositories").$type<PreviewGenerationRepository[]>().notNull(),
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storyId, table.generation] }),
    index("story_preview_generations_scope_idx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.createdAt,
    ),
    check(
      "story_preview_generations_identity_check",
      sql`${table.generation} ~ '^[a-f0-9]{64}$' and ${table.deliveryRevision} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "story_preview_generations_repositories_check",
      sql`jsonb_typeof(${table.repositories}) = 'array' and jsonb_array_length(${table.repositories}) between 1 and 50 and octet_length(${table.repositories}::text) <= 65536`,
    ),
    foreignKey({
      name: "story_preview_generations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const storyPreviewConvergences = pgTable(
  "story_preview_convergences",
  {
    storyId: text("story_id")
      .primaryKey()
      .references(() => stories.id),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    desiredGeneration: text("desired_generation").notNull(),
    desiredObservedAt: timestamp("desired_observed_at", { withTimezone: true }).notNull(),
    deployedGeneration: text("deployed_generation"),
    lastGoodGeneration: text("last_good_generation"),
    state: text("state").notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    leaseToken: text("lease_token"),
    leaseGeneration: text("lease_generation"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("story_preview_convergences_recovery_idx").on(
      table.state,
      table.retryAt,
      table.leaseExpiresAt,
    ),
    check("story_preview_convergences_revision_check", sql`${table.revision} > 0`),
    check(
      "story_preview_convergences_state_check",
      sql`${table.state} in ('pending', 'waiting', 'applying', 'blocked', 'failed', 'ready', 'suspended')`,
    ),
    check(
      "story_preview_convergences_lease_check",
      sql`(${table.leaseToken} is null and ${table.leaseGeneration} is null and ${table.leaseExpiresAt} is null) or (${table.state} = 'applying' and ${table.leaseToken} is not null and ${table.leaseGeneration} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
    foreignKey({
      name: "story_preview_convergences_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_preview_convergences_desired_generation_fk",
      columns: [table.storyId, table.desiredGeneration],
      foreignColumns: [storyPreviewGenerations.storyId, storyPreviewGenerations.generation],
    }),
    foreignKey({
      name: "story_preview_convergences_deployed_generation_fk",
      columns: [table.storyId, table.deployedGeneration],
      foreignColumns: [storyPreviewGenerations.storyId, storyPreviewGenerations.generation],
    }),
    foreignKey({
      name: "story_preview_convergences_last_good_generation_fk",
      columns: [table.storyId, table.lastGoodGeneration],
      foreignColumns: [storyPreviewGenerations.storyId, storyPreviewGenerations.generation],
    }),
  ],
);

export const storyPreviewAttempts = pgTable(
  "story_preview_attempts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    generation: text("generation").notNull(),
    attempt: integer("attempt").notNull(),
    leaseToken: text("lease_token").notNull(),
    state: text("state").notNull().default("applying"),
    workspaceId: text("workspace_id"),
    cause: jsonb("cause").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("story_preview_attempts_story_attempt_uidx").on(table.storyId, table.attempt),
    unique("story_preview_attempts_story_lease_uidx").on(table.storyId, table.leaseToken),
    index("story_preview_attempts_scope_idx").on(table.orgId, table.projectId, table.storyId),
    check("story_preview_attempts_attempt_check", sql`${table.attempt} > 0`),
    check(
      "story_preview_attempts_state_check",
      sql`${table.state} in ('applying', 'succeeded', 'failed', 'blocked', 'superseded')`,
    ),
    check(
      "story_preview_attempts_ended_check",
      sql`(${table.state} = 'applying' and ${table.endedAt} is null) or (${table.state} != 'applying' and ${table.endedAt} is not null)`,
    ),
    check(
      "story_preview_attempts_cause_check",
      sql`jsonb_typeof(${table.cause}) = 'object' and octet_length(${table.cause}::text) <= 16384`,
    ),
    foreignKey({
      name: "story_preview_attempts_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_preview_attempts_generation_fk",
      columns: [table.storyId, table.generation],
      foreignColumns: [storyPreviewGenerations.storyId, storyPreviewGenerations.generation],
    }),
  ],
);

export const storyPlanRevisions = pgTable(
  "story_plan_revisions",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    revision: integer("revision").notNull(),
    digest: text("digest").notNull(),
    markdown: text("markdown").notNull(),
    repositories: jsonb("repositories").$type<PlanRepository[]>().notNull(),
    agents: jsonb("agents").$type<PlanAgent[]>().notNull(),
    proposedBy: jsonb("proposed_by").$type<PlanActor>().notNull(),
    sourceMessageId: text("source_message_id"),
    source: jsonb("source").$type<NonNullable<StoryPlan["source"]>>(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storyId, table.revision] }),
    unique("story_plan_revisions_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.revision,
    ),
    unique("story_plan_revisions_digest_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.revision,
      table.digest,
    ),
    check("story_plan_revisions_revision_check", sql`${table.revision} > 0`),
    check("story_plan_revisions_digest_check", sql`${table.digest} ~ '^[a-f0-9]{64}$'`),
    check(
      "story_plan_revisions_markdown_check",
      sql`length(${table.markdown}) > 0 and octet_length(${table.markdown}) <= 400000`,
    ),
    check(
      "story_plan_revisions_repositories_check",
      sql`jsonb_typeof(${table.repositories}) = 'array' and jsonb_array_length(${table.repositories}) between 1 and 50 and octet_length(${table.repositories}::text) <= 100000`,
    ),
    check(
      "story_plan_revisions_agents_check",
      sql`jsonb_typeof(${table.agents}) = 'array' and jsonb_array_length(${table.agents}) between 1 and 20 and octet_length(${table.agents}::text) <= 100000`,
    ),
    check(
      "story_plan_revisions_proposed_by_check",
      sql`jsonb_typeof(${table.proposedBy}) = 'object' and coalesce(${table.proposedBy}->>'type' in ('user', 'service'), false) and octet_length(${table.proposedBy}::text) <= 2048`,
    ),
    check(
      "story_plan_revisions_source_check",
      sql`(${table.sourceMessageId} is null and ${table.source} is null) or (${table.sourceMessageId} is not null and ${table.source} is not null and jsonb_typeof(${table.source}) = 'object' and coalesce(${table.source}->>'messageId' = ${table.sourceMessageId}, false) and octet_length(${table.source}::text) <= 2048)`,
    ),
    foreignKey({
      name: "story_plan_revisions_story_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_plan_revisions_source_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.sourceMessageId],
      foreignColumns: [
        storyMessages.orgId,
        storyMessages.projectId,
        storyMessages.storyId,
        storyMessages.id,
      ],
    }),
  ],
);

export const storyPlanRepositoryRefs = pgTable(
  "story_plan_repository_refs",
  {
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    revision: integer("revision").notNull(),
    repositoryId: text("repository_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storyId, table.revision, table.repositoryId] }),
    foreignKey({
      name: "story_plan_repository_refs_plan_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.revision],
      foreignColumns: [
        storyPlanRevisions.orgId,
        storyPlanRevisions.projectId,
        storyPlanRevisions.storyId,
        storyPlanRevisions.revision,
      ],
    }),
    foreignKey({
      name: "story_plan_repository_refs_repo_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const storyPlanStates = pgTable(
  "story_plan_states",
  {
    storyId: text("story_id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    revision: integer("revision").notNull(),
    decisionRevision: integer("decision_revision").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    check("story_plan_states_revision_check", sql`${table.revision} > 0`),
    check("story_plan_states_decision_revision_check", sql`${table.decisionRevision} >= 0`),
    foreignKey({
      name: "story_plan_states_current_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.revision],
      foreignColumns: [
        storyPlanRevisions.orgId,
        storyPlanRevisions.projectId,
        storyPlanRevisions.storyId,
        storyPlanRevisions.revision,
      ],
    }),
  ],
);

export const storyPlanRequests = pgTable(
  "story_plan_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    planDigest: text("plan_digest").notNull(),
    decisionRevision: integer("decision_revision").notNull(),
    intent: text("intent").$type<"approve" | "reject">().notNull(),
    reason: text("reason"),
    requestedBy: jsonb("requested_by").$type<PlanActor>().notNull(),
    boundUserId: text("bound_user_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: text("consumed_by_user_id"),
  },
  (table) => [
    unique("story_plan_requests_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.id,
    ),
    index("story_plan_requests_pending_idx")
      .on(table.orgId, table.projectId, table.storyId, table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
    check("story_plan_requests_plan_revision_check", sql`${table.planRevision} > 0`),
    check("story_plan_requests_decision_revision_check", sql`${table.decisionRevision} >= 0`),
    check("story_plan_requests_intent_check", sql`${table.intent} in ('approve', 'reject')`),
    check(
      "story_plan_requests_reason_check",
      sql`${table.reason} is null or octet_length(${table.reason}) <= 8000`,
    ),
    check(
      "story_plan_requests_requested_by_check",
      sql`jsonb_typeof(${table.requestedBy}) = 'object' and coalesce(${table.requestedBy}->>'type' in ('user', 'service'), false) and octet_length(${table.requestedBy}::text) <= 2048`,
    ),
    check("story_plan_requests_expiry_check", sql`${table.expiresAt} > ${table.requestedAt}`),
    check(
      "story_plan_requests_rejection_check",
      sql`${table.intent} <> 'reject' or (${table.reason} is not null and length(${table.reason}) > 0)`,
    ),
    check(
      "story_plan_requests_consumed_check",
      sql`(${table.consumedAt} is null) = (${table.consumedByUserId} is null)`,
    ),
    foreignKey({
      name: "story_plan_requests_target_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.planRevision, table.planDigest],
      foreignColumns: [
        storyPlanRevisions.orgId,
        storyPlanRevisions.projectId,
        storyPlanRevisions.storyId,
        storyPlanRevisions.revision,
        storyPlanRevisions.digest,
      ],
    }),
  ],
);

export const storyPlanDecisions = pgTable(
  "story_plan_decisions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    planDigest: text("plan_digest").notNull(),
    decisionRevision: integer("decision_revision").notNull(),
    requestId: text("request_id").notNull().unique(),
    intent: text("intent").$type<"approve" | "reject">().notNull(),
    reason: text("reason"),
    confirmedBy: jsonb("confirmed_by").$type<PlanActor & { type: "user" }>().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
    method: text("method").$type<"interactive_session">().notNull().default("interactive_session"),
  },
  (table) => [
    unique("story_plan_decisions_revision_uidx").on(table.storyId, table.decisionRevision),
    check("story_plan_decisions_plan_revision_check", sql`${table.planRevision} > 0`),
    check("story_plan_decisions_decision_revision_check", sql`${table.decisionRevision} > 0`),
    check("story_plan_decisions_intent_check", sql`${table.intent} in ('approve', 'reject')`),
    check(
      "story_plan_decisions_reason_check",
      sql`${table.reason} is null or octet_length(${table.reason}) <= 8000`,
    ),
    check(
      "story_plan_decisions_confirmed_by_check",
      sql`jsonb_typeof(${table.confirmedBy}) = 'object' and coalesce(${table.confirmedBy}->>'type' = 'user', false) and octet_length(${table.confirmedBy}::text) <= 2048`,
    ),
    check("story_plan_decisions_method_check", sql`${table.method} = 'interactive_session'`),
    check(
      "story_plan_decisions_rejection_check",
      sql`${table.intent} <> 'reject' or (${table.reason} is not null and length(${table.reason}) > 0)`,
    ),
    foreignKey({
      name: "story_plan_decisions_target_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.planRevision, table.planDigest],
      foreignColumns: [
        storyPlanRevisions.orgId,
        storyPlanRevisions.projectId,
        storyPlanRevisions.storyId,
        storyPlanRevisions.revision,
        storyPlanRevisions.digest,
      ],
    }),
    foreignKey({
      name: "story_plan_decisions_request_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.requestId],
      foreignColumns: [
        storyPlanRequests.orgId,
        storyPlanRequests.projectId,
        storyPlanRequests.storyId,
        storyPlanRequests.id,
      ],
    }),
  ],
);

/** Durable, coalesced lifecycle notification cursor; never project-owned data. */
export const storyIntegrationNotifications = pgTable(
  "story_integration_notifications",
  {
    storyId: text("story_id")
      .primaryKey()
      .references(() => stories.id),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyRevision: text("story_revision"),
    workspaceRevision: text("workspace_revision"),
    pending: jsonb("pending")
      .$type<
        Array<{
          eventId: string;
          type: "story.updated" | "workspace.updated";
          occurredAt: string;
          workspaceId: string | null;
        }>
      >()
      .notNull()
      .default([]),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .default(sql`'1970-01-01'::timestamptz`),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "story_integration_notifications_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    index("story_integration_notifications_due_idx").on(table.nextAttemptAt, table.observedAt),
  ],
);

export const storyDeliveryIntegrations = pgTable(
  "story_delivery_integrations",
  {
    storyId: text("story_id")
      .primaryKey()
      .references(() => stories.id),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    candidateRevision: text("candidate_revision").notNull(),
    mode: text("mode").$type<"manual" | "repository_dispatch">().notNull(),
    repositoryId: text("repository_id"),
    state: text("state")
      .$type<"pending" | "dispatching" | "dispatched" | "succeeded" | "failed">()
      .notNull()
      .default("pending"),
    attempt: integer("attempt").notNull().default(0),
    eventId: text("event_id"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    errorCode: text("error_code"),
    summary: text("summary"),
    evidenceUrl: text("evidence_url"),
    recordedBy: jsonb("recorded_by").$type<{ type: "user" | "service"; id: string }>(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("story_delivery_integrations_due_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
    check(
      "story_delivery_integrations_candidate_check",
      sql`${table.candidateRevision} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "story_delivery_integrations_mode_check",
      sql`${table.mode} in ('manual', 'repository_dispatch')`,
    ),
    check(
      "story_delivery_integrations_state_check",
      sql`${table.state} in ('pending', 'dispatching', 'dispatched', 'succeeded', 'failed')`,
    ),
    check("story_delivery_integrations_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "story_delivery_integrations_repository_check",
      sql`(${table.mode} = 'manual' and ${table.repositoryId} is null) or (${table.mode} = 'repository_dispatch' and ${table.repositoryId} is not null)`,
    ),
    check(
      "story_delivery_integrations_lease_check",
      sql`(${table.leaseToken} is null and ${table.leaseUntil} is null) or (${table.state} = 'dispatching' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)`,
    ),
    check(
      "story_delivery_integrations_result_check",
      sql`(${table.state} = 'succeeded' and ${table.summary} is not null and ${table.recordedBy} is not null and ${table.recordedAt} is not null and ${table.errorCode} is null) or (${table.state} = 'failed' and ((${table.summary} is not null and ${table.recordedBy} is not null and ${table.recordedAt} is not null and ${table.errorCode} is null) or (${table.summary} is null and ${table.evidenceUrl} is null and ${table.recordedBy} is null and ${table.recordedAt} is null and ${table.errorCode} is not null))) or (${table.state} in ('pending', 'dispatching', 'dispatched') and ${table.summary} is null and ${table.evidenceUrl} is null and ${table.recordedBy} is null and ${table.recordedAt} is null and ${table.errorCode} is null)`,
    ),
    check(
      "story_delivery_integrations_summary_check",
      sql`${table.summary} is null or octet_length(${table.summary}) <= 2000`,
    ),
    check(
      "story_delivery_integrations_evidence_check",
      sql`${table.evidenceUrl} is null or octet_length(${table.evidenceUrl}) <= 2000`,
    ),
    check(
      "story_delivery_integrations_actor_check",
      sql`${table.recordedBy} is null or (jsonb_typeof(${table.recordedBy}) = 'object' and octet_length(${table.recordedBy}::text) <= 512)`,
    ),
    foreignKey({
      name: "story_delivery_integrations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_delivery_integrations_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const storyCompletionOperations = pgTable(
  "story_completion_operations",
  {
    storyId: text("story_id")
      .primaryKey()
      .references(() => stories.id),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    candidateRevision: text("candidate_revision").notNull(),
    state: text("state")
      .$type<"pending" | "closing" | "failed" | "completed">()
      .notNull()
      .default("pending"),
    attempt: integer("attempt").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    errorCode: text("error_code"),
    requestedBy: jsonb("requested_by").$type<{ type: "user" | "service"; id: string }>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("story_completion_operations_due_idx").on(
      table.state,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
    check(
      "story_completion_operations_candidate_check",
      sql`${table.candidateRevision} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "story_completion_operations_state_check",
      sql`${table.state} in ('pending', 'closing', 'failed', 'completed')`,
    ),
    check("story_completion_operations_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "story_completion_operations_lease_check",
      sql`(${table.leaseToken} is null and ${table.leaseUntil} is null) or (${table.state} = 'closing' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)`,
    ),
    check(
      "story_completion_operations_completed_check",
      sql`(${table.state} = 'completed') = (${table.completedAt} is not null)`,
    ),
    check(
      "story_completion_operations_actor_check",
      sql`jsonb_typeof(${table.requestedBy}) = 'object' and octet_length(${table.requestedBy}::text) <= 512`,
    ),
    foreignKey({
      name: "story_completion_operations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const storyAssignees = pgTable(
  "story_assignees",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    source: text("source").notNull().default("facility"),
    addedBy: jsonb("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("story_assignees_story_subject_uidx").on(table.storyId, table.kind, table.subject),
    index("story_assignees_org_project_subject_idx").on(
      table.orgId,
      table.projectId,
      table.kind,
      table.subject,
    ),
    check("story_assignees_kind_check", sql`${table.kind} in ('user', 'github')`),
    check("story_assignees_source_check", sql`${table.source} in ('facility', 'github')`),
    foreignKey({
      name: "story_assignees_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    provider: text("provider").notNull(),
    externalRef: text("external_ref"),
    volumeRef: text("volume_ref").notNull(),
    state: text("state").notNull().default("creating"),
    setupChecksum: text("setup_checksum"),
    nextEventSeq: bigint("next_event_seq", { mode: "number" }).notNull().default(1),
    environment: jsonb("environment").notNull().default(sql`'{}'::jsonb`),
    endpoints: jsonb("endpoints").notNull().default(sql`'[]'::jsonb`),
    error: text("error"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspaces_org_project_id_uidx").on(table.orgId, table.projectId, table.id),
    uniqueIndex("workspaces_org_id_uidx").on(table.orgId, table.id),
    uniqueIndex("workspaces_story_active_uidx")
      .on(table.storyId)
      .where(sql`${table.state} in ('creating', 'running', 'sleeping', 'error')`),
    index("workspaces_org_project_state_idx").on(table.orgId, table.projectId, table.state),
    check("workspaces_provider_check", sql`${table.provider} in ('docker', 'vercel', 'fake')`),
    check("workspaces_next_event_seq_check", sql`${table.nextEventSeq} > 0`),
    check(
      "workspaces_state_check",
      sql`${table.state} in ('creating', 'running', 'sleeping', 'error', 'deleting', 'destroyed')`,
    ),
    foreignKey({
      name: "workspaces_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const storyConversations = pgTable(
  "story_conversations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    summary: text("summary"),
    nextSeq: integer("next_seq").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("story_conversations_story_uidx").on(table.storyId),
    uniqueIndex("story_conversations_org_project_id_uidx").on(
      table.orgId,
      table.projectId,
      table.id,
    ),
    index("story_conversations_org_project_idx").on(table.orgId, table.projectId),
    check("story_conversations_next_seq_check", sql`${table.nextSeq} > 0`),
    foreignKey({
      name: "story_conversations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const storyMessages = pgTable(
  "story_messages",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => storyConversations.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    body: text("body").notNull(),
    actor: jsonb("actor").notNull(),
    turnId: text("turn_id"),
    requestedAgentName: text("requested_agent_name"),
    requestedTrigger: jsonb("requested_trigger"),
    dedupeKey: text("dedupe_key"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("story_messages_conversation_seq_uidx").on(table.conversationId, table.seq),
    unique("story_messages_scope_identity_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.id,
    ),
    uniqueIndex("story_messages_conversation_dedupe_uidx")
      .on(table.conversationId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index("story_messages_org_story_seq_idx").on(table.orgId, table.storyId, table.seq),
    check("story_messages_role_check", sql`${table.role} in ('user', 'agent', 'system')`),
    check("story_messages_seq_check", sql`${table.seq} > 0`),
    foreignKey({
      name: "story_messages_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_messages_conversation_scope_fk",
      columns: [table.orgId, table.projectId, table.conversationId],
      foreignColumns: [
        storyConversations.orgId,
        storyConversations.projectId,
        storyConversations.id,
      ],
    }),
    foreignKey({
      name: "story_messages_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.conversationId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.conversationId, turns.id],
    }),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => storyConversations.id),
    agentName: text("agent_name").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull().default("queued"),
    triggerType: text("trigger_type").notNull(),
    triggerKey: text("trigger_key"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    error: text("error"),
    nextEventSeq: bigint("next_event_seq", { mode: "number" }).notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdBy: jsonb("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("turns_org_project_id_uidx").on(table.orgId, table.projectId, table.id),
    uniqueIndex("turns_story_scope_uidx").on(table.orgId, table.projectId, table.storyId, table.id),
    uniqueIndex("turns_message_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.conversationId,
      table.id,
    ),
    uniqueIndex("turns_story_active_uidx")
      .on(table.storyId)
      .where(sql`${table.state} in ('queued', 'running')`),
    uniqueIndex("turns_schedule_uidx")
      .on(table.projectId, table.agentName, table.triggerKey, table.scheduledFor)
      .where(sql`${table.scheduledFor} is not null`),
    index("turns_org_story_created_idx").on(table.orgId, table.storyId, table.createdAt.desc()),
    check("turns_engine_check", sql`${table.engine} in ('claude_code', 'codex')`),
    check("turns_next_event_seq_check", sql`${table.nextEventSeq} > 0`),
    check(
      "turns_state_check",
      sql`${table.state} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    foreignKey({
      name: "turns_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "turns_conversation_scope_fk",
      columns: [table.orgId, table.projectId, table.conversationId],
      foreignColumns: [
        storyConversations.orgId,
        storyConversations.projectId,
        storyConversations.id,
      ],
    }),
  ],
);

export const projectBudgets = pgTable(
  "project_budgets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    monthlyLimitCents: integer("monthly_limit_cents").notNull(),
    warningPercent: integer("warning_percent").notNull().default(80),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: text("updated_by"),
    ...timestamps,
  },
  (table) => [
    unique("project_budgets_project_uidx").on(table.projectId),
    index("project_budgets_org_idx").on(table.orgId),
    check("project_budgets_limit_check", sql`${table.monthlyLimitCents} >= 0`),
    check("project_budgets_warning_check", sql`${table.warningPercent} between 1 and 100`),
    foreignKey({
      name: "project_budgets_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
  ],
);

export const turnUsage = pgTable(
  "turn_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id),
    agentName: text("agent_name").notNull(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    costCents: numeric("cost_cents", { mode: "number" }),
    priced: boolean("priced").notNull(),
    source: text("source").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("turn_usage_turn_uidx").on(table.turnId),
    index("turn_usage_project_created_idx").on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
    check(
      "turn_usage_source_check",
      sql`${table.source} in ('provider', 'price_book', 'unpriced')`,
    ),
    check("turn_usage_status_check", sql`${table.status} in ('succeeded', 'failed')`),
    check(
      "turn_usage_tokens_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadTokens} >= 0 and ${table.cacheWriteTokens} >= 0`,
    ),
    foreignKey({
      name: "turn_usage_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

/**
 * Open holds count toward the monthly cap until measured usage replaces them.
 * Title calls settle in place. Turn calls delete the hold when `turn_usage` is written.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    purpose: text("purpose").notNull(),
    requestKey: text("request_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    reservationId: text("reservation_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull().default("reserved"),
    claimToken: text("claim_token"),
    estimatedCents: numeric("estimated_cents", { mode: "number" }).notNull(),
    costCents: numeric("cost_cents", { mode: "number" }),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_calls_scope_uidx").on(table.orgId, table.projectId, table.storyId, table.id),
    uniqueIndex("model_calls_scope_purpose_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.id,
      table.purpose,
    ),
    uniqueIndex("model_calls_request_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.purpose,
      table.requestKey,
    ),
    index("model_calls_project_idx").on(table.orgId, table.projectId, table.state),
    index("model_calls_expiry_idx").on(table.state, table.expiresAt),
    check("model_calls_purpose_check", sql`${table.purpose} in ('title', 'consultation')`),
    check("model_calls_provider_check", sql`${table.provider} in ('openai', 'anthropic')`),
    check(
      "model_calls_state_check",
      sql`${table.state} in ('reserved', 'started', 'confirmed', 'unconfirmed', 'unbilled')`,
    ),
    check(
      "model_calls_identity_check",
      sql`length(${table.requestKey}) between 1 and 200 and length(${table.fingerprint}) = 43 and length(${table.model}) between 1 and 160`,
    ),
    check(
      "model_calls_cost_check",
      sql`${table.estimatedCents} >= 0 and ${table.estimatedCents} < 'Infinity'::numeric and (${table.costCents} is null or (${table.costCents} >= 0 and ${table.costCents} < 'Infinity'::numeric)) and (${table.state} not in ('confirmed', 'unbilled') or ${table.costCents} is not null)`,
    ),
    check(
      "model_calls_tokens_check",
      sql`(${table.inputTokens} is null or ${table.inputTokens} between 0 and 9007199254740991) and (${table.outputTokens} is null or ${table.outputTokens} between 0 and 9007199254740991) and (${table.cacheReadTokens} is null or ${table.cacheReadTokens} between 0 and 9007199254740991) and (${table.cacheWriteTokens} is null or ${table.cacheWriteTokens} between 0 and 9007199254740991)`,
    ),
    check(
      "model_calls_phase_check",
      sql`(${table.startedAt} is null) = (${table.claimToken} is null) and ${table.expiresAt} > ${table.createdAt} and (${table.state} != 'started' or ${table.startedAt} is not null)`,
    ),
    check(
      "model_calls_settlement_check",
      sql`(${table.settledAt} is null) = (${table.state} in ('reserved', 'started')) and (${table.state} != 'confirmed' or ${table.startedAt} is not null) and (${table.state} != 'unbilled' or (${table.costCents} = 0 and coalesce(${table.inputTokens}, 0) = 0 and coalesce(${table.outputTokens}, 0) = 0 and coalesce(${table.cacheReadTokens}, 0) = 0 and coalesce(${table.cacheWriteTokens}, 0) = 0))`,
    ),
    foreignKey({
      name: "model_calls_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
  ],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id").references(() => turns.id),
    modelCallId: text("model_call_id"),
    purpose: text("purpose").notNull(),
    state: text("state").notNull().default("open"),
    model: text("model").notNull(),
    reservedCents: numeric("reserved_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("budget_reservations_turn_uidx")
      .on(table.turnId)
      .where(sql`${table.turnId} is not null`),
    uniqueIndex("budget_reservations_open_title_uidx")
      .on(table.storyId)
      .where(sql`${table.purpose} = 'title' and ${table.state} = 'open'`),
    index("budget_reservations_project_idx").on(table.orgId, table.projectId, table.state),
    uniqueIndex("budget_reservations_model_call_uidx")
      .on(table.modelCallId)
      .where(sql`${table.modelCallId} is not null`),
    check(
      "budget_reservations_model_call_check",
      sql`(${table.modelCallId} is null or ${table.purpose} in ('title', 'consultation')) and (${table.purpose} != 'consultation' or ${table.modelCallId} is not null)`,
    ),
    check(
      "budget_reservations_purpose_check",
      sql`${table.purpose} in ('turn', 'title', 'consultation')`,
    ),
    check("budget_reservations_state_check", sql`${table.state} in ('open', 'settled')`),
    check("budget_reservations_cents_check", sql`${table.reservedCents} >= 0`),
    check(
      "budget_reservations_subject_check",
      sql`(
        (${table.purpose} = 'turn' and ${table.turnId} is not null and ${table.state} = 'open')
        or (${table.purpose} in ('title', 'consultation') and ${table.turnId} is null)
      )`,
    ),
    foreignKey({
      name: "budget_reservations_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "budget_reservations_model_call_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.modelCallId, table.purpose],
      foreignColumns: [
        modelCalls.orgId,
        modelCalls.projectId,
        modelCalls.storyId,
        modelCalls.id,
        modelCalls.purpose,
      ],
    }),
    foreignKey({
      name: "budget_reservations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "budget_reservations_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const storyConsultations = pgTable(
  "story_consultations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    requestKey: text("request_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    actorName: text("actor_name"),
    surface: text("surface").notNull(),
    agentName: text("agent_name").notNull(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort"),
    agentHash: text("agent_hash").notNull(),
    agentPrompt: text("agent_prompt").notNull(),
    catalogRepositoryId: text("catalog_repository_id").notNull(),
    catalogSha: text("catalog_sha").notNull(),
    provider: text("provider").notNull(),
    providerModel: text("provider_model"),
    sourceInputs: jsonb("source_inputs").notNull().default(sql`'[]'::jsonb`),
    request: text("request").notNull(),
    throughMessageSeq: integer("through_message_seq").notNull(),
    savedSummary: text("saved_summary"),
    summaryOmitted: boolean("summary_omitted").notNull().default(false),
    contextPrompt: text("context_prompt"),
    contextData: jsonb("context_data").notNull().default(sql`'{}'::jsonb`),
    contextHash: text("context_hash"),
    state: text("state").notNull().default("queued"),
    processingToken: text("processing_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    modelCallId: text("model_call_id"),
    callPurpose: text("call_purpose").notNull().default("consultation"),
    result: text("result"),
    resultHash: text("result_hash"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("story_consultations_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.id,
    ),
    uniqueIndex("story_consultations_request_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.requestKey,
    ),
    uniqueIndex("story_consultations_active_story_uidx")
      .on(table.orgId, table.projectId, table.storyId)
      .where(sql`${table.state} in ('queued', 'preparing', 'running')`),
    index("story_consultations_project_state_idx").on(table.orgId, table.projectId, table.state),
    index("story_consultations_story_created_idx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.createdAt.desc(),
      table.id,
    ),
    index("story_consultations_expiry_idx").on(table.state, table.expiresAt),
    check(
      "story_consultations_identity_check",
      sql`length(${table.requestKey}) between 8 and 200 and length(${table.fingerprint}) = 43 and ${table.principalType} in ('user', 'key') and length(${table.principalId}) between 1 and 200 and ${table.surface} in ('ui', 'mcp')`,
    ),
    check(
      "story_consultations_agent_check",
      sql`((${table.engine} = 'codex' and ${table.provider} = 'openai') or (${table.engine} = 'claude_code' and ${table.provider} = 'anthropic')) and length(${table.agentName}) between 1 and 64 and length(${table.model}) between 1 and 160 and length(${table.agentHash}) between 1 and 128 and ${table.catalogSha} ~ '^[a-f0-9]{40}$'`,
    ),
    check(
      "story_consultations_text_check",
      sql`octet_length(${table.request}) between 1 and 8000 and octet_length(${table.agentPrompt}) <= 12000 and (${table.savedSummary} is null or octet_length(${table.savedSummary}) <= 4096) and (${table.contextPrompt} is null or octet_length(${table.contextPrompt}) <= 65536) and (${table.result} is null or octet_length(${table.result}) <= 32768)`,
    ),
    check(
      "story_consultations_context_check",
      sql`${table.throughMessageSeq} >= 0 and jsonb_typeof(${table.sourceInputs}) = 'array' and jsonb_array_length(${table.sourceInputs}) <= 4 and jsonb_typeof(${table.contextData}) = 'object' and (${table.contextHash} is null or length(${table.contextHash}) = 43) and (${table.resultHash} is null or length(${table.resultHash}) = 43) and (${table.result} is null) = (${table.resultHash} is null)`,
    ),
    check(
      "story_consultations_state_check",
      sql`${table.state} in ('queued', 'preparing', 'running', 'succeeded', 'incomplete', 'failed', 'canceled') and ${table.callPurpose} = 'consultation'`,
    ),
    check(
      "story_consultations_phase_check",
      sql`${table.expiresAt} > ${table.createdAt} and (${table.endedAt} is null) = (${table.state} in ('queued', 'preparing', 'running')) and (${table.state} not in ('preparing', 'running') or (${table.processingToken} is not null and ${table.leaseExpiresAt} is not null)) and (${table.state} != 'queued' or (${table.processingToken} is null and ${table.leaseExpiresAt} is null)) and (${table.state} != 'running' or (${table.startedAt} is not null and ${table.modelCallId} is not null and ${table.contextHash} is not null and ${table.contextPrompt} is not null)) and (${table.state} != 'succeeded' or (${table.result} is not null and ${table.startedAt} is not null and ${table.modelCallId} is not null))`,
    ),
    foreignKey({
      name: "story_consultations_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_consultations_model_call_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.modelCallId, table.callPurpose],
      foreignColumns: [
        modelCalls.orgId,
        modelCalls.projectId,
        modelCalls.storyId,
        modelCalls.id,
        modelCalls.purpose,
      ],
    }),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id").references(() => projects.id),
    actor: jsonb("actor").notNull(),
    action: text("action").notNull(),
    target: jsonb("target").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("audit_events_project_created_idx").on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
    foreignKey({
      name: "audit_events_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
  ],
);

export const engineSessions = pgTable(
  "engine_sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentName: text("agent_name").notNull(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    nativeSessionId: text("native_session_id").notNull(),
    statePath: text("state_path").notNull(),
    status: text("status").notNull().default("active"),
    lastTurnId: text("last_turn_id").references(() => turns.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("engine_sessions_workspace_native_uidx").on(
      table.workspaceId,
      table.engine,
      table.nativeSessionId,
    ),
    uniqueIndex("engine_sessions_compatible_active_uidx")
      .on(table.workspaceId, table.agentName, table.engine, table.model)
      .where(sql`${table.status} = 'active'`),
    index("engine_sessions_org_story_idx").on(table.orgId, table.storyId, table.lastUsedAt.desc()),
    check("engine_sessions_engine_check", sql`${table.engine} in ('claude_code', 'codex')`),
    check("engine_sessions_status_check", sql`${table.status} in ('active', 'corrupt', 'closed')`),
    foreignKey({
      name: "engine_sessions_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "engine_sessions_workspace_scope_fk",
      columns: [table.orgId, table.projectId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.projectId, workspaces.id],
    }),
    foreignKey({
      name: "engine_sessions_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.lastTurnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const turnEvents = pgTable(
  "turn_events",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.turnId, table.seq] }),
    index("turn_events_org_story_idx").on(table.orgId, table.storyId, table.createdAt),
    foreignKey({
      name: "turn_events_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const storyArtifacts = pgTable(
  "story_artifacts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id").references(() => turns.id),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    uri: text("uri").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index("story_artifacts_org_story_idx").on(table.orgId, table.storyId),
    foreignKey({
      name: "story_artifacts_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_artifacts_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const attentionItems = pgTable(
  "attention_items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id").references(() => turns.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedBy: jsonb("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("attention_items_org_story_status_idx").on(table.orgId, table.storyId, table.status),
    check("attention_items_status_check", sql`${table.status} in ('open', 'resolved')`),
    foreignKey({
      name: "attention_items_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "attention_items_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const agentManifests = pgTable(
  "agent_manifests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("agent_manifests_project_name_uidx").on(table.projectId, table.name),
    index("agent_manifests_org_project_idx").on(table.orgId, table.projectId),
    foreignKey({
      name: "agent_manifests_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
  ],
);

export const agentSchedules = pgTable(
  "agent_schedules",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentName: text("agent_name").notNull(),
    triggerName: text("trigger_name").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.agentName, table.triggerName] }),
    index("agent_schedules_due_idx").on(table.enabled, table.nextRunAt),
    foreignKey({
      name: "agent_schedules_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
  ],
);

export const previewSessions = pgTable(
  "preview_sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    service: text("service").notNull(),
    tokenHash: text("token_hash").notNull(),
    nativeOrigin: text("native_origin"),
    browserChallenge: text("browser_challenge"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("preview_sessions_token_hash_uidx").on(table.tokenHash),
    index("preview_sessions_workspace_expiry_idx").on(table.workspaceId, table.expiresAt),
    foreignKey({
      name: "preview_sessions_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "preview_sessions_workspace_scope_fk",
      columns: [table.orgId, table.projectId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.projectId, workspaces.id],
    }),
    foreignKey({
      name: "preview_sessions_member_scope_fk",
      columns: [table.orgId, table.userId],
      foreignColumns: [orgMembers.orgId, orgMembers.userId],
    }),
  ],
);

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index("workspace_events_org_workspace_idx").on(table.orgId, table.workspaceId, table.seq),
    foreignKey({
      name: "workspace_events_workspace_scope_fk",
      columns: [table.orgId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.id],
    }),
  ],
);

export const projectSkills = pgTable(
  "project_skills",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    directory: text("directory").notNull(),
    description: text("description").notNull(),
    contentHash: text("content_hash").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("project_skills_project_path_uidx").on(table.projectId, table.path),
    index("project_skills_org_project_idx").on(table.orgId, table.projectId),
    check("project_skills_directory_check", sql`${table.directory} in ('.agents', '.claude')`),
    foreignKey({
      name: "project_skills_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
  ],
);

export const turnGitEvidence = pgTable(
  "turn_git_evidence",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references(() => turns.id),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    engineSessionId: text("engine_session_id").notNull(),
    initialBranch: text("initial_branch"),
    initialSha: text("initial_sha").notNull(),
    finalBranch: text("final_branch"),
    finalSha: text("final_sha"),
    commits: jsonb("commits").notNull().default(sql`'[]'::jsonb`),
    changedFiles: jsonb("changed_files").notNull().default(sql`'[]'::jsonb`),
    dirty: boolean("dirty").notNull().default(false),
    captureError: text("capture_error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("turn_git_evidence_story_completed_idx").on(
      table.orgId,
      table.storyId,
      table.completedAt.desc(),
    ),
    index("turn_git_evidence_final_sha_idx")
      .on(table.orgId, table.projectId, table.finalSha)
      .where(sql`${table.finalSha} is not null`),
    foreignKey({
      name: "turn_git_evidence_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
    foreignKey({
      name: "turn_git_evidence_workspace_scope_fk",
      columns: [table.orgId, table.projectId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.projectId, workspaces.id],
    }),
  ],
);

export const storyEvidenceEvents = pgTable(
  "story_evidence_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id),
    turnId: text("turn_id"),
    source: text("source").notNull(),
    type: text("type").notNull(),
    externalKey: text("external_key"),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("story_evidence_events_external_uidx")
      .on(table.storyId, table.source, table.externalKey)
      .where(sql`${table.externalKey} is not null`),
    index("story_evidence_events_story_occurred_idx").on(
      table.orgId,
      table.storyId,
      table.occurredAt.desc(),
    ),
    check(
      "story_evidence_events_source_check",
      sql`${table.source} in ('facility', 'workspace', 'github')`,
    ),
    foreignKey({
      name: "story_evidence_events_story_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_evidence_events_turn_scope_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.turnId],
      foreignColumns: [turns.orgId, turns.projectId, turns.storyId, turns.id],
    }),
  ],
);

export const githubBranches = pgTable(
  "github_branches",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    name: text("name").notNull(),
    headSha: text("head_sha").notNull(),
    protected: boolean("protected").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("github_branches_repository_name_uidx").on(table.repositoryId, table.name),
    index("github_branches_project_updated_idx").on(
      table.orgId,
      table.projectId,
      table.updatedAt.desc(),
    ),
    foreignKey({
      name: "github_branches_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const githubPullRequestReviews = pgTable(
  "github_pull_request_reviews",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    pullNumber: integer("pull_number").notNull(),
    reviewId: text("review_id").notNull(),
    state: text("state").notNull(),
    author: text("author"),
    body: text("body"),
    htmlUrl: text("html_url"),
    commitSha: text("commit_sha"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("github_pull_request_reviews_repository_review_uidx").on(
      table.repositoryId,
      table.reviewId,
    ),
    index("github_pull_request_reviews_pull_idx").on(
      table.repositoryId,
      table.pullNumber,
      table.submittedAt.desc(),
    ),
    foreignKey({
      name: "github_pull_request_reviews_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const githubChecks = pgTable(
  "github_checks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => projectRepositories.id),
    pullNumber: integer("pull_number"),
    checkId: text("check_id").notNull(),
    headSha: text("head_sha").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    detailsUrl: text("details_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    unique("github_checks_repository_check_uidx").on(table.repositoryId, table.checkId),
    index("github_checks_head_idx").on(table.repositoryId, table.headSha, table.updatedAt.desc()),
    foreignKey({
      name: "github_checks_repository_scope_fk",
      columns: [table.orgId, table.projectId, table.repositoryId],
      foreignColumns: [
        projectRepositories.orgId,
        projectRepositories.projectId,
        projectRepositories.id,
      ],
    }),
  ],
);

export const storyDeliveryAcceptanceRequests = pgTable(
  "story_delivery_acceptance_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    snapshot: jsonb("snapshot").$type<DeliveryAcceptanceSnapshot>().notNull(),
    requestedBy: jsonb("requested_by").$type<PlanActor>().notNull(),
    boundUserId: text("bound_user_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: text("consumed_by_user_id"),
  },
  (table) => [
    unique("story_delivery_acceptance_requests_scope_uidx").on(
      table.orgId,
      table.projectId,
      table.storyId,
      table.id,
    ),
    foreignKey({
      name: "story_delivery_acceptance_requests_story_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    check(
      "story_delivery_acceptance_requests_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object' and octet_length(${table.snapshot}::text) <= 100000`,
    ),
    check(
      "story_delivery_acceptance_requests_requested_by_check",
      sql`jsonb_typeof(${table.requestedBy}) = 'object' and coalesce(${table.requestedBy}->>'type' in ('user', 'service'), false) and octet_length(${table.requestedBy}::text) <= 2048`,
    ),
    check(
      "story_delivery_acceptance_requests_expiry_check",
      sql`${table.expiresAt} > ${table.requestedAt}`,
    ),
    check(
      "story_delivery_acceptance_requests_consumed_check",
      sql`(${table.consumedAt} is null) = (${table.consumedByUserId} is null)`,
    ),
    index("story_delivery_acceptance_requests_pending_idx")
      .on(table.orgId, table.projectId, table.storyId, table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
  ],
);

export const storyDeliveryAcceptances = pgTable(
  "story_delivery_acceptances",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    storyId: text("story_id").notNull(),
    revision: integer("revision").notNull(),
    requestId: text("request_id").notNull().unique(),
    snapshot: jsonb("snapshot").$type<DeliveryAcceptanceSnapshot>().notNull(),
    confirmedBy: jsonb("confirmed_by").$type<PlanActor & { type: "user" }>().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method").$type<"interactive_session">().notNull().default("interactive_session"),
  },
  (table) => [
    unique("story_delivery_acceptances_revision_uidx").on(table.storyId, table.revision),
    foreignKey({
      name: "story_delivery_acceptances_story_fk",
      columns: [table.orgId, table.projectId, table.storyId],
      foreignColumns: [stories.orgId, stories.projectId, stories.id],
    }),
    foreignKey({
      name: "story_delivery_acceptances_request_fk",
      columns: [table.orgId, table.projectId, table.storyId, table.requestId],
      foreignColumns: [
        storyDeliveryAcceptanceRequests.orgId,
        storyDeliveryAcceptanceRequests.projectId,
        storyDeliveryAcceptanceRequests.storyId,
        storyDeliveryAcceptanceRequests.id,
      ],
    }),
    check("story_delivery_acceptances_revision_check", sql`${table.revision} > 0`),
    check(
      "story_delivery_acceptances_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object' and octet_length(${table.snapshot}::text) <= 100000`,
    ),
    check(
      "story_delivery_acceptances_confirmed_by_check",
      sql`jsonb_typeof(${table.confirmedBy}) = 'object' and coalesce(${table.confirmedBy}->>'type' = 'user', false) and octet_length(${table.confirmedBy}::text) <= 2048`,
    ),
    check("story_delivery_acceptances_method_check", sql`${table.method} = 'interactive_session'`),
  ],
);
