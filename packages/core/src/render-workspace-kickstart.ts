import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Manifest, manifestFor } from "./fingerprints.js";

export type WorkspaceKickstartAnswers = {
  /** `owner/name` for GitHub, or the registered alias for a local repository. */
  repository: string;
  /** Local repositories use `local:alias` and templates without GitHub workflows. */
  source?: "github" | "local";
  setup?: string;
  start: string;
  ready?: string;
  servicePort?: number;
  models?: {
    build?: string;
    review?: string;
    plan?: string;
    codexBuild?: string;
    codexPlan?: string;
  };
};

export type WorkspaceKickstartResult = {
  files: Array<{ path: string; content: string; mode: "100644" }>;
  skipped: string[];
  manifest: Manifest & { templateSet: "0.12" };
};

const moduleRoot = dirname(fileURLToPath(import.meta.url));

function templateRoot() {
  const packaged = join(moduleRoot, "render-assets", "packages", "cli", "templates");
  return existsSync(join(packaged, "agents", "builder.md"))
    ? packaged
    : join(moduleRoot, "../../../packages/cli/templates");
}

export function renderWorkspaceKickstart(
  answers: WorkspaceKickstartAnswers,
  existingFiles: Map<string, string> | Record<string, string> = {},
): WorkspaceKickstartResult {
  const local = answers.source === "local";
  if (local) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(answers.repository)) {
      throw new Error("repository must be a local repository alias");
    }
  } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(answers.repository)) {
    throw new Error("repository must be owner/name");
  }
  if (!answers.start.trim()) throw new Error("environment start command is required");
  const servicePort = answers.servicePort ?? 3000;
  if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535) {
    throw new Error("service port must be an integer between 1 and 65535");
  }
  const existing =
    existingFiles instanceof Map ? existingFiles : new Map(Object.entries(existingFiles));
  const models = {
    BUILD_MODEL: answers.models?.build ?? "claude-fable-5",
    REVIEW_MODEL: answers.models?.review ?? "claude-sonnet-5",
    PLAN_MODEL: answers.models?.plan ?? "claude-opus-4-8",
    CODEX_BUILD_MODEL: answers.models?.codexBuild ?? "gpt-6-luna",
    CODEX_PLAN_MODEL: answers.models?.codexPlan ?? "gpt-6-luna",
  };
  const root = templateRoot();
  const candidates = [
    {
      path: ".facility.yml",
      content: projectManifest(answers, servicePort),
    },
    ...(local
      ? ["architect", "builder", "reviewer"]
      : ["architect", "builder", "pr-reviewer", "address-review", "ci-doctor", "security-audit"]
    ).map((name) => ({
      path: `.agents/${name}.md`,
      content: renderTemplate(
        readFileSync(join(root, local ? "agents-local" : "agents", `${name}.md`), "utf8"),
        models,
      ),
    })),
  ];
  const files = candidates
    .filter((file) => !existing.has(file.path))
    .map((file) => ({ ...file, mode: "100644" as const }));
  return {
    files,
    skipped: candidates.filter((file) => existing.has(file.path)).map((file) => file.path),
    manifest: {
      ...manifestFor(files.map(({ path, content }) => ({ path, content }))),
      templateSet: "0.12",
    },
  };
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, name: string) => {
    return values[name] ?? placeholder;
  });
}

function projectManifest(answers: WorkspaceKickstartAnswers, servicePort: number) {
  return [
    "version: 1",
    "repositories:",
    `  primary: ${JSON.stringify(
      answers.source === "local"
        ? `local:${answers.repository}`
        : `github.com/${answers.repository}`,
    )}`,
    "  related: []",
    "environment:",
    ...(answers.setup ? [`  setup: ${JSON.stringify(answers.setup)}`] : []),
    `  start: ${JSON.stringify(answers.start)}`,
    ...(answers.ready ? [`  ready: ${JSON.stringify(answers.ready)}`] : []),
    "  services:",
    "    app:",
    `      port: ${servicePort}`,
    "      protocol: http",
    "      websocket: true",
    "",
  ].join("\n");
}
