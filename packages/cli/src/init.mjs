// `facility init` installs the complete 0.12 repository contract. Facility is
// the runtime; the repository owns only its environment declaration and agent
// catalog.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detect } from "./detect.mjs";
import { ask, closePrompts, confirm } from "./prompts.mjs";
import { banner, bold, dim, heading, item, ok, skip, warn } from "./ui.mjs";

const AGENTS = [
  "architect",
  "builder",
  "pr-reviewer",
  "address-review",
  "ci-doctor",
  "security-audit",
];

export async function init(flags, pkgRoot, version) {
  const dir = flags.dir || process.cwd();
  const interactive = !flags.yes;
  banner(version);

  const detected = detect(dir);
  if (!detected.isGitRepo) {
    warn(`${dir} is not a git repository. Facility workspaces expect a GitHub repository.`);
    if (interactive && !(await confirm("Continue anyway?", false))) {
      closePrompts();
      return 1;
    }
  }

  heading("Detected");
  item(`repository       ${bold(detected.repository || "not detected")}`);
  item(`package manager  ${bold(detected.packageManager)}`);
  item(`setup            ${detected.provision ? bold(detected.provision) : dim("none")}`);
  item(`start            ${detected.start ? bold(detected.start) : dim("not detected")}`);

  const repository =
    flags.repo ??
    (interactive
      ? await ask("Primary GitHub repository (owner/name)?", detected.repository)
      : detected.repository || `${flags.org || detected.org || "local"}/${basename(dir)}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("A primary GitHub repository is required as owner/name. Pass --repo=owner/name.");
  }

  const setup =
    flags.provision ??
    (interactive
      ? await ask("Setup command (optional, reruns when the environment changes)?", detected.provision)
      : detected.provision);
  const start =
    flags.start ??
    (interactive
      ? await ask("Start command for the complete development environment?", detected.start)
      : detected.start);
  if (!start?.trim()) {
    throw new Error(
      "A development environment start command is required. Pass --start, for example --start='docker compose up -d'.",
    );
  }
  const ready =
    flags["preview-readiness-command"] ??
    (interactive ? await ask("Readiness command (optional)?", "") : "");
  const servicePort = Number(
    flags["service-port"] ?? (interactive ? await ask("Application port?", "3000") : "3000"),
  );
  if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535) {
    throw new Error("Service port must be an integer between 1 and 65535.");
  }

  const models = {
    BUILD_MODEL: flags["build-model"] || "claude-fable-5",
    REVIEW_MODEL: flags["review-model"] || "claude-sonnet-5",
    PLAN_MODEL: flags["plan-model"] || "claude-opus-4-8",
    CODEX_BUILD_MODEL: flags["codex-build-model"] || "gpt-5.6-sol",
    CODEX_PLAN_MODEL: flags["codex-plan-model"] || "gpt-5.6-sol",
  };

  const template = (relativePath) =>
    readFileSync(join(pkgRoot, "templates", relativePath), "utf8");
  const plan = [
    {
      to: ".facility.yml",
      content: formatProjectManifest({ repository, setup, start, ready, servicePort }),
    },
    ...AGENTS.map((name) => ({
      to: `.agents/${name}.md`,
      content: renderTemplate(template(`agents/${name}.md`), models),
    })),
  ];

  heading("Writing");
  let written = 0;
  for (const file of plan) {
    const target = join(dir, file.to);
    if (existsSync(target) && !flags.force) {
      skip(`${file.to} exists — left untouched`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    ok(file.to);
    written += 1;
  }

  heading("Done");
  item("Review `.facility.yml`: its commands run with full workspace access.");
  item("Review `.agents/*.md`: every agent receives the same GitHub maintainer capability.");
  item("Commit these files, connect the repository to Facility, then start a story through MCP or the UI.");
  item(dim(`${written} files written; existing project-owned files were preserved.`));
  closePrompts();
  return 0;
}

function renderTemplate(source, values) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    source,
  );
}

function formatProjectManifest({ repository, setup, start, ready, servicePort }) {
  return [
    "version: 1",
    "repositories:",
    `  primary: ${JSON.stringify(`github.com/${repository}`)}`,
    "  related: []",
    "environment:",
    ...(setup ? [`  setup: ${JSON.stringify(setup)}`] : []),
    `  start: ${JSON.stringify(start)}`,
    ...(ready ? [`  ready: ${JSON.stringify(ready)}`] : []),
    "  services:",
    "    app:",
    `      port: ${servicePort}`,
    "      protocol: http",
    "      websocket: true",
    "",
  ].join("\n");
}
