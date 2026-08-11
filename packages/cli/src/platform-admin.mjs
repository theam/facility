import { readFileSync } from "node:fs";
import { green, yellow } from "./ui.mjs";

export const ADMIN_GROUPS = new Set([
  "org",
  "members",
  "roles",
  "repos",
  "agents",
  "conversations",
  "github",
  "providers",
  "budgets",
  "registry",
  "sandboxes",
  "tasks",
  "virtual-keys",
  "kb",
  "analytics",
  "audit",
  "integrations",
  "spend",
  "proposals",
  "action-types",
  "health",
  "outcomes",
  "catalog",
]);

export async function runAdminCommand(group, args, ctx, flags) {
  validateAdminFlags(group, flags);
  switch (group) {
    case "org":
      return org(args, ctx, flags);
    case "members":
      return members(args, ctx, flags);
    case "roles":
      return roles(args, ctx, flags);
    case "repos":
      return repos(args, ctx, flags);
    case "agents":
      return agents(args, ctx, flags);
    case "conversations":
      return conversations(args, ctx, flags);
    case "github":
      return github(args, ctx, flags);
    case "providers":
      return providers(args, ctx, flags);
    case "budgets":
      return budgets(args, ctx, flags);
    case "registry":
      return registry(args, ctx, flags);
    case "sandboxes":
      return sandboxes(args, ctx, flags);
    case "tasks":
      return tasks(args, ctx, flags);
    case "virtual-keys":
      return virtualKeys(args, ctx, flags);
    case "kb":
      return kb(args, ctx, flags);
    case "analytics":
      return analytics(args, ctx, flags);
    case "audit":
      return audit(args, ctx, flags);
    case "integrations":
      return integrations(args, ctx, flags);
    case "spend":
      return spend(args, ctx, flags);
    case "proposals":
      return proposals(args, ctx, flags);
    case "action-types":
      return actionTypes(args, ctx, flags);
    case "health":
      return projectHealth(args, ctx);
    case "outcomes":
      return outcomes(args, ctx, flags);
    case "catalog":
      return catalog(args, ctx);
    default:
      throw cliError(`Unknown command group: ${group}`);
  }
}

const GLOBAL_FLAGS = ["profile", "json", "timeout", "help", "yes"];
const PAGE_FLAGS = ["limit", "offset"];
const WRITE_FLAGS = ["idempotency-key"];
const ADMIN_FLAGS = {
  org: ["name", "settings"],
  members: ["email", "role", ...PAGE_FLAGS, ...WRITE_FLAGS],
  roles: ["name", "description", "permissions", ...PAGE_FLAGS, ...WRITE_FLAGS],
  repos: ["repo", "branch", "private", "description", "auto-init", ...PAGE_FLAGS, ...WRITE_FLAGS],
  agents: [
    "name",
    "engine",
    "contract",
    "model",
    "triggers",
    "schedule",
    "timezone",
    "harness",
    "sandbox",
    "enabled",
    ...PAGE_FLAGS,
    ...WRITE_FLAGS,
  ],
  conversations: ["agent", "title", ...WRITE_FLAGS],
  github: ["query", "state", "cursor", "agent", "limit", "repo", ...WRITE_FLAGS],
  providers: ["provider", "name", "secret", "auth-mode", "base-url", ...PAGE_FLAGS, ...WRITE_FLAGS],
  budgets: ["id", "scope", "project", "agent", "period", "limit-cents", "mode", "enabled", ...PAGE_FLAGS, ...WRITE_FLAGS],
  registry: [
    "kind",
    "scope",
    "project",
    "name",
    "description",
    "content",
    "content-file",
    "changelog",
    ...PAGE_FLAGS,
    ...WRITE_FLAGS,
  ],
  sandboxes: ["name", "driver", "image", "setup", "resources", "network", ...PAGE_FLAGS, ...WRITE_FLAGS],
  tasks: ["title", "body", "body-file", "status", "kb", "wsjf", "gh", ...PAGE_FLAGS, ...WRITE_FLAGS],
  "virtual-keys": ["name", "models", "expires", ...PAGE_FLAGS, ...WRITE_FLAGS],
  kb: [
    "charter",
    "charter-file",
    "active",
    "active-file",
    "config",
    "type",
    "slug",
    "body",
    "body-file",
    "frontmatter",
    "status",
    "links",
    "dry",
    "number",
    "supersedes",
    ...PAGE_FLAGS,
    ...WRITE_FLAGS,
  ],
  analytics: ["project", "from", "to", "group-by", ...PAGE_FLAGS],
  audit: ["actor", "action", "from", "to", "cursor", "limit"],
  integrations: [
    "project",
    "kind",
    "enabled",
    "limit",
    "offset",
    "name",
    "config",
    "secret",
    "status",
    ...WRITE_FLAGS,
  ],
  spend: ["project", "from", "to", "group-by", ...PAGE_FLAGS],
  proposals: ["project", "run", "action", "payload", "context", "expires", ...WRITE_FLAGS],
  "action-types": [...PAGE_FLAGS],
  health: [],
  outcomes: ["project", "state", "limit"],
  catalog: [],
};

export function validateAdminFlags(group, flags) {
  const allowed = new Set([...GLOBAL_FLAGS, ...(ADMIN_FLAGS[group] ?? [])]);
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag));
  if (unknown.length) {
    throw cliError(
      `Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}`,
      "unknown_flag",
    );
  }
  const booleanFlags = new Set(["json", "yes", "help", "private", "auto-init", "enabled", "dry"]);
  for (const [name, value] of Object.entries(flags)) {
    if (value === true && !booleanFlags.has(name)) {
      throw cliError(`--${name} requires a value`, "invalid_flag");
    }
  }
}

