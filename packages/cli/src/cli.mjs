// facility CLI entry: init · add · doctor.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "./init.mjs";
import { addModule } from "./add.mjs";
import { doctor } from "./doctor.mjs";
import { bootstrapInstance } from "./instance.mjs";
import { runPlatformCommand } from "./platform.mjs";
import { banner, bold, dim, item } from "./ui.mjs";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (["--help", "--local", "--platform"].includes(arg)) flags[arg.slice(2)] = true;
    else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      flags[key] = rest.join("=");
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        index += 1;
      } else flags[key] = true;
    } else if (!arg.startsWith("-")) positional.push(arg);
  }
  return { flags, positional };
}

function help() {
  banner(version);
  helpGroup("Build your repo", [
    ["init", "install the Facility method"],
    ["add <module>", "add a quality module"],
    ["doctor", "verify local and platform readiness"],
  ]);
  helpGroup("Operate", [
    ["status", "runs, approvals, issues, and spend at a glance"],
    ["projects", "create, inspect, update, or archive projects"],
    ["repos", "connect or create GitHub repositories"],
    ["agents", "configure agent definitions and schedules"],
    ["sessions", "trigger, watch, steer, or cancel governed sessions"],
    ["conversations", "continue durable agent conversations"],
    ["github", "discover repositories and act on GitHub issues"],
    ["inbox", "review and decide proposals"],
    ["issues", "acknowledge and resolve platform issues"],
    ["kickstart", "preview and open a governed installation PR"],
    ["upgrade", "open a governed template upgrade PR"],
  ]);
  helpGroup("Knowledge & policy", [
    ["kb", "manage the project knowledge base"],
    ["tasks", "manage the product-owner task queue"],
    ["registry", "version contracts, harnesses, and policies"],
    ["proposals", "create, inspect, and execute approval gates"],
    ["action-types", "discover proposal payload contracts"],
    ["budgets", "enforce org, project, and agent budgets"],
    ["health", "inspect project readiness"],
    ["outcomes", "inspect pull-request delivery outcomes"],
    ["catalog", "discover engines, models, permissions, and triggers"],
  ]);
  helpGroup("Platform administration", [
    ["instance bootstrap", "bootstrap a dedicated Facility instance"],
    ["org", "organization settings"],
    ["members", "organization membership"],
    ["roles", "permission policy"],
    ["keys", "control-plane API credentials"],
    ["virtual-keys", "project-scoped model credentials"],
    ["providers", "model-provider credentials"],
    ["sandboxes", "execution profiles and isolation"],
    ["integrations", "inbound and outbound webhooks"],
    ["analytics", "run and reliability trends"],
    ["spend", "cost attribution"],
    ["audit", "tamper-evident change ledger"],
    ["llm-requests", "inspect metering and request envelopes"],
  ]);
  helpGroup("Account", [
    ["login", "verify and save an environment profile"],
    ["logout", "remove saved profile credentials"],
    ["profiles", "switch between Facility environments"],
  ]);
  console.log("");
  item(dim("init flags: --yes --force --dir=<path> --branch=<name> --provision=<cmd>"));
  item(dim('            --checks="cmd1, cmd2" --auth=<api-key|oauth|wif|bedrock|vertex>'));
  item(dim('            --build-model=<id> --review-model=<id> --plan-model=<id>'));
  item(dim('            --codex-build-model=<id> --codex-plan-model=<id> --org=<org> --project=<n>'));
  item(dim('            --preview-image=<image> --preview-command=<cmd> --preview-port=<n> --preview-readiness-path=</health> --preview-ttl-hours=<n>'));
  item(dim("            --canary-bot=<your-app>[bot]"));
  item(dim("Run facility <command> --help for precise usage."));
  item(dim("Global platform flags: --profile <name> --json --timeout <seconds>"));
  console.log("");
  item(dim("Docs: https://github.com/theam/facility"));
  console.log("");
}

function helpGroup(label, commands) {
  item(bold(label));
  const width = Math.max(...commands.map(([command]) => command.length));
  for (const [command, description] of commands) {
    item(`  ${bold(`facility ${command.padEnd(width)}`)}  ${dim(description)}`);
  }
  console.log("");
}

