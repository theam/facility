import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Writable } from "node:stream";
import { loadConfig, saveConfig, getProfile } from "./platform-config.mjs";
import {
  ADMIN_GROUPS,
  runAdminCommand,
  validateAdminFlags,
  validateAdminSubcommandFlags,
} from "./platform-admin.mjs";
import { accent, bold, dim, green, yellow } from "./ui.mjs";

class CliError extends Error {
  constructor(message, exitCode = 1, options = {}) {
    super(message);
    this.exitCode = exitCode;
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export async function runPlatformCommand(command, args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const jsonMode = args.includes("--json") || args.some((arg) => arg.startsWith("--json="));
  try {
    const { flags, positional } = parseArgs(args);
    assertPresenceFlagSyntax(flags);
    const env = options.env || process.env;
    const configPath = options.configPath || env.FACILITY_CONFIG;
    const config = options.config || loadConfig(configPath);
    const ctx = {
      fetch: options.fetch || fetch,
      stdout,
      stderr,
      stdin: options.stdin || process.stdin,
      sleep: options.sleep || delay,
      env,
      timeoutMs: timeoutMilliseconds(flags.timeout),
      config,
      configPath,
      json: Boolean(flags.json),
      profileName: flags.profile,
    };

    assertCommandFlags(command, flags);
    assertCoreSubcommandFlags(command, positional, flags);
    if (flags.help) return platformHelp(command, stdout);
    if (command === "login") return await login(flags, ctx);
    if (command === "logout") return logout(flags, ctx);
    if (command === "profiles") return profiles(positional, flags, ctx);
    if (ADMIN_GROUPS.has(command)) {
      validateAdminFlags(command, flags);
      validateAdminSubcommandFlags(command, positional, flags);
    }
    const [group, ...rest] = [command, ...positional];
    const authed = clientContext(ctx);
    authed.api = (method, path, requestOptions = {}) =>
      api(
        authed,
        method,
        path,
        method === "POST" && flags["idempotency-key"] !== undefined
          ? {
              ...requestOptions,
              idempotencyKey:
                requestOptions.idempotencyKey ??
                flagString(flags["idempotency-key"], "--idempotency-key"),
            }
          : requestOptions,
      );
    authed.resolveProject = (value) => resolveProject(authed, value);
    authed.writeJson = (value) => writeJson(authed, value);
    authed.table = (headers, rows, tableOptions) => table(authed, headers, rows, tableOptions);

    if (ADMIN_GROUPS.has(group)) return await runAdminCommand(group, rest, authed, flags);

    switch (group) {
      case "status":
        return await status(authed, flags);
      case "projects":
        return await projects(rest, authed, flags);
      case "sessions":
      case "runs": // Compatibility alias; API/storage keep /runs and runs.* permissions.
        return await sessions(rest, authed, flags, group);
      case "inbox":
        return await inbox(rest, authed, flags);
      case "issues":
        return await issues(rest, authed, flags);
      case "kickstart":
        return await kickstart(rest, authed, flags, ctx);
      case "upgrade":
        return await upgrade(rest, authed, flags);
      case "keys":
        return await keys(rest, authed, flags);
      case "llm-requests":
        return await llmRequests(rest, authed, flags);
      default:
        throw new CliError(`Unknown platform command: ${group}`, 1);
    }
  } catch (error) {
    const exitCode = error.exitCode || (error.status === 401 ? 2 : 1);
    const message = error.message || "Facility command failed";
    if (jsonMode) {
      stdout.write(
        `${JSON.stringify({
          error: {
            code: error.code || (error.status === 401 ? "unauthorized" : "cli_error"),
            message,
            ...(error.status ? { status: error.status } : {}),
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        })}\n`,
      );
    } else {
      stderr.write(`${message}\n`);
      const details = humanErrorDetails(error.details);
      if (details) stderr.write(`${details}\n`);
    }
    return exitCode;
  }
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      flags[key] = rest.join("=");
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next && (!next.startsWith("-") || /^-\d/.test(next))) {
        flags[key] = next;
        index += 1;
      } else flags[key] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

async function login(flags, ctx) {
  let url = flagString(flags.url, "--url") || ctx.env.FACILITY_URL;
  let key = flagString(flags.key, "--key") || ctx.env.FACILITY_API_KEY;
  const profile = flagString(flags.profile, "--profile") || "default";
  if (!url || !key) {
    if (ctx.json) {
      throw new CliError(
        "facility login --json requires --url and --key (or FACILITY_URL and FACILITY_API_KEY).",
        1,
        { code: "credentials_required" },
      );
    }
    if (ctx.stdin?.isTTY) {
      if (!url) url = await prompt("API URL", ctx);
      if (!key) key = await promptSecret("API key", ctx);
    } else {
      const answers = await readPipedAnswers(ctx.stdin);
      if (!url) url = answers.shift();
      if (!key) key = answers.shift();
      if (!url || !key) throw promptEof();
    }
  }
  assertSafeApiUrl(url, Boolean(flags["allow-insecure"]));
  const me = await request({ url, key, fetch: ctx.fetch }, "GET", "/v1/me");
  const next = {
    ...ctx.config,
    currentProfile: profile,
    profiles: {
      ...(ctx.config.profiles || {}),
      [profile]: {
        url: stripSlash(url),
        key,
        ...(flags["allow-insecure"] ? { allowInsecure: true } : {}),
      },
    },
  };
  saveConfig(next, ctx.configPath || ctx.config.path);
  if (ctx.json) writeJson(ctx, { profile, org: me.org, principal: me.principal });
  else ctx.stdout.write(`  ${bold("login")} ${dim(profile)} verified for ${me.org?.slug || me.org?.name || "Facility"}\n`);
  return 0;
}

function logout(flags, ctx) {
  const profile = flags.profile || ctx.config.currentProfile || "default";
  if (!ctx.config.profiles?.[profile]) {
    throw new CliError(`Profile not found: ${profile}`, 1, { code: "profile_not_found" });
  }
  const remaining = { ...(ctx.config.profiles || {}) };
  delete remaining[profile];
  const nextProfile = Object.keys(remaining)[0] || "default";
  const next = {
    ...ctx.config,
    currentProfile: profile === ctx.config.currentProfile ? nextProfile : ctx.config.currentProfile,
    profiles: remaining,
  };
  saveConfig(next, ctx.configPath || ctx.config.path);
  output(ctx, { profile, loggedOut: true }, () => `  ${bold("logout")} ${dim(profile)} credentials removed\n`);
  return 0;
}

function profiles(args, flags, ctx) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const rows = Object.entries(ctx.config.profiles || {}).map(([name, value]) => ({
      name,
      current: name === ctx.config.currentProfile,
      url: value.url,
    }));
    if (ctx.json) writeJson(ctx, { currentProfile: ctx.config.currentProfile, profiles: rows });
    else table(ctx, ["", "profile", "url"], rows.map((row) => [row.current ? "●" : "", row.name, row.url]));
    return 0;
  }
  if (sub === "use") {
    const name = args[1];
    if (!name) throw usage("facility profiles use <name>");
    if (!ctx.config.profiles?.[name]) {
      throw new CliError(`Profile not found: ${name}`, 1, { code: "profile_not_found" });
    }
    saveConfig({ ...ctx.config, currentProfile: name }, ctx.configPath || ctx.config.path);
    output(ctx, { currentProfile: name }, () => `  ${bold("profile")} ${dim(name)} is now active\n`);
    return 0;
  }
  if (sub === "remove") return logout({ profile: args[1] || flags.profile }, ctx);
  throw usage("facility profiles list|use <name>|remove <name>");
}