const ADMIN_SUBCOMMAND_FLAGS = {
  org: { __default: [], get: [], show: [], update: ["name", "settings"] },
  members: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    add: ["email", "role", ...WRITE_FLAGS],
    update: ["role"],
    remove: ["yes"],
    delete: ["yes"],
  },
  roles: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    create: ["name", "description", "permissions", ...WRITE_FLAGS],
    update: ["description", "permissions"],
    delete: ["yes"],
  },
  repos: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    connect: ["repo", "branch", "private", "description", "auto-init", ...WRITE_FLAGS],
    create: ["repo", "branch", "private", "description", "auto-init", ...WRITE_FLAGS],
    disconnect: ["yes"],
    delete: ["yes"],
    verify: [...WRITE_FLAGS],
    adopt: [...WRITE_FLAGS],
  },
  agents: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    status: [],
    create: ["name", "engine", "contract", "model", "triggers", "schedule", "timezone", "harness", "sandbox", "enabled", ...WRITE_FLAGS],
    update: ["name", "engine", "contract", "model", "triggers", "schedule", "timezone", "harness", "sandbox", "enabled"],
    delete: ["yes"],
  },
  conversations: {
    __default: [],
    list: [],
    get: [],
    start: ["agent", "title", ...WRITE_FLAGS],
    send: [...WRITE_FLAGS],
  },
  github: {
    installations: [],
    repos: ["query"],
    issues: ["state", "query", "cursor", "limit"],
    issue: ["repo"],
    sync: [...WRITE_FLAGS],
    trigger: ["agent", "repo", ...WRITE_FLAGS],
  },
  providers: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    create: ["provider", "name", "secret", "auth-mode", "base-url", ...WRITE_FLAGS],
    delete: ["yes"],
  },
  budgets: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    get: [],
    set: ["id", "scope", "project", "agent", "period", "limit-cents", "mode", "enabled", ...WRITE_FLAGS],
    create: ["id", "scope", "project", "agent", "period", "limit-cents", "mode", "enabled", ...WRITE_FLAGS],
    delete: ["yes"],
  },
  registry: {
    __default: ["kind", "scope", "project", ...PAGE_FLAGS],
    list: ["kind", "scope", "project", ...PAGE_FLAGS],
    get: [],
    create: ["scope", "project", "kind", "name", "description", "content", "content-file", ...WRITE_FLAGS],
    version: ["content", "content-file", "changelog", ...WRITE_FLAGS],
    publish: [...WRITE_FLAGS],
    deprecate: [...WRITE_FLAGS],
  },
  sandboxes: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    create: ["name", "driver", "image", "setup", "resources", "network", ...WRITE_FLAGS],
    update: ["name", "driver", "image", "setup", "resources", "network"],
    delete: ["yes"],
  },
  tasks: {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    create: ["title", "body", "body-file", "status", "kb", "wsjf", ...WRITE_FLAGS],
    update: ["title", "body", "body-file", "status", "kb", "wsjf", "gh"],
    delete: ["yes"],
    transition: ["status", ...WRITE_FLAGS],
    propose: [...WRITE_FLAGS],
  },
  "virtual-keys": {
    __default: [...PAGE_FLAGS],
    list: [...PAGE_FLAGS],
    issue: ["name", "models", "expires", ...WRITE_FLAGS],
    revoke: ["yes"],
  },
  kb: {},
  analytics: {
    __default: ["project", "from", "to", ...PAGE_FLAGS],
    overview: ["project", "from", "to", ...PAGE_FLAGS],
    timeseries: ["project", "from", "to", "group-by", ...PAGE_FLAGS],
  },
  audit: {
    __default: ["actor", "action", "from", "to", "cursor", "limit"],
    list: ["actor", "action", "from", "to", "cursor", "limit"],
    tail: ["actor", "action", "from", "to", "cursor", "limit"],
    verify: [],
  },
  integrations: {
    __default: ["project", "kind", "enabled", "limit", "offset"],
    list: ["project", "kind", "enabled", "limit", "offset"],
    get: [],
    create: ["project", "kind", "enabled", "name", "config", "secret", ...WRITE_FLAGS],
    update: ["enabled", "name", "config"],
    "rotate-secret": ["secret", ...WRITE_FLAGS],
    events: ["limit", "offset"],
    deliveries: ["status", "limit", "offset"],
    retry: [...WRITE_FLAGS],
    delete: ["yes"],
  },
  spend: { __default: ["project", "from", "to", "group-by", ...PAGE_FLAGS] },
  proposals: {
    __default: [],
    get: [],
    create: ["project", "run", "action", "payload", "context", "expires", ...WRITE_FLAGS],
    execute: [...WRITE_FLAGS],
  },
  "action-types": { __default: [...PAGE_FLAGS], list: [...PAGE_FLAGS], get: [] },
  health: { __default: [] },
  outcomes: { __default: ["project", "state", "limit"], list: ["project", "state", "limit"] },
  catalog: { __default: [], show: [] },
};

export function validateAdminSubcommandFlags(group, args, flags) {
  if (flags.help) return;
  let spec = ADMIN_SUBCOMMAND_FLAGS[group];
  if (!spec) return;
  let sub = args[0] || "__default";
  if (group === "health") {
    // `facility health <project>` has a positional resource, not a subcommand.
    sub = "__default";
  } else if (group === "kb") {
    const area = args[0];
    sub = area === "validate" ? "validate" : `${area || ""}:${args[1] || (area === "space" ? "get" : "list")}`;
    spec = {
      "space:get": [],
      "space:set": ["charter", "charter-file", "active", "active-file", "config"],
      "entries:list": ["type", ...PAGE_FLAGS],
      "entries:get": [],
      "entries:create": ["type", "slug", "body", "body-file", "frontmatter", "status", "links", "dry", ...WRITE_FLAGS],
      "entries:update": ["type", "number", "slug", "body", "body-file", "frontmatter", "status", "supersedes"],
      validate: [...WRITE_FLAGS],
    };
  }
  const allowed = spec[sub];
  if (!allowed) {
    throw cliError(
      `Unknown subcommand ${JSON.stringify(args.join(" ") || sub)} for ${group}. Run facility ${group} --help.`,
      "usage",
    );
  }
  const permitted = new Set(["profile", "json", "timeout", ...allowed]);
  const irrelevant = Object.keys(flags).filter((flag) => !permitted.has(flag));
  if (irrelevant.length) {
    throw cliError(
      `Flag${irrelevant.length === 1 ? "" : "s"} ${irrelevant.map((flag) => `--${flag}`).join(", ")} ${irrelevant.length === 1 ? "is" : "are"} not valid for ${group} ${sub === "__default" ? "" : sub}`.trim(),
      "invalid_flag",
    );
  }
  // Validate pagination while the command is still in the local, pre-auth
  // phase. Malformed input must not trigger project resolution or a request.
  if (flags.limit !== undefined || flags.offset !== undefined) pageQuery(flags);
}

async function org(args, ctx, flags) {
  const sub = args[0] || "get";
  if (sub === "get" || sub === "show") {
    const result = await ctx.api("GET", "/v1/org");
    return details(ctx, result);
  }
  if (sub === "update") {
    const body = compact({
      name: stringFlag(flags.name),
      settings: flags.settings ? jsonObject(flags.settings, "--settings") : undefined,
    });
    if (!Object.keys(body).length) throw usage("facility org update --name|--settings");
    const result = await ctx.api("PATCH", "/v1/org", { body });
    return changed(ctx, result, "updated organization");
  }
  throw usage("facility org get|update");
}

