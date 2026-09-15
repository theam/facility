// Facility 0.12 CLI entry: repository kickstart, validation, and instance bootstrap.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "./init.mjs";
import { doctor } from "./doctor.mjs";
import { bootstrapInstance } from "./instance.mjs";
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
    else if (arg === "--help") flags.help = true;
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
  helpGroup("Configure a repository", [
    ["init", "write .facility.yml and the .agents catalog"],
    ["doctor", "verify the workspace contract"],
  ]);
  item(dim("Run stories through Facility's MCP server or web UI."));
  console.log("");
  helpGroup("Instance administration", [
    ["instance bootstrap", "create the first organization, owner, and GitHub installation"],
  ]);
  console.log("");
  item(dim("init flags: --yes --force --dir=<path> --repo=<owner/name> --provision=<cmd> --start=<cmd>"));
  item(dim("            --service-port=<n> --preview-readiness-command=<cmd>"));
  item(dim('            --build-model=<id> --review-model=<id> --plan-model=<id>'));
  item(dim('            --codex-build-model=<id> --codex-plan-model=<id>'));
  item(dim("Run facility <command> --help for precise usage."));
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

  if (flags.help && ["init", "doctor"].includes(command)) {
    localHelp(command);
    return 0;
  }

  switch (command) {
    case "init":
      return init(flags, pkgRoot, version);
    case "doctor":
      return doctor(flags, version);
    case "instance":
      if (positional[0] === "bootstrap") return bootstrapInstance(flags);
      console.error("Usage: facility instance bootstrap [options]");
      return 1;
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
      "provision",
      "start",
      "repo",
      "service-port",
      "preview-readiness-command",
      "org",
      "build-model",
      "review-model",
      "plan-model",
      "codex-build-model",
      "codex-plan-model",
      "help",
    ]),
    doctor: new Set(["dir", "json", "help"]),
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
      ? ["dir"]
      : command === "instance"
        ? [...allowed].filter((name) => !["json", "help"].includes(name))
        : command === "init"
        ? [
            "dir",
            "provision",
            "start",
            "repo",
            "service-port",
            "preview-readiness-command",
            "org",
            "build-model",
            "review-model",
            "plan-model",
            "codex-build-model",
            "codex-plan-model",
          ]
        : ["dir"];
  for (const name of valueNames) {
    if (name in flags && (typeof flags[name] !== "string" || flags[name].trim() === "")) {
      return `--${name} requires a value`;
    }
  }
  for (const name of [
    "yes",
    "force",
    "help",
    "json",
  ]) {
    if (name in flags && flags[name] !== true) return `--${name} does not take a value`;
  }
  return null;
}

function extractInvocation(argv) {
  return { command: argv[0], rest: argv.slice(1) };
}

function localHelp(command) {
  const lines = {
    init: [
      "facility init [--dir <path>] [--yes] [--force]",
      "Detect the repository and install .facility.yml plus the shared .agents catalog.",
    ],
    doctor: [
      "facility doctor [--dir <path>] [--json]",
      "Verify the repository's .facility.yml and .agents catalog.",
    ],
  };
  const [usage, description] = lines[command];
  console.log(`\n  ${bold(`facility ${command}`)}`);
  console.log(`  ${dim(description)}\n`);
  console.log(`  ${bold("Usage")}\n    ${usage}\n`);
}