async function status(ctx) {
  const projects = await api(ctx, "GET", "/v1/projects");
  const inbox = unwrapInbox(await api(ctx, "GET", "/v1/inbox", { query: { state: "open" } }));
  const issues = await api(ctx, "GET", "/v1/issues", { query: { state: "open" } });
  const spend = await api(ctx, "GET", "/v1/spend", { query: { from: monthStart(), groupBy: "day" } });
  const runs = await allRuns(ctx, "running");
  const payload = {
    projects,
    liveSessions: runs,
    liveSessionsPartial: false,
    // Deprecated JSON aliases for existing automation; human-facing terminology is Sessions.
    liveRuns: runs,
    liveRunsPartial: false,
    inbox,
    issues,
    spend,
  };
  if (ctx.json) writeJson(ctx, payload);
  else {
    ctx.stdout.write(`\n${bold("Facility status")}\n`);
    ctx.stdout.write(row("projects", asArray(projects).length));
    ctx.stdout.write(
      row(
        "live sessions",
        runs.length,
        runs.length > 0,
      ),
    );
    ctx.stdout.write(row("open inbox", asArray(inbox).length));
    ctx.stdout.write(row("open issues", asArray(issues).length));
    ctx.stdout.write(row("spend MTD", cents(sum(asArray(spend), "cost_cents"))));
  }
  return 0;
}