async function members(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await ctx.api("GET", "/v1/members", { query: pageQuery(flags) });
    return list(ctx, result, ["user", "email", "name", "role"], (row) => [
      row.user?.id ?? row.userId,
      row.user?.email ?? row.email,
      row.user?.name ?? row.name,
      row.role?.name ?? row.roleName ?? row.member?.roleId,
    ]);
  }
  if (sub === "add") {
    const email = requiredStringFlag(flags.email, "--email");
    const roleId = requiredStringFlag(flags.role, "--role");
    return changed(
      ctx,
      await ctx.api("POST", "/v1/members", {
        body: { email, roleId },
      }),
      `added ${email}`,
    );
  }
  if (sub === "update") {
    if (!args[1]) throw usage("facility members update <userId> --role <roleId>");
    const roleId = requiredStringFlag(flags.role, "--role");
    return changed(
      ctx,
      await ctx.api("PATCH", `/v1/members/${args[1]}`, { body: { roleId } }),
      `updated member ${args[1]}`,
    );
  }
  if (sub === "remove" || sub === "delete") {
    if (!args[1]) throw usage("facility members remove <userId> --yes");
    confirmed(flags, `Removing member ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/members/${args[1]}`), `removed member ${args[1]}`);
  }
  throw usage("facility members list|add|update|remove");
}

async function roles(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await ctx.api("GET", "/v1/roles", { query: pageQuery(flags) });
    return list(ctx, result, ["id", "name", "permissions", "description"], (row) => [
      row.id,
      row.name,
      arrayValue(row.permissions).join(", "),
      row.description,
    ]);
  }
  if (sub === "create") {
    const name = requiredStringFlag(flags.name, "--name");
    if (flags.permissions === undefined) {
      throw usage("facility roles create --name <name> --permissions <a,b>");
    }
    return changed(
      ctx,
      await ctx.api("POST", "/v1/roles", {
        body: {
          name,
          description: stringFlag(flags.description),
          permissions: stringList(flags.permissions, "--permissions"),
        },
      }),
      `created role ${name}`,
    );
  }
  if (sub === "update") {
    if (!args[1]) throw usage("facility roles update <roleId> --description|--permissions");
    const body = compact({
      description: stringFlag(flags.description),
      permissions: flags.permissions ? stringList(flags.permissions, "--permissions") : undefined,
    });
    if (!Object.keys(body).length) throw usage("facility roles update <roleId> --description|--permissions");
    return changed(ctx, await ctx.api("PATCH", `/v1/roles/${args[1]}`, { body }), `updated role ${args[1]}`);
  }
  if (sub === "delete") {
    if (!args[1]) throw usage("facility roles delete <roleId> --yes");
    confirmed(flags, `Deleting role ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/roles/${args[1]}`), `deleted role ${args[1]}`);
  }
  throw usage("facility roles list|create|update|delete");
}

async function repos(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const project = await ctx.resolveProject(args[1]);
    const result = await ctx.api("GET", `/v1/projects/${project.id}/repos`, {
      query: pageQuery(flags),
    });
    return list(ctx, result, ["id", "repository", "branch", "fingerprint"], (row) => [
      row.id,
      `${row.owner}/${row.name}`,
      row.defaultBranch,
      row.fingerprintStatus,
    ]);
  }
  if (sub === "connect" || sub === "create") {
    const project = await ctx.resolveProject(args[1]);
    const repo = requiredStringFlag(flags.repo, "--repo");
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw cliError("--repo must use owner/name", "invalid_flag");
    const result = await ctx.api("POST", `/v1/projects/${project.id}/repos`, {
      body: {
        owner,
        name,
        mode: sub,
        defaultBranch: stringFlag(flags.branch) ?? "main",
        private: booleanFlag(flags.private, true),
        description: stringFlag(flags.description),
        autoInit: booleanFlag(flags["auto-init"], true),
      },
    });
    return changed(ctx, result, `${sub === "create" ? "created" : "connected"} ${owner}/${name}`);
  }
  if (sub === "disconnect" || sub === "delete") {
    const project = await ctx.resolveProject(args[1]);
    if (!args[2]) throw usage("facility repos disconnect <project> <repoId> --yes");
    confirmed(flags, `Disconnecting repo ${args[2]}`);
    return changed(
      ctx,
      await ctx.api("DELETE", `/v1/projects/${project.id}/repos/${args[2]}`),
      `disconnected repo ${args[2]}`,
    );
  }
  if (sub === "verify" || sub === "adopt") {
    if (!args[1]) throw usage(`facility repos ${sub} <repoId>`);
    return changed(
      ctx,
      await ctx.api("POST", `/v1/repos/${args[1]}/fingerprints/${sub}`),
      `${sub} fingerprints for ${args[1]}`,
    );
  }
  throw usage("facility repos list|connect|create|disconnect|verify|adopt");
}

async function agents(args, ctx, flags) {
  const sub = args[0] || "list";
  const project = await ctx.resolveProject(args[1]);
  const base = `/v1/projects/${project.id}/agents`;
  if (sub === "list") {
    return list(ctx, await ctx.api("GET", base, { query: pageQuery(flags) }), ["id", "name", "engine", "enabled", "contract"], (row) => [
      row.id,
      row.name,
      row.engine,
      row.enabled ? "yes" : "no",
      row.contractItemId,
    ]);
  }
  if (sub === "status") {
    return list(
      ctx,
      await ctx.api("GET", `${base}/status`),
      ["agent", "engine", "enabled", "live", "last", "next", "14d"],
      (row) => [
        row.name,
        row.engine,
        row.enabled ? "yes" : "no",
        row.liveRun?.status,
        row.lastRun?.status,
        row.nextRunAt,
        `${row.counts14d?.succeeded ?? 0}/${row.counts14d?.total ?? 0}`,
      ],
    );
  }
  if (sub === "create") {
    const name = requiredStringFlag(flags.name, "--name");
    const engine = requiredStringFlag(flags.engine, "--engine");
    const contractItemId = requiredStringFlag(flags.contract, "--contract");
    const body = {
      name,
      engine,
      contractItemId,
      model: flags.model ? jsonObject(flags.model, "--model") : {},
      triggers: agentTriggers(flags, []),
      harnessItemId: stringFlag(flags.harness),
      sandboxProfileId: stringFlag(flags.sandbox),
      enabled: booleanFlag(flags.enabled, true),
    };
    return changed(ctx, await ctx.api("POST", base, { body }), `created agent ${name}`);
  }
  if (sub === "update") {
    if (!args[2]) throw usage("facility agents update <project> <agentId> [flags]");
    const body = compact({
      name: stringFlag(flags.name),
      engine: stringFlag(flags.engine),
      contractItemId: stringFlag(flags.contract),
      harnessItemId: stringFlag(flags.harness),
      sandboxProfileId: stringFlag(flags.sandbox),
      model: flags.model ? jsonObject(flags.model, "--model") : undefined,
      triggers:
        flags.triggers !== undefined || flags.schedule !== undefined
          ? agentTriggers(flags, [])
          : undefined,
      enabled: flags.enabled === undefined ? undefined : booleanFlag(flags.enabled),
    });
    if (!Object.keys(body).length) throw usage("facility agents update <project> <agentId> [flags]");
    return changed(ctx, await ctx.api("PATCH", `${base}/${args[2]}`, { body }), `updated agent ${args[2]}`);
  }
  if (sub === "delete") {
    if (!args[2]) throw usage("facility agents delete <project> <agentId> --yes");
    confirmed(flags, `Deleting agent ${args[2]}`);
    return changed(ctx, await ctx.api("DELETE", `${base}/${args[2]}`), `deleted agent ${args[2]}`);
  }
  throw usage("facility agents list|status|create|update|delete <project>");
}

