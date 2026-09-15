import type { FacilityGithubClient } from "../github/client.js";
import { decodeContent } from "../github/repo-files.js";

export const isAgentManifestPath = (path: string) =>
  /^\.agents\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(path);

export const isProjectSkillPath = (path: string) =>
  /^\.(?:agents|claude)\/skills\/(?:[^/]+\/)*SKILL\.md$/.test(path);

type Content = {
  type?: string;
  path?: string;
  content?: string;
  encoding?: string;
  target?: string;
};

/** Only missing optional roots are empty. An incomplete traversal is never a snapshot. */
export async function readAgentCatalogFiles(
  client: Pick<FacilityGithubClient, "getContent">,
  ref: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(path: string, optionalRoot = false): Promise<void> {
    let content: Content | Content[];
    try {
      content = (await client.getContent(path, ref)) as Content | Content[];
    } catch (error) {
      if (optionalRoot && (error as { status?: number })?.status === 404) return;
      throw error;
    }
    if (Array.isArray(content)) {
      if (isAgentManifestPath(path) || isProjectSkillPath(path)) {
        throw new Error("Invalid agent catalog file");
      }
      // Sequential traversal bounds requests even for repositories with many skills.
      for (const child of content) {
        const name = child.path?.slice(path.length + 1);
        if (
          !child.path?.startsWith(`${path}/`) ||
          !name ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\")
        ) {
          throw new Error("Invalid agent catalog directory entry");
        }
        const skillDirectory =
          child.path === ".agents/skills" ||
          child.path.startsWith(".agents/skills/") ||
          child.path.startsWith(".claude/skills/");
        if (
          (child.type === "dir" && skillDirectory) ||
          isAgentManifestPath(child.path) ||
          isProjectSkillPath(child.path)
        ) {
          await visit(child.path);
        }
      }
      return;
    }
    if (!isAgentManifestPath(path) && !isProjectSkillPath(path)) {
      throw new Error("Invalid agent catalog root");
    }
    if (content.type === "symlink" && typeof content.target === "string") {
      files.set(path, content.target);
      return;
    }
    if (content.type !== "file" || typeof content.content !== "string") {
      throw new Error("Incomplete agent catalog file");
    }
    files.set(path, decodeContent(content.content, content.encoding));
  }
  await visit(".agents", true);
  await visit(".claude/skills", true);
  return files;
}