async function projects(args, ctx, flags) {
  const sub = args[0];
  if (sub === "list") {
    const projects = await api(ctx, "GET", "/v1/projects", { query: pageQuery(flags) });
    if (ctx.json) writeJson(ctx, projects);
    else table(ctx, ["slug", "name", "status"], asArray(projects).map((p) => [p.slug, p.name, p.status]));
    return 0;
  }
  if (sub === "get") {
    const project = await resolveProject(ctx, args[1]);
    if (ctx.json) writeJson(ctx, project);
    else table(ctx, ["field", "value"], Object.entries(project).map(([key, value]) => [key, displayValue(value)]));
    return 0;
  }
  if (sub === "create") {
    const name = requiredFlagString(flags.name, "--name");
    const slug = requiredFlagString(flags.slug, "--slug");
    const result = await api(ctx, "POST", "/v1/projects", {
      body: {
        name,
        slug,
        ...(flags.description !== undefined
          ? { description: flagString(flags.description, "--description") }
          : {}),
        ...(flags.settings !== undefined
          ? { settings: parseObject(flags.settings, "--settings") }
          : {}),
      },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${green("✓")} ${bold("created")} ${result.slug}\n`);
    return 0;
  }
  if (sub === "update") {
    const project = await resolveProject(ctx, args[1]);
    const body = defined({
      name: flagString(flags.name, "--name"),
      description: flagString(flags.description, "--description"),
      status: flagString(flags.status, "--status"),
      settings:
        flags.settings === undefined ? undefined : parseObject(flags.settings, "--settings"),
    });
    if (!Object.keys(body).length) throw usage("facility projects update <project> --name|--description|--status|--settings");
    const result = await api(ctx, "PATCH", `/v1/projects/${project.id}`, { body });
    output(ctx, result, () => `  ${green("✓")} ${bold("updated")} ${result.slug || project.slug}\n`);
    return 0;
  }
  if (sub === "archive" || sub === "delete") {
    const project = await resolveProject(ctx, args[1]);
    requireConfirmation(flags, `Archive project ${project.slug || project.id}`);
    const result = await api(ctx, "DELETE", `/v1/projects/${project.id}`);
    output(ctx, result, () => `  ${yellow("■")} ${bold("archived")} ${project.slug || project.id}\n`);
    return 0;
  }
  throw new CliError("Usage: facility projects list|get|create|update|archive");
}

async function sessions(args, ctx, flags, command = "sessions") {
  const sub = args[0];
  if (sub === "list") {
    const status = runStatus(flags.status);
    let runs;
    let selectedProject;
    const pagination = pageQuery(flags);
    const explicitPage = pagination.limit !== undefined || pagination.offset !== undefined;
    if (flags.project !== undefined) {
      const project = flagString(flags.project, "--project");
      selectedProject = await resolveProject(ctx, project);
      runs = explicitPage
        ? await api(ctx, "GET", `/v1/projects/${selectedProject.id}/runs`, {
            query: { status, ...pagination },
          })
        : await projectRuns(ctx, selectedProject.id, status);
    } else {
      runs = explicitPage
        ? await api(ctx, "GET", "/v1/runs", { query: { status, ...pagination } })
        : await allRuns(ctx, status);
    }
    if (ctx.json) {
      writeJson(
        ctx,
        flags.project
          ? runs
          : { sessions: runs, runs }, // `runs` is a deprecated JSON alias.
      );
    }
    else {
      table(
        ctx,
        ["id", "project", "status", "mode"],
        asArray(runs).map((r) => [
          r.id,
          r.project?.slug ?? selectedProject?.slug ?? r.projectId,
          r.status,
          r.mode,
        ]),
      );
    }
    return 0;
  }
  if (sub === "get") {
    const runId = args[1];
    if (!runId) throw usage(`facility ${command} get <id>`);
    const result = await api(ctx, "GET", `/v1/runs/${runId}`);
    if (ctx.json) writeJson(ctx, result);
    else {
      table(
        ctx,
        ["field", "value"],
        Object.entries(result).map(([key, value]) => [key, displayValue(value)]),
      );
    }
    return 0;
  }
  if (sub === "events") {
    const runId = args[1];
    if (!runId) throw usage(`facility ${command} events <id> [--after-seq <n>] [--tail <n>]`);
    const result = await api(ctx, "GET", `/v1/runs/${runId}/events`, {
      query: {
        afterSeq: numericFlag(flags["after-seq"], "--after-seq"),
        tail: numericFlag(flags.tail, "--tail"),
        limit: pageQuery(flags).limit,
      },
    });
    if (ctx.json) writeJson(ctx, result);
    else {
      table(
        ctx,
        ["seq", "time", "type", "data"],
        asArray(result).map((event) => [
          event.seq,
          event.ts,
          event.type,
          displayValue(event.data),
        ]),
      );
    }
    return 0;
  }
  if (sub === "transcript") {
    const runId = args[1];
    if (!runId) throw usage("facility sessions transcript <id>");
    const transcript = await api(ctx, "GET", `/v1/runs/${runId}/transcript`, {
      responseType: "text",
    });
    if (ctx.json) {
      writeJson(ctx, {
        sessionId: runId,
        events: String(transcript)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return line;
            }
          }),
      });
    } else {
      ctx.stdout.write(String(transcript));
      if (transcript && !String(transcript).endsWith("\n")) ctx.stdout.write("\n");
    }
    return 0;
  }
  if (sub === "trigger") {
    const project = await resolveProject(ctx, args[1]);
    const agent = args[2];
    if (!agent) throw new CliError("Usage: facility sessions trigger <project> <agent> [--input]");
    const input = parseInput(flags.input);
    const result = await api(ctx, "POST", `/v1/projects/${project.id}/runs`, {
      body: { mode: agent, agent, trigger: { source: "cli", agentName: agent, input } },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${accent("run")} ${result.id || "(queued)"} triggered\n`);
    return 0;
  }
  if (sub === "steer") {
    const runId = args[1];
    const message = args.slice(2).join(" ");
    if (!runId || !message) throw new CliError("Usage: facility sessions steer <id> <message>");
    const result = await api(ctx, "POST", `/v1/runs/${runId}/steer`, {
      body: { body: message },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${accent("steer")} ${runId}\n`);
    return 0;
  }
  if (sub === "cancel") {
    const runId = args[1];
    if (!runId) throw usage(`facility ${command} cancel <id>`);
    const result = await api(ctx, "POST", `/v1/runs/${runId}/cancel`, {
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () =>
      result?.status === "canceled"
        ? `  ${yellow("■")} ${bold("canceled")} ${runId}\n`
        : `  ${dim("—")} ${bold("unchanged")} ${runId}${result?.status ? dim(` · already ${result.status}`) : ""}\n`,
    );
    return 0;
  }
  if (sub === "interrupt") {
    const runId = args[1];
    if (!runId) throw usage("facility sessions interrupt <id>");
    const result = await api(ctx, "POST", `/v1/runs/${runId}/interrupt`, {
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${yellow("■")} ${bold("interrupted")} ${runId}\n`);
    return 0;
  }
  if (sub === "resume") {
    const runId = args[1];
    if (!runId) throw usage("facility sessions resume <id> [message]");
    const message = args.slice(2).join(" ") || undefined;
    const result = await api(ctx, "POST", `/v1/runs/${runId}/resume`, {
      body: { message },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${accent("resume")} ${result.id} from ${runId}\n`);
    return 0;
  }
  if (sub === "watch") return watchRun(ctx, args[1]);
  throw new CliError(
    "Usage: facility sessions list|get|events|transcript|watch|trigger|steer|interrupt|resume|cancel",
  );
}

async function inbox(args, ctx, flags) {
  if (!args.length) {
    const raw = await api(ctx, "GET", "/v1/inbox", {
      query: { state: flags.state || "open", ...pageQuery(flags) },
    });
    const proposals = unwrapInbox(raw);
    const issues = Array.isArray(raw) ? [] : asArray(raw?.issues);
    if (ctx.json) {
      writeJson(ctx, { proposals, issues });
      return 0;
    }
    ctx.stdout.write(`  ${bold("gates")}${dim(` · ${asArray(proposals).length}`)}\n`);
    table(ctx, ["id", "state", "action", "project"], asArray(proposals).map((item) => [item.id, item.state, item.actionTypeId, item.projectId]));
    if (issues.length) {
      ctx.stdout.write(`\n  ${bold("issues")}${dim(` · ${issues.length} from watchtower`)}\n`);
      table(ctx, ["id", "severity", "kind", "state", "title"], issues.map((item) => [item.id, item.severity, item.kind, item.state, item.title]));
    }
    return 0;
  }
  if (args[0] === "decide") {
    const [id, decision] = [args[1], args[2]];
    if (!id || !["approve", "reject"].includes(decision)) throw new CliError("Usage: facility inbox decide <id> approve|reject [--note]");
    const result = await api(ctx, "POST", `/v1/proposals/${id}/decide`, {
      body: { decision, note: flags.note },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${bold(decision)} ${id}\n`);
    return 0;
  }
  throw new CliError("Usage: facility inbox [decide <id> approve|reject]");
}

async function issues(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const result = await api(ctx, "GET", "/v1/issues", {
      query: { state: flags.state, kind: flags.kind, ...pageQuery(flags) },
    });
    if (ctx.json) writeJson(ctx, result);
    else table(ctx, ["id", "severity", "kind", "state", "title"], asArray(result).map((i) => [i.id, i.severity, i.kind, i.state, i.title]));
    return 0;
  }
  if (sub === "ack" || sub === "resolve") {
    const id = args[1];
    if (!id) throw new CliError(`Usage: facility issues ${sub} <id>`);
    const result = await api(ctx, "POST", `/v1/issues/${id}/${sub}`, {
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    output(ctx, result, () => `  ${bold(sub === "ack" ? "acknowledged" : "resolved")} ${id}\n`);
    return 0;
  }
  throw new CliError("Usage: facility issues list|ack <id>|resolve <id>");
}

async function kickstart(args, ctx, flags, rawCtx) {
  assertAllowedFlags(flags, [
    "repo",
    "yes",
    "json",
    "profile",
    "timeout",
    "branch",
    "provision",
    "checks",
    "modules",
    "model",
    "org",
    "board",
    "execution-lane",
    "preview-image",
    "preview-command",
    "preview-port",
    "preview-readiness-path",
    "preview-ttl-hours",
    "idempotency-key",
  ]);
  const project = await resolveProject(ctx, args[0]);
  const repo = requiredFlagString(flags.repo, "--repo");
  const repoId = await resolveRepoId(ctx, project.id, repo);
  const preview = await api(ctx, "GET", `/v1/projects/${project.id}/kickstart/preview`, { query: { repoId } });
  if (ctx.json && !flags.yes) {
    throw new CliError("facility kickstart --json requires --yes to confirm the write", 1, {
      code: "confirmation_required",
    });
  }
  if (!flags.yes && !ctx.json) {
    table(ctx, ["path", "size", "sha256"], asArray(preview.files || preview).map((file) => [file.path, file.size, file.sha256]));
    const answer = await prompt("Open kickstart PR? [y/N]", rawCtx);
    if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("Cancelled", 1);
  }
  const answers = {
    ...(flags.branch !== undefined
      ? { defaultBranch: flagString(flags.branch, "--branch") }
      : {}),
    ...(flags.provision !== undefined
      ? { provisionCmd: flagString(flags.provision, "--provision") }
      : {}),
    ...(flags.checks !== undefined ? { checkCmds: parseList(flags.checks, "--checks") } : {}),
    ...(flags.modules !== undefined ? { modules: parseList(flags.modules, "--modules") } : {}),
    ...(flags.model !== undefined ? { modelTier: flagString(flags.model, "--model") } : {}),
    ...(flags.org !== undefined && flags.board !== undefined
      ? {
          board: {
            org: flagString(flags.org, "--org"),
            project: flagString(flags.board, "--board"),
          },
        }
      : {}),
    ...(flags["execution-lane"]
      ? { execution_lane: parseObject(flags["execution-lane"], "--execution-lane") }
      : {}),
    ...(flags["preview-image"]
      ? {
          preview: {
            enabled: true,
            image: flagString(flags["preview-image"], "--preview-image"),
            ...(flags["preview-command"]
              ? {
                  command: [
                    "sh",
                    "-lc",
                    flagString(flags["preview-command"], "--preview-command"),
                  ],
                }
              : {}),
            port: Number(flagString(flags["preview-port"] ?? "3000", "--preview-port")),
            ...(flags["preview-readiness-path"]
              ? {
                  readinessPath: flagString(
                    flags["preview-readiness-path"],
                    "--preview-readiness-path",
                  ),
                }
              : {}),
            ttlHours: Number(
              flagString(flags["preview-ttl-hours"] ?? "24", "--preview-ttl-hours"),
            ),
          },
        }
      : {}),
  };
  const result = await api(ctx, "POST", `/v1/projects/${project.id}/kickstart`, {
    body: { repoId, answers, mode: "pr" },
    idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
  });
  output(ctx, result, () => `  ${bold("kickstart")} PR requested for ${repo}\n`);
  return 0;
}

async function upgrade(args, ctx, flags) {
  const project = await resolveProject(ctx, args[0]);
  const repo = requiredFlagString(flags.repo, "--repo");
  const repoId = await resolveRepoId(ctx, project.id, repo);
  const result = await api(ctx, "POST", `/v1/projects/${project.id}/upgrade`, {
    body: { repoId, toVersion: flagString(flags.to, "--to") },
    idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
  });
  output(ctx, result, () => `  ${bold("upgrade")} requested for ${project.slug || project.id}\n`);
  return 0;
}

async function keys(args, ctx, flags) {
  const sub = args[0];
  if (sub === "list") {
    const result = await api(ctx, "GET", "/v1/keys", { query: pageQuery(flags) });
    if (ctx.json) writeJson(ctx, result);
    else table(ctx, ["id", "name", "last4", "revoked"], asArray(result).map((key) => [key.id, key.name, key.last4, key.revokedAt ? "yes" : "no"]));
    return 0;
  }
  if (sub === "revoke") {
    const id = args[1];
    if (!id) throw new CliError("Usage: facility keys revoke <id> --yes");
    requireConfirmation(flags, `Revoke API key ${id}`);
    const result = await api(ctx, "DELETE", `/v1/keys/${id}`);
    output(ctx, result, () => `  ${bold("revoked")} ${id}\n`);
    return 0;
  }
  if (sub === "issue") {
    const name = flagString(flags.name, "--name") || args[1] || "facility-cli";
    const roleId = flagString(flags.role, "--role") || flagString(flags.roleId, "--roleId");
    if (!roleId) throw new CliError("facility keys issue requires --role <roleId>");
    const result = await api(ctx, "POST", "/v1/keys", {
      body: { name, roleId, projectId: flagString(flags.project, "--project") },
      idempotencyKey: flagString(flags["idempotency-key"], "--idempotency-key"),
    });
    // The plaintext secret is returned exactly once; surface it prominently in
    // human output (JSON mode already includes it) or it is lost for good.
    output(ctx, result, () => {
      const lines = [`  ${bold("issued")} ${result.id} ${dim(`· ${result.name} · last4 ${result.last4}`)}`];
      if (result.secret) {
        lines.push(
          `  ${green(result.secret)}`,
          `  ${yellow("!")} ${dim("copy this secret now — it is shown once and cannot be retrieved later")}`,
        );
      }
      return `${lines.join("\n")}\n`;
    });
    return 0;
  }
  throw new CliError("Usage: facility keys issue|revoke|list");
}

async function llmRequests(args, ctx, flags) {
  const sub = args[0] || "list";
  if (sub === "get" || sub === "envelope" || sub === "export") {
    const requestId = args[1];
    if (!requestId) throw new CliError("Usage: facility llm-requests get <id> [--json]");
    const result = await api(ctx, "GET", `/v1/llm-requests/${requestId}/envelope`);
    if (ctx.json) writeJson(ctx, result);
    else writeJson(ctx, result.envelope ?? result);
    return 0;
  }
  if (sub !== "list") {
    throw new CliError(
      "Usage: facility llm-requests list [--project <id>] [--limit <n>] | get <id>",
    );
  }
  const result = await api(ctx, "GET", "/v1/llm-requests", {
    query: {
      projectId: flags.project,
      from: flags.from,
      to: flags.to,
      limit: flags.limit,
      cursor: flags.cursor,
    },
  });
  const rows = asArray(result?.items ?? result);
  if (ctx.json) writeJson(ctx, result);
  else {
    table(
      ctx,
      ["id", "project", "model", "status", "cost", "latency"],
      rows.map((row) => [
        row.id,
        row.projectId,
        row.model,
        row.status,
        row.costCents ?? row.cost_cents,
        row.latencyMs ?? row.latency_ms,
      ]),
    );
    if (result?.nextCursor) ctx.stdout.write(`  ${dim(`next cursor: ${result.nextCursor}`)}\n`);
  }
  return 0;
}

function clientContext(ctx) {
  const envUrl = ctx.env.FACILITY_URL;
  const envKey = ctx.env.FACILITY_API_KEY;
  if (envUrl || envKey) {
    if (!envUrl || !envKey) {
      throw new CliError("FACILITY_URL and FACILITY_API_KEY must be set together.", 2, {
        code: "incomplete_environment_auth",
      });
    }
    assertSafeApiUrl(envUrl, ctx.env.FACILITY_ALLOW_INSECURE === "1");
    return { ...ctx, profileName: "environment", url: stripSlash(envUrl), key: envKey };
  }
  const { name, value } = getProfile(ctx.config, ctx.profileName);
  if (!value?.url || !value?.key) throw new CliError(`Not logged in for profile "${name}". Run facility login.`, 2);
  assertSafeApiUrl(value.url, value.allowInsecure === true);
  return { ...ctx, profileName: name, url: value.url, key: value.key };
}

function assertSafeApiUrl(value, allowInsecure) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("API URL must be a valid absolute URL.", 1, { code: "invalid_api_url" });
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local && !allowInsecure) {
    throw new CliError(
      "Refusing to send an API key over plain HTTP. Use HTTPS or explicitly allow insecure transport for a trusted development endpoint.",
      1,
      { code: "insecure_api_url" },
    );
  }
}

async function api(ctx, method, path, options = {}) {
  return request(ctx, method, path, options);
}

async function request(ctx, method, path, options = {}) {
  if (
    options.idempotencyKey !== undefined &&
    (String(options.idempotencyKey).length < 8 || String(options.idempotencyKey).length > 200)
  ) {
    throw new CliError("--idempotency-key must contain between 8 and 200 characters", 1, {
      code: "invalid_idempotency_key",
    });
  }
  const url = new URL(`${stripSlash(ctx.url)}${path}`);
  for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const replaySafe = method === "GET" || Boolean(options.idempotencyKey);
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await ctx.fetch(url, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          authorization: `Bearer ${ctx.key}`,
          ...(options.idempotencyKey
            ? { "idempotency-key": String(options.idempotencyKey) }
            : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(ctx.timeoutMs || 30_000),
      });
    } catch (error) {
      if (replaySafe && attempt < 2) {
        await ctx.sleep(250 * 2 ** attempt);
        continue;
      }
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new CliError(
        timeout
          ? `Facility API request timed out after ${ctx.timeoutMs || 30_000}ms`
          : `Could not reach Facility API at ${url.origin}`,
        1,
        { code: timeout ? "request_timeout" : "network_error" },
      );
    }
    if (
      replaySafe &&
      attempt < 2 &&
      [429, 502, 503, 504].includes(response.status)
    ) {
      await ctx.sleep(retryDelay(response, attempt));
      continue;
    }
    break;
  }
  if (!response) throw new CliError("Facility API request failed", 1, { code: "network_error" });
  const text = await response.text();
  if (response.ok && options.responseType === "text") return text;
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) {
      throw new CliError("Facility API returned an invalid JSON response", 1, {
        code: "invalid_response",
        status: response.status,
      });
    }
  }
  if (!response.ok) {
    throw new CliError(
      payload?.error?.message || `Facility API returned ${response.status}`,
      response.status === 401 ? 2 : 1,
      {
        code: payload?.error?.code || `http_${response.status}`,
        status: response.status,
        details: payload?.error?.details,
      },
    );
  }
  return payload;
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 10_000);
  return 250 * 2 ** attempt;
}