async function conversations(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const project = await ctx.resolveProject(args[1]);
    return list(
      ctx,
      await ctx.api("GET", `/v1/projects/${project.id}/conversations`),
      ["id", "title", "status", "agent", "updated", "last message"],
      (row) => [
        row.id,
        row.title,
        row.status,
        row.agentDefId,
        row.updatedAt,
        row.lastMessage?.body,
      ],
    );
  }
  if (sub === "get") {
    if (!args[1]) throw usage("facility conversations get <conversationId>");
    const result = await ctx.api("GET", `/v1/conversations/${args[1]}`);
    if (ctx.json) ctx.writeJson(result);
    else {
      ctx.table(
        ["field", "value"],
        Object.entries(result.conversation ?? {}).map(([key, value]) => [key, display(value)]),
      );
      ctx.table(
        ["#", "role", "message", "session", "time"],
        arrayValue(result.messages).map((row) => [
          row.seq,
          row.role,
          row.body,
          row.runId,
          row.createdAt,
        ]),
      );
    }
    return 0;
  }
  if (sub === "start") {
    const project = await ctx.resolveProject(args[1]);
    const result = await ctx.api("POST", `/v1/projects/${project.id}/conversations`, {
      body: compact({
        agentDefId: stringFlag(flags.agent),
        title: stringFlag(flags.title),
      }),
    });
    return changed(ctx, result, `started conversation ${result.id}`);
  }
  if (sub === "send") {
    if (!args[1] || args.length < 3) {
      throw usage("facility conversations send <conversationId> <message>");
    }
    const result = await ctx.api("POST", `/v1/conversations/${args[1]}/messages`, {
      body: { body: args.slice(2).join(" ") },
    });
    return changed(ctx, result, `queued session ${result.runId}`);
  }
  throw usage("facility conversations list|get|start|send");
}

async function github(args, ctx, flags) {
  const sub = args[0];
  if (sub === "installations") {
    return list(
      ctx,
      await ctx.api("GET", "/v1/github/installations"),
      ["installation", "account", "target", "status"],
      (row) => [
        row.installationId,
        row.accountLogin,
        row.targetType,
        row.suspendedAt ? "suspended" : "active",
      ],
    );
  }
  if (sub === "repos") {
    const installationId = integerArgument(args[1], "installationId");
    const result = await ctx.api("GET", `/v1/github/installations/${installationId}/repos`, {
      query: compact({ query: stringFlag(flags.query) }),
    });
    return list(ctx, result, ["repository", "visibility", "branch", "URL"], (row) => [
      row.fullName,
      row.private ? "private" : "public",
      row.defaultBranch,
      row.htmlUrl,
    ]);
  }
  if (sub === "issues") {
    const project = await ctx.resolveProject(args[1]);
    const result = await ctx.api("GET", `/v1/projects/${project.id}/issues`, {
      query: compact({
        state: stringFlag(flags.state) ?? "open",
        q: stringFlag(flags.query),
        cursor: stringFlag(flags.cursor),
        limit: numberFlag(flags.limit, "--limit"),
      }),
    });
    return list(ctx, result, ["#", "state", "title", "author", "updated", "sessions"], (row) => [
      row.number,
      row.state,
      row.title,
      row.author,
      row.ghUpdatedAt,
      row.linkedRuns?.length ?? 0,
    ]);
  }
  if (sub === "issue") {
    const project = await ctx.resolveProject(args[1]);
    const number = integerArgument(args[2], "issue number");
    return details(
      ctx,
      await ctx.api("GET", `/v1/projects/${project.id}/issues/${number}`, {
        query: compact({ repoId: stringFlag(flags.repo) }),
      }),
    );
  }
  if (sub === "sync") {
    const project = await ctx.resolveProject(args[1]);
    const result = await ctx.api("POST", `/v1/projects/${project.id}/issues/sync`);
    return changed(ctx, result, `queued issue sync for ${result.queued ?? 0} repositories`);
  }
  if (sub === "trigger") {
    const project = await ctx.resolveProject(args[1]);
    const number = integerArgument(args[2], "issue number");
    const agent = requiredStringFlag(flags.agent, "--agent");
    const result = await ctx.api(
      "POST",
      `/v1/projects/${project.id}/issues/${number}/trigger`,
      {
        query: compact({ repoId: stringFlag(flags.repo) }),
        body: { agent },
      },
    );
    return changed(ctx, result, `triggered session ${result.id} from issue #${number}`);
  }
  throw usage("facility github installations|repos|issues|issue|sync|trigger");
}

async function providers(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    return list(ctx, await ctx.api("GET", "/v1/providers", { query: pageQuery(flags) }), ["id", "provider", "auth", "name", "base URL"], (row) => [
      row.id,
      row.provider,
      row.authMode,
      row.name,
      row.baseUrl,
    ]);
  }
  if (sub === "create") {
    const provider = requiredStringFlag(flags.provider, "--provider");
    const name = requiredStringFlag(flags.name, "--name");
    const secret = requiredStringFlag(flags.secret, "--secret");
    return changed(
      ctx,
      await ctx.api("POST", "/v1/providers", {
        body: {
          provider,
          name,
          secret,
          authMode: stringFlag(flags["auth-mode"]),
          baseUrl: stringFlag(flags["base-url"]),
        },
      }),
      `created ${provider} provider ${name}`,
    );
  }
  if (sub === "delete") {
    if (!args[1]) throw usage("facility providers delete <providerId> --yes");
    confirmed(flags, `Deleting provider ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/providers/${args[1]}`), `deleted provider ${args[1]}`);
  }
  throw usage("facility providers list|create|delete");
}

