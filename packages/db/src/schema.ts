import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
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
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    verified: boolean("verified").notNull().default(true),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("github_webhook_events_org_received_idx").on(table.orgId, table.receivedAt.desc()),
    foreignKey({
      name: "github_webhook_events_installation_scope_fk",
      columns: [table.orgId, table.installationId],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
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
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("ready"),
    activeAgentName: text("active_agent_name"),
    branch: text("branch"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestUrl: text("pull_request_url"),
    createdBy: jsonb("created_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedFromStatus: text("archived_from_status"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("stories_project_external_uidx").on(table.projectId, table.provider, table.externalId),
    uniqueIndex("stories_org_project_id_uidx").on(table.orgId, table.projectId, table.id),
    index("stories_org_project_status_idx").on(table.orgId, table.projectId, table.status),
    check(
      "stories_status_check",
      sql`${table.status} in ('ready', 'working', 'attention', 'review', 'done', 'archived')`,
    ),
    check("stories_provider_check", sql`${table.provider} in ('github', 'manual', 'schedule')`),
    foreignKey({
      name: "stories_project_scope_fk",
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("story_messages_conversation_seq_uidx").on(table.conversationId, table.seq),
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