async function resolveProject(ctx, slugOrId) {
  if (!slugOrId) throw new CliError("Project is required.");
  if (slugOrId.startsWith("proj_")) return api(ctx, "GET", `/v1/projects/${slugOrId}`);
  const projects = await offsetPages((offset) =>
    api(ctx, "GET", "/v1/projects", { query: { limit: 200, offset } }),
  );
  const found = asArray(projects).find((project) => project.slug === slugOrId || project.id === slugOrId);
  if (!found) throw new CliError(`Project not found: ${slugOrId}`);
  return found;
}

async function allRuns(ctx, status) {
  return offsetPages((offset) =>
    api(ctx, "GET", "/v1/runs", { query: { status, limit: 200, offset } }),
  );
}

async function projectRuns(ctx, projectId, status) {
  return offsetPages((offset) =>
    api(ctx, "GET", `/v1/projects/${projectId}/runs`, {
      query: { status, limit: 200, offset },
    }),
  );
}

async function offsetPages(load) {
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const page = asArray(await load(offset));
    rows.push(...page);
    if (page.length < 200) return rows;
  }
}

async function watchRun(ctx, runId) {
  if (!runId) throw new CliError("Usage: facility sessions watch <id>");
  let afterSeq = 0;
  let retryMs = 250;
  for (;;) {
    const url = new URL(`${stripSlash(ctx.url)}/v1/runs/${runId}/stream`);
    if (afterSeq) url.searchParams.set("afterSeq", String(afterSeq));
    let response;
    try {
      response = await ctx.fetch(url, {
        headers: {
          authorization: `Bearer ${ctx.key}`,
          ...(afterSeq ? { "last-event-id": String(afterSeq) } : {}),
        },
      });
    } catch {
      await ctx.sleep(retryMs);
      retryMs = Math.min(retryMs * 2, 5_000);
      continue;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new CliError(
        payload?.error?.message || `Facility API returned ${response.status}`,
        response.status === 401 ? 2 : 1,
      );
    }
    if (!response.body) throw new CliError("Facility stream returned no body");
    retryMs = 250;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replaceAll("\r\n", "\n");
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const parsed = parseSseChunk(chunk);
        if (!parsed || parsed.event === "heartbeat") continue;
        const seq = eventSequence(parsed);
        if (seq > afterSeq) afterSeq = seq;
        renderRunEvent(ctx, parsed.data);
        if (parsed.data?.type === "result") {
          await reader.cancel();
          return parsed.data?.data?.status === "succeeded" ? 0 : 1;
        }
      }
    }
    await ctx.sleep(retryMs);
    retryMs = Math.min(retryMs * 2, 5_000);
  }
}