async function budgets(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await ctx.api("GET", "/v1/budgets", { query: pageQuery(flags) });
    return list(ctx, result, ["id", "scope", "period", "limit", "mode", "enabled"], (row) => [
      row.id,
      row.scope,
      row.period,
      money(row.limitCents),
      row.mode,
      row.enabled ? "yes" : "no",
    ]);
  }
  if (sub === "get") {
    if (!args[1]) throw usage("facility budgets get <budgetId>");
    return details(ctx, await ctx.api("GET", `/v1/budgets/${args[1]}`));
  }
  if (sub === "set" || sub === "create") {
    const budgetId = args[1] ?? stringFlag(flags.id);
    const body = compact({
      scope: stringFlag(flags.scope),
      projectId: stringFlag(flags.project),
      agentDefId: stringFlag(flags.agent),
      period: stringFlag(flags.period),
      limitCents: numberFlag(flags["limit-cents"], "--limit-cents"),
      mode: stringFlag(flags.mode),
      enabled: flags.enabled === undefined ? undefined : booleanFlag(flags.enabled),
    });
    if (!budgetId && (!body.scope || !body.period || body.limitCents === undefined || !body.mode)) {
      throw usage("facility budgets set --scope --period --limit-cents --mode [--project|--agent]");
    }
    const result = budgetId
      ? await ctx.api("PATCH", `/v1/budgets/${budgetId}`, { body })
      : await ctx.api("POST", "/v1/budgets", { body });
    return changed(ctx, result, `${budgetId ? "updated" : "created"} budget ${result.id ?? budgetId}`);
  }
  if (sub === "delete") {
    if (!args[1]) throw usage("facility budgets delete <budgetId> --yes");
    confirmed(flags, `Deleting budget ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/budgets/${args[1]}`), `deleted budget ${args[1]}`);
  }
  throw usage("facility budgets list|get|set|delete");
}

async function registry(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await ctx.api("GET", "/v1/registry/items", {
      query: compact({ kind: stringFlag(flags.kind), scope: stringFlag(flags.scope), projectId: stringFlag(flags.project), ...pageQuery(flags) }),
    });
    return list(ctx, result, ["id", "scope", "kind", "name", "latest"], (row) => [
      row.id,
      row.scope,
      row.kind,
      row.name,
      row.latestVersion,
    ]);
  }
  if (sub === "get") {
    if (!args[1]) throw usage("facility registry get <itemId>");
    return details(ctx, await ctx.api("GET", `/v1/registry/items/${args[1]}`));
  }
  if (sub === "create") {
    const scope = requiredStringFlag(flags.scope, "--scope");
    const kind = requiredStringFlag(flags.kind, "--kind");
    const name = requiredStringFlag(flags.name, "--name");
    const content = contentFlag(flags, "content");
    return changed(
      ctx,
      await ctx.api("POST", "/v1/registry/items", {
        body: {
          scope,
          projectId: stringFlag(flags.project),
          kind,
          name,
          description: stringFlag(flags.description),
          content,
        },
      }),
      `created registry item ${name}`,
    );
  }
  if (sub === "version") {
    if (!args[1]) throw usage("facility registry version <itemId> --content|--content-file");
    return changed(
      ctx,
      await ctx.api("POST", `/v1/registry/items/${args[1]}/versions`, {
        body: { content: contentFlag(flags, "content"), changelog: stringFlag(flags.changelog) },
      }),
      `created version for ${args[1]}`,
    );
  }
  if (sub === "publish" || sub === "deprecate") {
    if (!args[1]) throw usage(`facility registry ${sub} <versionId>`);
    return changed(
      ctx,
      await ctx.api("POST", `/v1/registry/versions/${args[1]}/${sub}`),
      `${sub}d registry version ${args[1]}`,
    );
  }
  throw usage("facility registry list|get|create|version|publish|deprecate");
}

async function sandboxes(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    return list(ctx, await ctx.api("GET", "/v1/sandbox-profiles", { query: pageQuery(flags) }), ["id", "name", "driver", "image", "project"], (row) => [
      row.id,
      row.name,
      row.driver,
      row.image,
      row.projectId,
    ]);
  }
  if (sub === "create") {
    const name = requiredStringFlag(flags.name, "--name");
    const driver = requiredStringFlag(flags.driver, "--driver");
    const image = requiredStringFlag(flags.image, "--image");
    const body = {
      name,
      driver,
      image,
      setup: flags.setup ? jsonObject(flags.setup, "--setup") : {},
      resources: flags.resources ? jsonObject(flags.resources, "--resources") : {},
      network: flags.network ? jsonObject(flags.network, "--network") : {},
    };
    return changed(ctx, await ctx.api("POST", "/v1/sandbox-profiles", { body }), `created sandbox ${name}`);
  }
  if (sub === "update") {
    if (!args[1]) throw usage("facility sandboxes update <id> [flags]");
    const body = compact({
      name: stringFlag(flags.name),
      driver: stringFlag(flags.driver),
      image: stringFlag(flags.image),
      setup: flags.setup ? jsonObject(flags.setup, "--setup") : undefined,
      resources: flags.resources ? jsonObject(flags.resources, "--resources") : undefined,
      network: flags.network ? jsonObject(flags.network, "--network") : undefined,
    });
    return changed(ctx, await ctx.api("PATCH", `/v1/sandbox-profiles/${args[1]}`, { body }), `updated sandbox ${args[1]}`);
  }
  if (sub === "delete") {
    if (!args[1]) throw usage("facility sandboxes delete <id> --yes");
    confirmed(flags, `Deleting sandbox ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/sandbox-profiles/${args[1]}`), `deleted sandbox ${args[1]}`);
  }
  throw usage("facility sandboxes list|create|update|delete");
}

async function tasks(args, ctx, flags) {
  const sub = args[0] || "list";
  if (["list", "create", "update", "delete"].includes(sub)) {
    const project = await ctx.resolveProject(args[1]);
    const base = `/v1/projects/${project.id}/tasks`;
    if (sub === "list") {
      return list(ctx, await ctx.api("GET", base, { query: pageQuery(flags) }), ["id", "status", "title", "KB entry"], (row) => [
        row.id,
        row.status,
        row.title,
        row.kbEntryId,
      ]);
    }
    if (sub === "create") {
      const title = requiredStringFlag(flags.title, "--title");
      return changed(
        ctx,
        await ctx.api("POST", base, {
          body: {
            title,
            bodyMd: contentFlag(flags, "body"),
            status: stringFlag(flags.status) ?? "draft",
            kbEntryId: stringFlag(flags.kb),
            wsjf: flags.wsjf ? jsonObject(flags.wsjf, "--wsjf") : {},
          },
        }),
        `created task ${title}`,
      );
    }
    if (!args[2]) throw usage(`facility tasks ${sub} <project> <taskId>`);
    if (sub === "delete") {
      confirmed(flags, `Deleting task ${args[2]}`);
      return changed(ctx, await ctx.api("DELETE", `${base}/${args[2]}`), `deleted task ${args[2]}`);
    }
    const body = compact({
      title: stringFlag(flags.title),
      bodyMd: optionalContentFlag(flags, "body"),
      status: stringFlag(flags.status),
      kbEntryId: stringFlag(flags.kb),
      wsjf: flags.wsjf ? jsonObject(flags.wsjf, "--wsjf") : undefined,
      gh: flags.gh ? jsonObject(flags.gh, "--gh") : undefined,
    });
    return changed(ctx, await ctx.api("PATCH", `${base}/${args[2]}`, { body }), `updated task ${args[2]}`);
  }
  if (sub === "transition") {
    if (!args[1]) throw usage("facility tasks transition <taskId> --status <status>");
    const status = requiredStringFlag(flags.status, "--status");
    return changed(ctx, await ctx.api("POST", `/v1/tasks/${args[1]}/transition`, { body: { status } }), `transitioned task ${args[1]}`);
  }
  if (sub === "propose") {
    if (!args[1]) throw usage("facility tasks propose <taskId>");
    return changed(ctx, await ctx.api("POST", `/v1/tasks/${args[1]}/propose`), `proposed task ${args[1]}`);
  }
  throw usage("facility tasks list|create|update|delete|transition|propose");
}

