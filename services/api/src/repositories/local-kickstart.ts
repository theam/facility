import { renderWorkspaceKickstart } from "@facility/core";
import { detectWorkspace, inferStartCommand, type KickstartAnswers } from "../github/kickstart.js";
import type { LocalRepositoryHost } from "./local.js";

const DETECTION_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".facility.yml",
];

/**
 * Starter configuration for a local repository, returned as a patch the user
 * reviews and applies in their own checkout. Facility writes nothing to it.
 */
export async function localKickstart(
  host: LocalRepositoryHost,
  repository: { name: string; defaultBranch: string; sourcePath: string },
  answers: KickstartAnswers,
) {
  const baseSha = await host.resolve(repository.sourcePath, repository.defaultBranch);
  const paths = await host.paths(repository.sourcePath, baseSha, [...DETECTION_FILES, ".agents"]);
  const existing = new Map<string, string>();
  for (const path of paths) {
    if (path === "package.json") {
      existing.set(path, (await host.readFile(repository.sourcePath, baseSha, path)) ?? "");
    } else if (DETECTION_FILES.includes(path) || /^\.agents\/[^/]+\.md$/.test(path)) {
      // Only presence matters for these files; their content is never read.
      existing.set(path, "");
    }
  }
  const detection = detectWorkspace(existing, repository.defaultBranch);
  const rendered = renderWorkspaceKickstart(
    {
      repository: repository.name,
      source: "local",
      setup: answers.provisionCmd?.trim() || detection.setup,
      start: answers.startCmd?.trim() || inferStartCommand(existing, detection.packageManager),
      ready: answers.readyCmd?.trim() || undefined,
      servicePort: answers.servicePort ?? 3000,
      models: answers.models,
    },
    existing,
  );
  return {
    baseSha,
    detection,
    files: rendered.files,
    skipped: rendered.skipped,
    manifest: rendered.manifest,
    patch: newFilesPatch(rendered.files),
    instructions: [
      "git apply --check facility-kickstart.patch",
      "git apply facility-kickstart.patch",
      "git add .facility.yml .agents",
      'git commit -m "feat: configure Facility local workflow"',
    ],
  };
}

/** A `git apply` compatible patch that only creates files. */
export function newFilesPatch(files: Array<{ path: string; content: string }>) {
  if (files.length === 0) return "";
  return files
    .map((file) => {
      const trailingNewline = file.content.endsWith("\n");
      const lines = file.content.split("\n");
      if (trailingNewline) lines.pop();
      return [
        `diff --git a/${file.path} b/${file.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file.path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        ...(trailingNewline ? [] : ["\\ No newline at end of file"]),
      ].join("\n");
    })
    .join("\n")
    .concat("\n");
}