function parseSseChunk(chunk) {
  let event = "message";
  let id;
  const dataLines = [];
  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value || "message";
    else if (field === "id") id = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return undefined;
  const text = dataLines.join("\n");
  try {
    return { event, id, data: JSON.parse(text) };
  } catch {
    return { event, id, data: { type: event, text } };
  }
}

function eventSequence(event) {
  if (event.id && /^\d+$/.test(event.id)) return Number(event.id);
  return Number.isSafeInteger(event.data?.seq) ? event.data.seq : 0;
}

function renderRunEvent(ctx, event) {
  if (ctx.json) {
    writeJson(ctx, event);
    return;
  }
  const type = event?.type || "event";
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  if (type === "assistant") {
    ctx.stdout.write(`  ${accent("assistant")} ${data.text || ""}\n`);
  } else if (type === "tool") {
    ctx.stdout.write(`  ${dim("tool")} ${data.name || data.tool || compactJson(data)}\n`);
  } else if (type === "check") {
    const passed = data.ok === true || data.code === 0 || data.status === "passed";
    ctx.stdout.write(`  ${passed ? green("✓") : yellow("!")} ${data.command || data.name || "check"}\n`);
  } else if (type === "result") {
    const succeeded = data.status === "succeeded";
    ctx.stdout.write(`  ${succeeded ? green("✓") : yellow("!")} ${bold(data.status || "finished")}${data.error ? ` · ${data.error}` : ""}\n`);
  } else if (type === "steer") {
    ctx.stdout.write(`  ${bold("steer")} ${data.text || compactJson(data)}\n`);
  } else {
    ctx.stdout.write(`  ${dim(type)} ${compactJson(data)}\n`);
  }
}

function compactJson(value) {
  return Object.keys(value || {}).length ? JSON.stringify(value) : "";
}

function humanErrorDetails(details) {
  if (details === undefined || details === null) return "";
  const issues = Array.isArray(details)
    ? details
    : Array.isArray(details.errors)
      ? [...details.errors, ...(Array.isArray(details.warnings) ? details.warnings : [])]
      : [];
  if (issues.length) {
    return issues
      .slice(0, 20)
      .map((issue) => {
        if (typeof issue === "string") return `  - ${issue}`;
        const code = issue?.code ? `${issue.code}: ` : "";
        return `  - ${code}${issue?.message || JSON.stringify(issue)}`;
      })
      .join("\n");
  }
  if (typeof details === "string") return details ? `  ${details}` : "";
  if (details && typeof details === "object") {
    return Object.entries(details)
      .map(([key, value]) => {
        const rendered = Array.isArray(value)
          ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ")
          : typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value);
        return `  - ${key}: ${rendered}`;
      })
      .join("\n");
  }
  return "";
}

async function prompt(label, ctx) {
  const rl = createInterface({ input: ctx.stdin || processStdin, output: ctx.stdout === process.stdout ? processStdout : undefined });
  try {
    return await questionOrEof(rl, `${label}: `);
  } finally {
    rl.close();
  }
}

async function promptSecret(label, ctx) {
  const input = ctx.stdin || processStdin;
  if (!input.isTTY) return prompt(label, ctx);
  ctx.stdout.write(`${label}: `);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input, output: muted, terminal: true });
  try {
    return await questionOrEof(rl, "");
  } finally {
    rl.close();
    ctx.stdout.write("\n");
  }
}

async function readPipedAnswers(input) {
  let text = "";
  for await (const chunk of input) text += String(chunk);
  return text.replaceAll("\r\n", "\n").split("\n");
}

function promptEof() {
  return new CliError("Input ended before the prompt was answered.", 1, {
    code: "prompt_eof",
  });
}