async function virtualKeys(args, ctx, flags) {
  const sub = args[0] || "list";
  const project = await ctx.resolveProject(args[1]);
  const base = `/v1/projects/${project.id}/virtual-keys`;
  if (sub === "list") {
    return list(ctx, await ctx.api("GET", base, { query: pageQuery(flags) }), ["id", "name", "last4", "expires", "revoked"], (row) => [
      row.id,
      row.name,
      row.last4,
      row.expiresAt,
      row.revokedAt ? "yes" : "no",
    ]);
  }
  if (sub === "issue") {
    const name = requiredStringFlag(flags.name, "--name");
    const result = await ctx.api("POST", base, {
      body: {
        name,
        allowedModels: flags.models ? stringList(flags.models, "--models") : undefined,
        expiresAt: stringFlag(flags.expires),
      },
    });
    return secretResult(ctx, result, `issued virtual key ${result.id}`);
  }
  if (sub === "revoke") {
    if (!args[2]) throw usage("facility virtual-keys revoke <project> <keyId> --yes");
    confirmed(flags, `Revoking virtual key ${args[2]}`);
    return changed(ctx, await ctx.api("DELETE", `${base}/${args[2]}`), `revoked virtual key ${args[2]}`);
  }
  throw usage("facility virtual-keys list|issue|revoke <project>");
}

async function kb(args, ctx, flags) {
  const area = args[0];
  if (area === "space") {
    const sub = args[1] || "get";
    const project = await ctx.resolveProject(args[2]);
    const path = `/v1/projects/${project.id}/kb/space`;
    if (sub === "get") return details(ctx, await ctx.api("GET", path));
    if (sub === "set") {
      const charterMd = optionalContentFlag(flags, "charter");
      const activeMd = optionalContentFlag(flags, "active");
      const config = flags.config ? jsonObject(flags.config, "--config") : undefined;
      if (charterMd === undefined && activeMd === undefined && config === undefined) {
        throw usage("facility kb space set <project> --charter|--charter-file|--active|--active-file|--config <value>");
      }
      const current = await ctx.api("GET", path);
      return changed(
        ctx,
        await ctx.api("PUT", path, {
          body: {
            charterMd: charterMd ?? current?.charterMd ?? "",
            activeMd: activeMd ?? current?.activeMd ?? "",
            config: config ?? current?.config ?? {},
          },
        }),
        `updated KB space for ${project.slug}`,
      );
    }
  }
  if (area === "entries") {
    const sub = args[1] || "list";
    if (sub === "get") {
      if (!args[2]) throw usage("facility kb entries get <entryId>");
      return details(ctx, await ctx.api("GET", `/v1/kb/entries/${args[2]}`));
    }
    const project = await ctx.resolveProject(args[2]);
    const base = `/v1/projects/${project.id}/kb/entries`;
    if (sub === "list") {
      return list(ctx, await ctx.api("GET", base, { query: { type: stringFlag(flags.type), ...pageQuery(flags) } }), ["id", "type", "number", "slug", "status"], (row) => [
        row.id,
        row.type,
        row.number,
        row.slug,
        row.status,
      ]);
    }
    if (sub === "create") {
      const type = requiredStringFlag(flags.type, "--type");
      const slug = requiredStringFlag(flags.slug, "--slug");
      return changed(
        ctx,
        await ctx.api("POST", base, {
          query: flags.dry ? { dry: 1 } : undefined,
          body: {
            type,
            slug,
            frontmatter: flags.frontmatter ? jsonObject(flags.frontmatter, "--frontmatter") : {},
            bodyMd: contentFlag(flags, "body"),
            status: stringFlag(flags.status),
            links: flags.links ? stringList(flags.links, "--links") : [],
          },
        }),
        `${flags.dry ? "validated" : "created"} KB entry ${slug}`,
      );
    }
    if (sub === "update") {
      if (!args[3]) throw usage("facility kb entries update <project> <entryId> [flags]");
      const body = compact({
        type: stringFlag(flags.type),
        number: numberFlag(flags.number, "--number"),
        slug: stringFlag(flags.slug),
        frontmatter: flags.frontmatter ? jsonObject(flags.frontmatter, "--frontmatter") : undefined,
        bodyMd: optionalContentFlag(flags, "body"),
        status: stringFlag(flags.status),
        supersedes: stringFlag(flags.supersedes),
      });
      return changed(ctx, await ctx.api("PATCH", `/v1/kb/entries/${args[3]}`, { body }), `updated KB entry ${args[3]}`);
    }
  }
  if (area === "validate") {
    const project = await ctx.resolveProject(args[1]);
    return verificationDetails(
      ctx,
      await ctx.api("POST", `/v1/projects/${project.id}/kb/validate`),
    );
  }
  throw usage("facility kb space get|set | entries list|get|create|update | validate");
}

async function analytics(args, ctx, flags) {
  const sub = args[0] || "overview";
  if (!["overview", "timeseries"].includes(sub)) {
    throw usage("facility analytics overview|timeseries [--project <id>] [--from <date>] [--to <date>] [--group-by <day|agent|model>]");
  }
  const path = sub === "overview" ? "/v1/analytics/overview" : "/v1/analytics";
  const groupBy = stringFlag(flags["group-by"]);
  if (groupBy && !["day", "agent", "model"].includes(groupBy)) {
    throw cliError("--group-by must be day, agent, or model", "invalid_flag");
  }
  if (sub === "overview" && groupBy) {
    throw cliError("--group-by is only available with `facility analytics timeseries`", "invalid_flag");
  }
  const result = await ctx.api("GET", path, {
    query: compact({
      projectId: stringFlag(flags.project),
      from: stringFlag(flags.from),
      to: stringFlag(flags.to),
      groupBy,
      ...pageQuery(flags),
    }),
  });
  if (ctx.json || !Array.isArray(result)) return details(ctx, result);
  return list(ctx, result, ["date", "project", "runs", "success", "cost"], (row) => [
    row.day ?? row.date ?? row.bucket,
    row.projectId,
    row.runsStarted,
    row.runsSucceeded,
    money(row.costCents),
  ]);
}