export async function main(argv) {
  const { command, rest } = extractInvocation(argv);
  const { flags, positional } = parseFlags(rest);
  const localFlagError = validateLocalFlags(command, flags);
  if (localFlagError) {
    if (flags.json) {
      console.log(JSON.stringify({ error: { code: "invalid_flag", message: localFlagError } }));
    } else console.error(localFlagError);
    return 1;
  }
  if (flags.dir) flags.dir = resolve(flags.dir);

  if (flags.help && ["init", "add", "doctor"].includes(command)) {
    localHelp(command);
    return 0;
  }

  switch (command) {
    case "init":
      return init(flags, pkgRoot, version);
    case "add": {
      if (!positional[0]) {
        help();
        return 1;
      }
      return addModule(positional[0], { dir: flags.dir || process.cwd(), pkgRoot });
    }
    case "doctor":
      return doctor(flags, version);
    case "instance":
      if (positional[0] === "bootstrap") return bootstrapInstance(flags);
      console.error("Usage: facility instance bootstrap [options]");
      return 1;
    case "login":
    case "logout":
    case "profiles":
    case "status":
    case "projects":
    case "sessions":
    case "runs":
    case "conversations":
    case "github":
    case "outcomes":
    case "catalog":
    case "inbox":
    case "issues":
    case "kickstart":
    case "upgrade":
    case "keys":
    case "llm-requests":
    case "org":
    case "members":
    case "roles":
    case "repos":
    case "agents":
    case "providers":
    case "budgets":
    case "registry":
    case "sandboxes":
    case "tasks":
    case "virtual-keys":
    case "kb":
    case "analytics":
    case "audit":
    case "integrations":
    case "spend":
    case "proposals":
    case "action-types":
    case "health":
      return runPlatformCommand(command, rest);
    case "--version":
    case "-v":
      console.log(version);
      return 0;
    default:
      if (command && !["help", "--help"].includes(command)) {
        console.error(`Unknown command: ${command}`);
      }
      help();
      return command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
}

function validateLocalFlags(command, flags) {
  const allowed = {
    init: new Set([
      "yes",
      "force",
      "dir",
      "branch",
      "provision",
      "checks",
      "project",
      "org",
      "modules",
      "auth",
      "build-model",
      "review-model",
      "plan-model",
      "codex-build-model",
      "codex-plan-model",
      "preview-image",
      "preview-command",
      "preview-port",
      "preview-readiness-path",
      "preview-ttl-hours",
      "canary-bot",
      "help",
    ]),
    add: new Set(["dir", "help"]),
    doctor: new Set([
      "dir",
      "local",
      "platform",
      "profile",
      "url",
      "key",
      "allow-insecure",
      "timeout",
      "run-guards",
      "github",
      "json",
      "help",
    ]),
    instance: new Set([
      "org-name",
      "org-slug",
      "owner-email",
      "owner-name",
      "github-user-id",
      "github-login",
      "github-account-id",
      "github-installation-id",
      "github-account-login",
      "github-account-type",
      "json",
      "help",
    ]),
  }[command];
  if (!allowed) return null;
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag));
  if (unknown.length) {
    return `Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((flag) => `--${flag}`).join(", ")}`;
  }
  const valueNames =
    command === "doctor"
      ? ["dir", "profile", "url", "key", "timeout"]
      : command === "instance"
        ? [...allowed].filter((name) => !["json", "help"].includes(name))
        : command === "init"
        ? [
            "dir",
            "branch",
            "provision",
            "checks",
            "project",
            "org",
            "modules",
            "auth",
            "build-model",
            "review-model",
            "plan-model",
            "codex-build-model",
            "codex-plan-model",
            "preview-image",
            "preview-command",
            "preview-port",
            "preview-readiness-path",
            "preview-ttl-hours",
            "canary-bot",
          ]
        : ["dir"];
  for (const name of valueNames) {
    if (name in flags && (typeof flags[name] !== "string" || flags[name].trim() === "")) {
      return `--${name} requires a value`;
    }
  }
  if (
    command === "doctor" &&
    flags.local &&
    (flags.platform || flags.profile || flags.url || flags.key)
  ) {
    return "--local cannot be combined with platform target options";
  }
  if (
    command === "doctor" &&
    (flags.platform || flags.profile || flags.url || flags.key) &&
    (flags["run-guards"] || flags.github)
  ) {
    return "--run-guards and --github are local-doctor options";
  }
  for (const name of [
    "yes",
    "force",
    "help",
    "local",
    "platform",
    "allow-insecure",
    "run-guards",
    "github",
    "json",
  ]) {
    if (name in flags && flags[name] !== true) return `--${name} does not take a value`;
  }
  return null;
}

function extractInvocation(argv) {
  const leading = [];
  const valueFlags = new Set(["--profile", "--timeout", "--dir", "--url", "--key"]);
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith("-") && !["--help", "--version", "-v"].includes(argv[index])) {
    const flag = argv[index];
    leading.push(flag);
    index += 1;
    if (valueFlags.has(flag) && index < argv.length) {
      leading.push(argv[index]);
      index += 1;
    }
  }
  return { command: argv[index], rest: [...leading, ...argv.slice(index + 1)] };
}

function localHelp(command) {
  const lines = {
    init: [
      "facility init [--dir <path>] [--yes] [--force]",
      "Detect the repository and install Facility workflows, guards, agents, and policy.",
    ],
    add: [
      "facility add <module> [--dir <path>]",
      "Add a Facility quality module to an existing installation.",
    ],
    doctor: [
      "facility doctor [--dir <path>] [--run-guards] [--github] [--json] | --platform [--profile <name>] [--timeout <seconds>] [--json] | --url <url> --key <key> [--allow-insecure] [--timeout <seconds>] [--json]",
      "Verify a local installation or an explicitly selected platform deployment; JSON works in either mode.",
    ],
  };
  const [usage, description] = lines[command];
  console.log(`\n  ${bold(`facility ${command}`)}`);
  console.log(`  ${dim(description)}\n`);
  console.log(`  ${bold("Usage")}\n    ${usage}\n`);
}