function questionOrEof(rl, question) {
  return new Promise((resolve, reject) => {
    let settled = false;
    rl.once("close", () => {
      if (!settled) {
        settled = true;
        reject(promptEof());
      }
    });
    rl.question(question).then(
      (answer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      },
      (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

function output(ctx, payload, human) {
  if (ctx.json) writeJson(ctx, payload);
  else ctx.stdout.write(human());
}

function writeJson(ctx, payload) {
  ctx.stdout.write(`${JSON.stringify(payload)}\n`);
}

function table(ctx, headers, rows, options = {}) {
  const available = terminalWidth(ctx);
  const normalized = rows.map((values) => values.map((value) => normalizeCell(value)));
  const widths = fitColumnWidths(headers, normalized, available);
  if (!widths) return verticalTable(ctx, headers, normalized, options);
  const clipped = normalized.map((values) =>
    values.map((value, index) => truncateCell(value, widths[index])),
  );
  const header = headers
    .map((cell, index) => bold(truncateHeaderCell(cell, widths[index]).padEnd(widths[index])))
    .join("  ")
    .trimEnd();
  ctx.stdout.write(`\n  ${header}\n`);
  for (const rowValues of clipped) {
    const line = rowValues.map((value, index) => String(value ?? "").padEnd(widths[index])).join("  ");
    ctx.stdout.write(`  ${options.live ? accent(line.trimEnd()) : line.trimEnd()}\n`);
  }
  if (!rows.length) ctx.stdout.write(`  ${dim("No results.")}\n`);
}

function terminalWidth(ctx) {
  const configured = Number(ctx.env?.COLUMNS);
  const columns = Number.isFinite(configured) && configured > 0
    ? configured
    : Number(ctx.stdout?.columns || processStdout.columns || 120);
  return Math.max(32, columns - 4);
}

function fitColumnWidths(headers, rows, available) {
  const natural = headers.map((header, index) =>
    Math.min(
      96,
      Math.max(
        String(header).length,
        ...rows.map((rowValues) => String(rowValues[index] ?? "").length),
      ),
    ),
  );
  const minimum = headers.map((header) => Math.min(Math.max(String(header).length, 4), 16));
  const separators = Math.max(0, headers.length - 1) * 2;
  if (minimum.reduce((sum, width) => sum + width, separators) > available) return undefined;
  const widths = [...natural];
  while (widths.reduce((sum, width) => sum + width, separators) > available) {
    let candidate = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] > minimum[index] && (candidate === -1 || widths[index] > widths[candidate])) {
        candidate = index;
      }
    }
    if (candidate === -1) return undefined;
    widths[candidate] -= 1;
  }
  return widths;
}

function verticalTable(ctx, headers, rows, options) {
  ctx.stdout.write("\n");
  if (!rows.length) {
    ctx.stdout.write(`  ${dim("No results.")}\n`);
    return;
  }
  rows.forEach((values, rowIndex) => {
    if (rowIndex) ctx.stdout.write("\n");
    for (let index = 0; index < headers.length; index += 1) {
      const line = `${bold(`${headers[index]}:`)} ${values[index] ?? "—"}`;
      ctx.stdout.write(`  ${options.live ? accent(line) : line}\n`);
    }
  });
}

function normalizeCell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll(/\s+/g, " ").trim();
}

function truncateCell(value, max = 96) {
  const text = normalizeCell(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function truncateHeaderCell(value, max = 96) {
  const text = value === null || value === undefined ? "" : String(value).replaceAll(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function row(label, value, live = false) {
  const line = `  ${String(label).padEnd(12)} ${value}\n`;
  return live ? accent(line) : line;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// GET /v1/inbox returns { items, proposals, issues }; the CLI wants the proposals array.
function unwrapInbox(value) {
  if (Array.isArray(value)) return value;
  return value?.proposals ?? value?.items ?? [];
}

// The kickstart/upgrade APIs take a connected repo's id, not an owner/name slug.
async function resolveRepoId(ctx, projectId, ownerName) {
  const repos = asArray(await api(ctx, "GET", `/v1/projects/${projectId}/repos`));
  const match = repos.find(
    (r) => r.id === ownerName || `${r.owner}/${r.name}` === ownerName || r.fullName === ownerName,
  );
  if (!match) {
    throw new CliError(
      `Repo "${ownerName}" is not connected to this project. Connect it (GitHub App / web UI) first, then retry.`,
      1,
    );
  }
  return match.id;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

function cents(value) {
  return `$${(Number(value || 0) / 100).toFixed(2)}`;
}

function monthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function stripSlash(value) {
  return String(value).replace(/\/$/, "");
}

function parseInput(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function displayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function flagString(value, name = "Flag") {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new CliError(`${name} requires a value`, 1, { code: "invalid_flag" });
}

function requiredFlagString(value, name) {
  const parsed = flagString(value, name);
  if (parsed === undefined) throw new CliError(`${name} is required`, 1, { code: "invalid_flag" });
  return parsed;
}

function runStatus(value) {
  const status = flagString(value, "--status");
  if (
    status !== undefined &&
    !["queued", "provisioning", "running", "succeeded", "failed", "canceled"].includes(status)
  ) {
    throw new CliError(
      "--status must be queued, provisioning, running, succeeded, failed, or canceled",
      1,
      { code: "invalid_flag" },
    );
  }
  return status;
}

function numericFlag(value, name) {
  if (value === undefined) return undefined;
  if (value === true || value === "") {
    throw new CliError(`${name} requires a number`, 1, { code: "invalid_flag" });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new CliError(`${name} must be a non-negative number`, 1, { code: "invalid_flag" });
  }
  return number;
}

function pageQuery(flags) {
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  const offset = numericFlag(flags.offset, "--offset");
  if (
    flags.limit === true ||
    flags.limit === "" ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
  ) {
    throw new CliError("--limit must be an integer from 1 to 200", 1, {
      code: "invalid_flag",
    });
  }
  if (offset !== undefined && !Number.isInteger(offset)) {
    throw new CliError("--offset must be a non-negative integer", 1, {
      code: "invalid_flag",
    });
  }
  return { limit, offset };
}

function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function requireConfirmation(flags, action) {
  if (!flags.yes) {
    throw new CliError(`${action} requires --yes`, 1, { code: "confirmation_required" });
  }
}

function parseList(value, flag) {
  if (value === true || value === undefined) {
    throw new CliError(`${flag} requires a value`, 1, { code: "invalid_flag" });
  }
  if (Array.isArray(value)) return value.map(String);
  const text = String(value);
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // Fall through to the actionable flag error below.
    }
    throw new CliError(`${flag} must be a JSON string array or comma-separated list`, 1, {
      code: "invalid_flag",
    });
  }
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseObject(value, flag) {
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Use the shared structured flag error below.
  }
  throw new CliError(`${flag} must be a JSON object`, 1, { code: "invalid_flag" });
}

function assertAllowedFlags(flags, allowed) {
  const permitted = new Set(allowed);
  const unknown = Object.keys(flags).filter((flag) => !permitted.has(flag));
  if (unknown.length) {
    throw new CliError(`Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}`, 1, {
      code: "unknown_flag",
      details: { flags: unknown },
    });
  }
}

const PRESENCE_FLAGS = new Set(["json", "yes", "help", "allow-insecure"]);

function assertPresenceFlagSyntax(flags) {
  for (const name of PRESENCE_FLAGS) {
    if (name in flags && flags[name] !== true) {
      throw new CliError(`--${name} does not take a value`, 1, { code: "invalid_flag" });
    }
  }
}

function assertMissingFlagValues(flags, booleanFlags = []) {
  const booleans = new Set([...PRESENCE_FLAGS, ...booleanFlags]);
  for (const [name, value] of Object.entries(flags)) {
    if (value === true && !booleans.has(name)) {
      throw new CliError(`--${name} requires a value`, 1, { code: "invalid_flag" });
    }
  }
}

const COMMAND_FLAGS = {
  login: ["url", "key", "allow-insecure"],
  logout: [],
  profiles: [],
  status: [],
  projects: ["name", "slug", "description", "settings", "status", "idempotency-key", "yes", "limit", "offset"],
  sessions: ["project", "status", "input", "idempotency-key", "after-seq", "tail", "limit", "offset"],
  runs: ["project", "status", "input", "idempotency-key", "after-seq", "tail", "limit", "offset"],
  inbox: ["state", "note", "limit", "offset", "idempotency-key"],
  issues: ["state", "kind", "limit", "offset", "idempotency-key"],
  kickstart: [
    "repo",
    "branch",
    "provision",
    "checks",
    "modules",
    "model",
    "org",
    "board",
    "execution-lane",
    "idempotency-key",
    "yes",
  ],
  upgrade: ["repo", "to", "idempotency-key"],
  keys: ["name", "role", "roleId", "project", "yes", "limit", "offset", "idempotency-key"],
  "llm-requests": ["project", "from", "to", "limit", "cursor"],
};

const CORE_SUBCOMMAND_FLAGS = {
  projects: {
    list: ["limit", "offset"],
    get: [],
    create: ["name", "slug", "description", "settings", "idempotency-key"],
    update: ["name", "description", "status", "settings"],
    archive: ["yes"],
    delete: ["yes"],
  },
  runs: {
    list: ["project", "status", "limit", "offset"],
    get: [],
    events: ["after-seq", "tail", "limit"],
    transcript: [],
    watch: [],
    trigger: ["input", "idempotency-key"],
    steer: ["idempotency-key"],
    interrupt: ["idempotency-key"],
    resume: ["idempotency-key"],
    cancel: ["idempotency-key"],
  },
  sessions: {
    list: ["project", "status", "limit", "offset"],
    get: [],
    events: ["after-seq", "tail", "limit"],
    transcript: [],
    watch: [],
    trigger: ["input", "idempotency-key"],
    steer: ["idempotency-key"],
    interrupt: ["idempotency-key"],
    resume: ["idempotency-key"],
    cancel: ["idempotency-key"],
  },
  inbox: { __default: ["state", "limit", "offset"], decide: ["note", "idempotency-key"] },
  issues: { __default: ["state", "kind", "limit", "offset"], list: ["state", "kind", "limit", "offset"], ack: ["idempotency-key"], resolve: ["idempotency-key"] },
  keys: { list: ["limit", "offset"], issue: ["name", "role", "roleId", "project", "idempotency-key"], revoke: ["yes"] },
  "llm-requests": {
    __default: ["project", "from", "to", "limit", "cursor"],
    list: ["project", "from", "to", "limit", "cursor"],
    get: [],
    envelope: [],
    export: [],
  },
};

function assertCoreSubcommandFlags(command, positional, flags) {
  const spec = CORE_SUBCOMMAND_FLAGS[command];
  if (!spec || flags.help) return;
  const sub = positional[0] || "__default";
  const allowed = spec[sub];
  if (!allowed) throw usage(PLATFORM_USAGE[command]);
  assertAllowedFlags(flags, ["profile", "json", "timeout", ...allowed]);
}

function assertCommandFlags(command, flags) {
  if (!(command in COMMAND_FLAGS)) return;
  assertAllowedFlags(flags, [
    "profile",
    "json",
    "timeout",
    "help",
    ...COMMAND_FLAGS[command],
  ]);
  assertMissingFlagValues(flags);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutMilliseconds(value) {
  if (value === undefined) return 30_000;
  if (value === true || value === "") {
    throw new CliError("--timeout requires a number of seconds", 1, { code: "invalid_flag" });
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    throw new CliError("--timeout must be greater than 0 and at most 300 seconds", 1, {
      code: "invalid_flag",
    });
  }
  return Math.round(seconds * 1_000);
}

function usage(command) {
  return new CliError(`Usage: ${command}`, 1, { code: "usage" });
}

const PLATFORM_USAGE = {
  login: "facility login [--url <url>] [--key <key>] [--profile <name>] [--allow-insecure]",
  logout: "facility logout [--profile <name>]",
  profiles: "facility profiles list|use <name>|remove <name>",
  status: "facility status [--json]",
  projects: "facility projects list|get|create|update|archive",
  sessions: "facility sessions list|get|events|transcript|watch|trigger|steer|interrupt|resume|cancel",
  runs: "facility runs list|get|events|transcript|watch|trigger|steer|interrupt|resume|cancel",
  conversations: "facility conversations list|get|start|send",
  github: "facility github installations|repos|issues|issue|sync|trigger",
  inbox: "facility inbox [decide <id> approve|reject]",
  issues: "facility issues list|ack <id>|resolve <id>",
  kickstart: "facility kickstart <project> --repo <owner/name> [--yes]",
  upgrade: "facility upgrade <project> --repo <owner/name> [--to <version>]",
  keys: "facility keys list|issue|revoke",
  "llm-requests": "facility llm-requests list|get <id>",
  org: "facility org get|update",
  members: "facility members list|add|update|remove",
  roles: "facility roles list|create|update|delete",
  repos: "facility repos list|connect|create|disconnect|verify|adopt",
  agents: "facility agents list|status|create|update|delete <project>",
  providers: "facility providers list|create|delete",
  budgets: "facility budgets list|get|set|delete",
  registry: "facility registry list|get|create|version|publish|deprecate",
  sandboxes: "facility sandboxes list|create|update|delete",
  tasks: "facility tasks list|create|update|delete|transition|propose",
  "virtual-keys": "facility virtual-keys list|issue|revoke <project>",
  kb: "facility kb space get|set | entries list|get|create|update | validate",
  analytics: "facility analytics overview|timeseries [--project <id>] [--from <date>] [--to <date>]",
  audit: "facility audit list|verify",
  integrations: "facility integrations list|get|create|update|rotate-secret|events|deliveries|retry|delete",
  spend: "facility spend [--project <id>] [--from <date>] [--to <date>] [--group-by <day|model|agent|task>]",
  proposals: "facility proposals get|create|execute",
  "action-types": "facility action-types list|get",
  health: "facility health <project>",
  outcomes: "facility outcomes [--project <id>] [--state <open|terminal|all>]",
  catalog: "facility catalog",
};

const PLATFORM_FORMS = {
  login: ["login --url <url> --key <key> [--profile <name>] [--allow-insecure]"],
  logout: ["logout [--profile <name>]"],
  profiles: ["profiles list", "profiles use <name>", "profiles remove <name>"],
  status: ["status"],
  projects: [
    "projects list",
    "projects get <project>",
    "projects create --name <name> --slug <slug> [--description <text>] [--settings <json>] [--idempotency-key <key>]",
    "projects update <project> --name|--description|--status|--settings <value>",
    "projects archive <project> --yes",
  ],
  sessions: [
    "sessions list [--project <project>] [--status <status>]",
    "sessions get <session-id>",
    "sessions events <session-id> [--after-seq <n> | --tail <n>]",
    "sessions transcript <session-id>",
    "sessions watch <session-id> [--json]",
    "sessions trigger <project> <agent> [--input <json-or-text>] [--idempotency-key <key>]",
    "sessions steer <session-id> <message>",
    "sessions interrupt <session-id>",
    "sessions resume <session-id> [message]",
    "sessions cancel <session-id>",
  ],
  runs: [
    "runs list [--project <project>] [--status <status>]",
    "runs get <run-id>",
    "runs events <run-id> [--after-seq <n> | --tail <n>]",
    "runs transcript <run-id>",
    "runs watch <run-id> [--json]",
    "runs trigger <project> <agent> [--input <json-or-text>] [--idempotency-key <key>]",
    "runs steer <run-id> <message>",
    "runs interrupt <run-id>",
    "runs resume <run-id> [message]",
    "runs cancel <run-id>",
  ],
  conversations: [
    "conversations list <project>",
    "conversations get <conversation-id>",
    "conversations start <project> [--agent <agent-id>] [--title <title>]",
    "conversations send <conversation-id> <message>",
  ],
  github: [
    "github installations",
    "github repos <installation-id> [--query <text>]",
    "github issues <project> [--state <open|closed|all>] [--query <text>] [--cursor <cursor>]",
    "github issue <project> <number>",
    "github sync <project>",
    "github trigger <project> <number> --agent <name>",
  ],
  inbox: ["inbox [--state <state>]", "inbox decide <proposal-id> approve|reject [--note <text>]"],
  issues: ["issues list [--state <state>] [--kind <kind>]", "issues ack <issue-id>", "issues resolve <issue-id>"],
  kickstart: ["kickstart <project> --repo <owner/name> [configuration flags] [--yes]"],
  upgrade: ["upgrade <project> --repo <owner/name> [--to <version>]"],
  keys: ["keys list", "keys issue [name] --role <role-id> [--project <project-id>]", "keys revoke <key-id> --yes"],
  "llm-requests": ["llm-requests list [--project <id>] [--from <date>] [--to <date>] [--limit <n>] [--cursor <cursor>]", "llm-requests get <request-id>"],
  org: ["org get", "org update --name <name> | --settings <json>"],
  members: ["members list", "members add --email <email> --role <role-id>", "members update <user-id> --role <role-id>", "members remove <user-id> --yes"],
  roles: ["roles list", "roles create --name <name> --permissions <a,b> [--description <text>]", "roles update <role-id> --description|--permissions <value>", "roles delete <role-id> --yes"],
  repos: ["repos list <project>", "repos connect <project> --repo <owner/name> [--branch <name>]", "repos create <project> --repo <owner/name> [--private <true|false>] [--auto-init <true|false>]", "repos disconnect <project> <repo-id> --yes", "repos verify <repo-id>", "repos adopt <repo-id>"],
  agents: ["agents list <project>", "agents status <project>", "agents create <project> --name <name> --engine <engine> --contract <item-id> [configuration flags]", "agents update <project> <agent-id> [configuration flags]", "agents delete <project> <agent-id> --yes"],
  providers: ["providers list", "providers create --provider <provider> --name <name> --secret <secret> [--auth-mode <api_key|oauth>] [--base-url <url>]", "providers delete <provider-id> --yes"],
  budgets: ["budgets list", "budgets get <budget-id>", "budgets set [<budget-id>] --scope <scope> --period <period> --limit-cents <n> --mode <mode>", "budgets delete <budget-id> --yes"],
  registry: ["registry list [--kind <kind>] [--scope <scope>] [--project <id>]", "registry get <item-id>", "registry create --scope <scope> --kind <kind> --name <name> --content|--content-file <value>", "registry version <item-id> --content|--content-file <value> [--changelog <text>]", "registry publish <version-id>", "registry deprecate <version-id>"],
  sandboxes: ["sandboxes list", "sandboxes create --name <name> --driver <driver> --image <image> [configuration flags]", "sandboxes update <profile-id> [configuration flags]", "sandboxes delete <profile-id> --yes"],
  tasks: ["tasks list <project>", "tasks create <project> --title <title> --body|--body-file <value>", "tasks update <project> <task-id> [task flags]", "tasks delete <project> <task-id> --yes", "tasks transition <task-id> --status <status>", "tasks propose <task-id>"],
  "virtual-keys": ["virtual-keys list <project>", "virtual-keys issue <project> --name <name> [--models <a,b>] [--expires <timestamp>]", "virtual-keys revoke <project> <key-id> --yes"],
  kb: ["kb space get <project>", "kb space set <project> [--charter|--charter-file <value>] [--active|--active-file <value>]", "kb entries list <project> [--type <type>]", "kb entries get <entry-id>", "kb entries create <project> --type <type> --slug <slug> --body|--body-file <value> [--dry]", "kb entries update <project> <entry-id> [entry flags]", "kb validate <project>"],
  analytics: ["analytics overview [--project <id>] [--from <date>] [--to <date>]", "analytics timeseries [--project <id>] [--from <date>] [--to <date>] [--group-by <day|agent|model>]"],
  audit: ["audit list [--actor <id>] [--action <name>] [--from <seq>] [--to <seq>] [--cursor <seq>] [--limit <n>]", "audit verify"],
  integrations: ["integrations list [--project <id>] [--kind <kind>] [--enabled <true|false>]", "integrations get <integration-id>", "integrations create --kind <kind> --name <name> [--project <id>] [--config <json>]", "integrations update <integration-id> [--name <name>] [--config <json>] [--enabled <true|false>]", "integrations rotate-secret <integration-id> [--secret <secret>]", "integrations events <integration-id> [--limit <n>] [--offset <n>]", "integrations deliveries <integration-id> [--status <status>] [--limit <n>] [--offset <n>]", "integrations retry <delivery-id>", "integrations delete <integration-id> --yes"],
  spend: ["spend [--project <id>] [--from <date>] [--to <date>] [--group-by <day|model|agent|task>]"],
  proposals: ["proposals get <proposal-id>", "proposals create --action <action-type-id> --context <markdown> [--payload <json>] [--project <id>] [--run <id>] [--expires <timestamp>]", "proposals execute <proposal-id>"],
  "action-types": ["action-types list", "action-types get <action-type-id>"],
  health: ["health <project>"],
  outcomes: ["outcomes [--project <id>] [--state <open|terminal|all>] [--limit <n>]"],
  catalog: ["catalog"],
};

const PLATFORM_DESCRIPTIONS = {
  login: "Verify credentials and save a named Facility environment.",
  logout: "Remove credentials for a saved Facility environment.",
  profiles: "List, select, or remove saved Facility environments.",
  status: "See live runs, approval gates, issues, and month-to-date spend.",
  projects: "Create and govern Facility projects.",
  sessions: "Trigger, follow, steer, and cancel governed agent sessions.",
  runs: "Trigger, follow, steer, and cancel agent runs.",
  conversations: "Continue durable, resumable conversations with project agents.",
  github: "Discover GitHub App repositories and turn synchronized issues into sessions.",
  inbox: "Review human approval gates and record decisions.",
  issues: "Triage operational issues raised by Watchtower.",
  kickstart: "Preview managed files and open a governed kickstart pull request.",
  upgrade: "Open a governed Facility system upgrade pull request.",
  keys: "Issue and revoke control-plane API credentials.",
  "llm-requests": "Inspect metered model calls and full request envelopes.",
  org: "Inspect and update organization settings.",
  members: "Manage organization membership and role assignments.",
  roles: "Manage permission policy without the web application.",
  repos: "Connect existing GitHub repositories or create new ones.",
  agents: "Manage agent definitions, contracts, engines, and schedules.",
  providers: "Manage model-provider credentials.",
  budgets: "Create and enforce spend policy at org, project, or agent scope.",
  registry: "Version and publish contracts, harnesses, skills, guards, and policy.",
  sandboxes: "Manage isolated execution profiles.",
  tasks: "Manage the product-owner task queue and proposal flow.",
  "virtual-keys": "Issue project-scoped model credentials.",
  kb: "Manage, validate, and trace the project knowledge base.",
  analytics: "Query reliability, throughput, model, and cost trends.",
  audit: "Read and verify the tamper-evident audit chain.",
  integrations: "Manage signed inbound hooks and durable outbound webhooks.",
  spend: "Inspect attributed model spend.",
  proposals: "Create, inspect, and retry governed proposals.",
  "action-types": "Discover proposal payload contracts.",
  health: "Inspect project readiness and configuration gaps.",
  outcomes: "Inspect pull-request delivery outcomes and terminal fate.",
  catalog: "Discover the engines, models, permissions, and trigger types the platform supports.",
};

const PLATFORM_EXAMPLES = {
  login: "facility login --url https://facility.example --key fak_… --profile production",
  projects: "facility projects create --name Payments --slug payments --idempotency-key project-payments",
  sessions: "facility sessions watch run_01H… --json",
  runs: "facility runs watch run_01H… --json",
  conversations: "facility conversations send evt_01H… \"Continue with the failing integration tests\"",
  github: "facility github trigger payments 421 --agent builder",
  inbox: "facility inbox decide prop_01H… approve --note \"reviewed\"",
  kickstart: "facility kickstart payments --repo acme/payments --checks \"pnpm test,pnpm typecheck\"",
  agents: "facility agents create payments --name builder --engine codex --contract item_01H… --schedule \"0 9 * * 1-5\"",
  budgets: "facility budgets set --scope project --project proj_01H… --period monthly --limit-cents 50000 --mode hard",
  registry: "facility registry version item_01H… --content-file ./contract.md --changelog \"Tighten acceptance\"",
  integrations: "facility integrations create --kind webhook --name ops --config '{\"url\":\"https://hooks.example/facility\"}'",
  audit: "facility audit verify --json",
};

const PAGED_COMMANDS = new Set([
  "projects",
  "sessions",
  "runs",
  "inbox",
  "issues",
  "keys",
  "members",
  "roles",
  "repos",
  "agents",
  "providers",
  "budgets",
  "registry",
  "sandboxes",
  "tasks",
  "virtual-keys",
  "kb",
  "analytics",
  "integrations",
  "spend",
  "action-types",
]);
const IDEMPOTENT_WRITE_COMMANDS = new Set([
  "projects",
  "sessions",
  "runs",
  "inbox",
  "issues",
  "kickstart",
  "upgrade",
  "keys",
  "members",
  "roles",
  "repos",
  "agents",
  "providers",
  "budgets",
  "registry",
  "sandboxes",
  "tasks",
  "virtual-keys",
  "kb",
  "integrations",
  "proposals",
  "conversations",
  "github",
]);

function platformHelp(command, stdout) {
  const line = PLATFORM_USAGE[command];
  if (!line) {
    stdout.write(`Unknown Facility command: ${command}\n`);
    return 1;
  }
  stdout.write(`\n  ${bold(`facility ${command}`)}\n`);
  stdout.write(`  ${dim(PLATFORM_DESCRIPTIONS[command] ?? "Facility platform command.")}\n\n`);
  stdout.write(`  ${bold("Usage")}\n    ${line}\n`);
  const forms = PLATFORM_FORMS[command] ?? [];
  if (forms.length) {
    stdout.write(`\n  ${bold(forms.length === 1 ? "Command" : "Commands")}\n`);
    for (const form of forms) stdout.write(`    facility ${form}\n`);
  }
  if (PLATFORM_EXAMPLES[command]) {
    stdout.write(`\n  ${bold("Example")}\n    ${PLATFORM_EXAMPLES[command]}\n`);
  }
  stdout.write(`\n  ${bold("Global options")}\n`);
  stdout.write("    --profile <name>     use a saved environment\n");
  stdout.write("    --json               emit stable machine-readable JSON\n");
  stdout.write("    --timeout <seconds>  set the request deadline (max 300)\n");
  stdout.write("    --help               show this help\n");
  if (PAGED_COMMANDS.has(command)) {
    stdout.write(`\n  ${bold("List options")}\n`);
    stdout.write("    --limit <1-200>      maximum rows to return\n");
    stdout.write("    --offset <n>         rows to skip\n");
  }
  if (IDEMPOTENT_WRITE_COMMANDS.has(command)) {
    stdout.write(`\n  ${bold("Write option")}\n`);
    stdout.write("    --idempotency-key <key>  safely replay a POST (8-200 characters)\n");
  }
  stdout.write("\n");
  return 0;
}