async function audit(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "verify") {
    return verificationDetails(ctx, await ctx.api("GET", "/v1/audit/verify"));
  }
  if (sub === "list" || sub === "tail") {
    const result = await ctx.api("GET", "/v1/audit", {
      query: compact({
        actor: stringFlag(flags.actor),
        action: stringFlag(flags.action),
        from: numberFlag(flags.from, "--from"),
        to: numberFlag(flags.to, "--to"),
        cursor: numberFlag(flags.cursor, "--cursor"),
        limit: numberFlag(flags.limit, "--limit"),
      }),
    });
    if (ctx.json) return details(ctx, result);
    return list(ctx, result.items ?? result, ["seq", "time", "actor", "action", "target"], (row) => [
      row.seq,
      row.createdAt,
      `${row.actor?.type ?? ""}:${row.actor?.id ?? ""}`,
      row.action,
      row.target?.id,
    ]);
  }
  throw usage("facility audit list|verify");
}

async function integrations(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await ctx.api("GET", "/v1/integrations", {
      query: compact({
        projectId: stringFlag(flags.project),
        kind: stringFlag(flags.kind),
        enabled: flags.enabled === undefined ? undefined : String(booleanFlag(flags.enabled)),
        ...pageQuery(flags),
      }),
    });
    return list(ctx, result, ["id", "kind", "name", "project", "enabled", "webhook URL"], (row) => [
      row.id,
      row.kind,
      row.name,
      row.projectId,
      row.enabled ? "yes" : "no",
      row.webhookUrl,
    ]);
  }
  if (sub === "get") {
    if (!args[1]) throw usage("facility integrations get <id>");
    return details(ctx, await ctx.api("GET", `/v1/integrations/${args[1]}`));
  }
  if (sub === "create") {
    const kind = requiredStringFlag(flags.kind, "--kind");
    const name = requiredStringFlag(flags.name, "--name");
    const result = await ctx.api("POST", "/v1/integrations", {
      body: {
        projectId: stringFlag(flags.project),
        kind,
        name,
        config: flags.config ? jsonObject(flags.config, "--config") : {},
        secret: stringFlag(flags.secret),
        enabled: booleanFlag(flags.enabled, true),
      },
    });
    return secretResult(ctx, result, `created integration ${result.id}`);
  }
  if (sub === "update") {
    if (!args[1]) throw usage("facility integrations update <id> [--name|--config|--enabled]");
    const body = compact({
      name: stringFlag(flags.name),
      config: flags.config ? jsonObject(flags.config, "--config") : undefined,
      enabled: flags.enabled === undefined ? undefined : booleanFlag(flags.enabled),
    });
    return changed(ctx, await ctx.api("PATCH", `/v1/integrations/${args[1]}`, { body }), `updated integration ${args[1]}`);
  }
  if (sub === "rotate-secret") {
    if (!args[1]) throw usage("facility integrations rotate-secret <id> [--secret]");
    return secretResult(
      ctx,
      await ctx.api("POST", `/v1/integrations/${args[1]}/rotate-secret`, { body: { secret: stringFlag(flags.secret) } }),
      `rotated secret for integration ${args[1]}`,
    );
  }
  if (sub === "deliveries") {
    if (!args[1]) throw usage("facility integrations deliveries <id>");
    return list(
      ctx,
      await ctx.api("GET", `/v1/integrations/${args[1]}/deliveries`, {
        query: compact({
          status: stringFlag(flags.status),
          ...pageQuery(flags),
        }),
      }),
      ["id", "event", "status", "attempts", "HTTP", "error"],
      (row) => [row.id, row.eventType, row.status, row.attempts, row.responseStatus, row.error],
    );
  }
  if (sub === "events") {
    if (!args[1]) throw usage("facility integrations events <id>");
    return list(
      ctx,
      await ctx.api("GET", `/v1/integrations/${args[1]}/events`, {
        query: pageQuery(flags),
      }),
      ["id", "received", "type", "verified", "processed", "error"],
      (row) => [
        row.id,
        row.receivedAt,
        row.eventType,
        row.verified ? "yes" : "no",
        row.processedAt,
        row.error,
      ],
    );
  }
  if (sub === "retry") {
    if (!args[1]) throw usage("facility integrations retry <deliveryId>");
    return changed(ctx, await ctx.api("POST", `/v1/webhook-deliveries/${args[1]}/retry`), `queued delivery ${args[1]} for retry`);
  }
  if (sub === "delete") {
    if (!args[1]) throw usage("facility integrations delete <id> --yes");
    confirmed(flags, `Disabling integration ${args[1]}`);
    return changed(ctx, await ctx.api("DELETE", `/v1/integrations/${args[1]}`), `disabled integration ${args[1]}`);
  }
  throw usage("facility integrations list|get|create|update|rotate-secret|events|deliveries|retry|delete");
}

async function spend(_args, ctx, flags) {
  const groupBy = stringFlag(flags["group-by"]);
  if (groupBy && !["day", "model", "agent", "task"].includes(groupBy)) {
    throw cliError("--group-by must be day, model, agent, or task", "invalid_flag");
  }
  const result = await ctx.api("GET", "/v1/spend", {
    query: compact({
      projectId: stringFlag(flags.project),
      from: stringFlag(flags.from),
      to: stringFlag(flags.to),
      groupBy,
      ...pageQuery(flags),
    }),
  });
  return list(ctx, result, ["bucket", "cost"], (row) => [
    row.bucket,
    money(row.costCents ?? row.cost_cents),
  ]);
}

async function proposals(args, ctx, flags) {
  const sub = args[0] || "get";
  if (sub === "get") {
    if (!args[1]) throw usage("facility proposals get <proposalId>");
    return details(ctx, await ctx.api("GET", `/v1/proposals/${args[1]}`));
  }
  if (sub === "create") {
    const actionTypeId = requiredStringFlag(flags.action, "--action");
    const contextMd = requiredStringFlag(flags.context, "--context");
    return changed(
      ctx,
      await ctx.api("POST", "/v1/proposals", {
        body: {
          projectId: stringFlag(flags.project),
          runId: stringFlag(flags.run),
          actionTypeId,
          payload: flags.payload ? jsonObject(flags.payload, "--payload") : {},
          contextMd,
          expiresAt: stringFlag(flags.expires),
        },
        idempotencyKey: stringFlag(flags["idempotency-key"]),
      }),
      "created proposal",
    );
  }
  if (sub === "execute") {
    if (!args[1]) throw usage("facility proposals execute <proposalId>");
    return changed(ctx, await ctx.api("POST", `/v1/proposals/${args[1]}/execute`), `executed proposal ${args[1]}`);
  }
  throw usage("facility proposals get|create|execute");
}

