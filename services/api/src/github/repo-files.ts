import type { FacilityGithubClient } from "./client.js";

type GitHubContent =
  | { type?: string; content?: string; encoding?: string; path?: string; target?: string }
  | GitHubContent[];

export async function readRepoFiles(
  client: FacilityGithubClient,
  ref: string,
  paths?: string[],
): Promise<Map<string, string>> {
  const wanted = paths ?? [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "compose.yml",
    "compose.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".facility.yml",
    ".agents",
    "AGENTS.md",
    "CLAUDE.md",
    "STANDARD.md",
    ".claude/settings.json",
    ".github/workflows",
    "migrations",
    "supabase/migrations",
    "db/migrations",
    "prisma/migrations",
  ];
  const files = new Map<string, string>();
  await Promise.all(
    wanted.map(async (path) => {
      await readPath(client, ref, path, files).catch(() => undefined);
    }),
  );
  return files;
}

async function readPath(
  client: FacilityGithubClient,
  ref: string,
  path: string,
  files: Map<string, string>,
): Promise<void> {
  const content = (await client.getContent(path, ref)) as GitHubContent;
  if (Array.isArray(content)) {
    await Promise.all(
      content
        .filter((item) => typeof item === "object" && "path" in item && item.path)
        .map((item) =>
          readPath(client, ref, (item as { path: string }).path, files).catch(() => undefined),
        ),
    );
    return;
  }
  if (content.type === "symlink" && typeof content.target === "string") {
    files.set(content.path ?? path, content.target);
    return;
  }
  if (content.type !== "file" || typeof content.content !== "string") return;
  files.set(content.path ?? path, decodeContent(content.content, content.encoding));
}

export function decodeContent(content: string, encoding?: string): string {
  if (encoding === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return content;
}