async function actionTypes(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    return list(
      ctx,
      await ctx.api("GET", "/v1/action-types", { query: pageQuery(flags) }),
      ["id", "name", "TTL", "payload schema"],
      (row) => [row.id, row.name, `${row.defaultTtlHours}h`, display(row.payloadSchema)],
    );
  }
  if (sub === "get") {
    if (!args[1]) throw usage("facility action-types get <actionTypeId>");
    return details(ctx, await ctx.api("GET", `/v1/action-types/${args[1]}`));
  }
  throw usage("facility action-types list|get");
}

async function projectHealth(args, ctx) {
  const project = await ctx.resolveProject(args[0]);
  return details(ctx, await ctx.api("GET", `/v1/projects/${project.id}/health`));
}

async function outcomes(_args, ctx, flags) {
  const result = await ctx.api("GET", "/v1/outcomes", {
    query: compact({
      projectId: stringFlag(flags.project),
      state: stringFlag(flags.state) ?? "open",
      limit: numberFlag(flags.limit, "--limit"),
    }),
  });
  return list(ctx, result, ["repository", "PR", "lane", "fate", "opened", "terminal", "session"], (row) => [
    row.repo,
    `#${row.prNumber}`,
    row.agentLane,
    row.fate ?? "open",
    row.openedAt,
    row.terminalAt,
    row.runId,
  ]);
}

async function catalog(_args, ctx) {
  const result = await ctx.api("GET", "/v1/catalog");
  if (ctx.json) ctx.writeJson(result);
  else {
    ctx.table(
      ["engine", "label", "note"],
      arrayValue(result.engines).map((row) => [row.id, row.label, row.note]),
    );
    ctx.table(
      ["model", "provider", "input / 1M", "output / 1M"],
      arrayValue(result.models).map((row) => [
        row.id,
        row.provider,
        `$${row.inputPer1M}`,
        `$${row.outputPer1M}`,
      ]),
    );
    ctx.table(
      ["trigger", "label", "note"],
      arrayValue(result.triggerTypes).map((row) => [row.type, row.label, row.note]),
    );
    ctx.table(
      ["permission"],
      arrayValue(result.permissions?.all).map((permission) => [permission]),
    );
  }
  return 0;
}

function list(ctx, value, headers, row) {
  if (ctx.json) ctx.writeJson(value);
  else ctx.table(headers, arrayValue(value).map(row));
  return 0;
}

function details(ctx, value) {
  if (ctx.json) ctx.writeJson(value);
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    ctx.table(["field", "value"], Object.entries(value).map(([key, item]) => [key, display(item)]));
  } else if (value === null || value === undefined) ctx.stdout.write("  No data.\n");
  else ctx.writeJson(value);
  return 0;
}

function verificationDetails(ctx, value) {
  details(ctx, value);
  return value?.ok === false ? 1 : 0;
}

function changed(ctx, value, message) {
  if (ctx.json) ctx.writeJson(value);
  else ctx.stdout.write(`  ${green("✓")} ${message}\n`);
  return 0;
}

function secretResult(ctx, value, message) {
  if (ctx.json) ctx.writeJson(value);
  else {
    ctx.stdout.write(`  ${green("✓")} ${message}\n`);
    if (value?.secret) {
      ctx.stdout.write(`  ${value.secret}\n`);
      ctx.stdout.write(
        `  ${yellow("!")} copy this secret now — it is shown once and cannot be retrieved later\n`,
      );
    }
  }
  return 0;
}

function contentFlag(flags, name) {
  const value = optionalContentFlag(flags, name);
  if (value === undefined) throw cliError(`--${name} or --${name}-file is required`, "invalid_flag");
  return value;
}

function optionalContentFlag(flags, name) {
  if (flags[name] !== undefined) return requiredStringFlag(flags[name], `--${name}`);
  const path = flags[`${name}-file`];
  return path === undefined
    ? undefined
    : readFileSync(requiredStringFlag(path, `--${name}-file`), "utf8");
}

function jsonObject(value, flag) {
  const parsed = parseJson(value, flag);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw cliError(`${flag} must be a JSON object`, "invalid_flag");
  return parsed;
}

function jsonArray(value, flag) {
  const parsed = parseJson(value, flag);
  if (!Array.isArray(parsed)) throw cliError(`${flag} must be a JSON array`, "invalid_flag");
  return parsed;
}

function parseJson(value, flag) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw cliError(`${flag} contains invalid JSON`, "invalid_flag");
  }
}

function stringList(value, flag) {
  const text = requiredStringFlag(value, flag);
  if (text.trim().startsWith("[")) {
    const parsed = jsonArray(value, flag);
    if (!parsed.every((item) => typeof item === "string")) throw cliError(`${flag} must contain only strings`, "invalid_flag");
    return parsed;
  }
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function agentTriggers(flags, fallback) {
  if (flags.triggers !== undefined) return jsonArray(flags.triggers, "--triggers");
  if (typeof flags.schedule === "string") {
    return [
      {
        type: "schedule",
        config: {
          cron: flags.schedule,
          timezone: stringFlag(flags.timezone) ?? "UTC",
        },
      },
    ];
  }
  if (flags.schedule !== undefined) throw cliError("--schedule requires a cron expression", "invalid_flag");
  return fallback;
}

function booleanFlag(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw cliError(`Expected true or false, received ${String(value)}`, "invalid_flag");
}

function numberFlag(value, flag = "Flag") {
  if (value === undefined) return undefined;
  if (value === true || value === "") {
    throw cliError(`${flag} requires a numeric value`, "invalid_flag");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw cliError(`${flag} must be a non-negative number; received ${String(value)}`, "invalid_flag");
  return number;
}

function integerArgument(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw cliError(`${name} must be a non-negative integer`, "invalid_argument");
  }
  return number;
}

function pageQuery(flags) {
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  const offset = numberFlag(flags.offset, "--offset");
  if (
    flags.limit === true ||
    flags.limit === "" ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
  ) {
    throw cliError("--limit must be an integer from 1 to 200", "invalid_flag");
  }
  if (offset !== undefined && !Number.isInteger(offset)) {
    throw cliError("--offset must be a non-negative integer", "invalid_flag");
  }
  return { limit, offset };
}

function stringFlag(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw cliError("Flag requires a value", "invalid_flag");
}

function requiredStringFlag(value, flag) {
  const parsed = stringFlag(value);
  if (parsed === undefined) throw cliError(`${flag} is required`, "invalid_flag");
  return parsed;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function display(value) {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function money(value) {
  return `$${(Number(value ?? 0) / 100).toFixed(2)}`;
}

function confirmed(flags, action) {
  if (!flags.yes) throw cliError(`${action} requires --yes`, "confirmation_required");
}

function usage(command) {
  return cliError(`Usage: ${command}`, "usage");
}

function cliError(message, code = "cli_error") {
  const error = new Error(message);
  error.code = code;
  error.exitCode = 1;
  return error;
}
