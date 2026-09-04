import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import cronParser from "cron-parser";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

export const AGENT_DIRECTORY = ".agents";

export const AgentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case name");

const InteractiveTrigger = z.object({ type: z.enum(["manual", "mcp", "ui"]) }).strict();

const ScheduleTrigger = z
  .object({
    type: z.literal("schedule"),
    name: AgentNameSchema,
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128).default("UTC"),
  })
  .strict()
  .superRefine((trigger, context) => {
    try {
      cronParser.parseExpression(trigger.cron, { tz: trigger.timezone });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["cron"],
        message: error instanceof Error ? error.message : "invalid cron expression or timezone",
      });
    }
  });

/** GitHub's `author_association` vocabulary, as delivered on issue, comment, pull request, and review payloads. */
export const GITHUB_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;

export type GithubAuthorAssociation = (typeof GITHUB_AUTHOR_ASSOCIATIONS)[number];

/**
 * Event text reaches an agent that holds maintainer credentials, so a GitHub trigger only fires
 * for accounts with a standing relationship to the repository unless the manifest widens it.
 */
export const DEFAULT_GITHUB_TRIGGER_AUTHORS: readonly GithubAuthorAssociation[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];

const GithubTriggerAuthors = z.union([
  z.literal("any"),
  z.array(z.enum(GITHUB_AUTHOR_ASSOCIATIONS)).min(1),
]);

const GithubTrigger = z
  .object({
    type: z.literal("github"),
    name: AgentNameSchema,
    event: z.enum([
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "check_suite",
      "workflow_run",
    ]),
    actions: z.array(z.string().min(1).max(64)).min(1).optional(),
    labels: z.array(z.string().min(1).max(128)).min(1).optional(),
    authors: GithubTriggerAuthors.optional(),
  })
  .strict();

export const AgentTriggerSchema = z.union([InteractiveTrigger, ScheduleTrigger, GithubTrigger]);

export const AgentManifestFrontmatterSchema = z
  .object({
    name: AgentNameSchema,
    description: z.string().min(1).max(240),
    engine: z.enum(["claude_code", "codex"]),
    model: z.string().min(1).max(160),
    enabled: z.boolean().default(true),
    options: z
      .object({
        reasoning_effort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
          .optional(),
      })
      .strict()
      .default({}),
    triggers: z.array(AgentTriggerSchema).min(1),
  })
  .strict();

export type AgentManifestFrontmatter = z.infer<typeof AgentManifestFrontmatterSchema>;
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;

export type AgentManifest = AgentManifestFrontmatter & {
  file: string;
  prompt: string;
  hash: string;
};

export const AgentManifestSchema = AgentManifestFrontmatterSchema.extend({
  file: z.string().min(1).max(500),
  prompt: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type AgentManifestSource = {
  file: string;
  source: string;
};

export const ProjectSkillFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
  })
  .passthrough();

export type ProjectSkill = {
  name: string;
  description: string;
  path: string;
  directory: ".agents" | ".claude";
  hash: string;
};

export type ProjectSkillSource = AgentManifestSource;

export class AgentManifestError extends Error {
  readonly code = "agent_manifest_invalid";
  readonly statusCode = 400;

  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "AgentManifestError";
  }
}

export class ProjectSkillError extends Error {
  readonly code = "project_skill_invalid";
  readonly statusCode = 400;

  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ProjectSkillError";
  }
}

export function parseAgentManifest(source: string, file = "agent.md"): AgentManifest {
  const normalizedNewlines = source.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalizedNewlines);
  if (!match) {
    throw new AgentManifestError(
      file,
      "expected YAML frontmatter delimited by --- at the start of the file",
    );
  }

  const document = parseDocument(match[1] ?? "", {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AgentManifestError(file, document.errors.map((error) => error.message).join("; "));
  }

  const result = AgentManifestFrontmatterSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    throw new AgentManifestError(
      file,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
        .join("; "),
    );
  }

  const prompt = (match[2] ?? "").trim();
  if (!prompt) throw new AgentManifestError(file, "prompt body must not be empty");

  const expectedFile = `${result.data.name}.md`;
  if (basename(file) !== expectedFile) {
    throw new AgentManifestError(file, `filename must be ${expectedFile}`);
  }

  const canonicalSource = `${normalizedNewlines.trimEnd()}\n`;
  return {
    ...result.data,
    file,
    prompt,
    hash: createHash("sha256").update(canonicalSource).digest("hex"),
  };
}

export function renderAgentManifest(
  input: AgentManifestFrontmatter & { prompt: string },
  file = `${input.name}.md`,
): { source: string; manifest: AgentManifest } {
  const frontmatter = AgentManifestFrontmatterSchema.parse({
    name: input.name,
    description: input.description,
    engine: input.engine,
    model: input.model,
    enabled: input.enabled,
    options: input.options,
    triggers: input.triggers,
  });
  const prompt = input.prompt.trim();
  if (!prompt) throw new AgentManifestError(file, "prompt body must not be empty");
  const source = `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${prompt}\n`;
  return { source, manifest: parseAgentManifest(source, file) };
}

export function parseAgentCatalog(sources: AgentManifestSource[]): AgentManifest[] {
  const manifests = sources
    .map(({ file, source }) => parseAgentManifest(source, file))
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set<string>();
  for (const manifest of manifests) {
    if (names.has(manifest.name)) {
      throw new AgentManifestError(manifest.file, `duplicate agent name ${manifest.name}`);
    }
    names.add(manifest.name);
  }
  return manifests;
}

/** Parses repository-installed skills for inventory only; execution remains engine-owned. */
export function parseProjectSkill(source: string, file: string): ProjectSkill {
  if (!/^\.(?:agents|claude)\/skills\/(?:[^/]+\/)*SKILL\.md$/.test(file)) {
    throw new ProjectSkillError(
      file,
      "expected .agents/skills/**/SKILL.md or .claude/skills/**/SKILL.md",
    );
  }
  const normalizedNewlines = source.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedNewlines);
  if (!match) {
    throw new ProjectSkillError(
      file,
      "expected YAML frontmatter delimited by --- at the start of the file",
    );
  }
  const document = parseDocument(match[1] ?? "", {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ProjectSkillError(file, document.errors.map((error) => error.message).join("; "));
  }
  const result = ProjectSkillFrontmatterSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    throw new ProjectSkillError(
      file,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
        .join("; "),
    );
  }
  return {
    name: result.data.name,
    description: result.data.description,
    path: file,
    directory: file.startsWith(".agents/") ? ".agents" : ".claude",
    hash: createHash("sha256").update(`${normalizedNewlines.trimEnd()}\n`).digest("hex"),
  };
}

export function parseProjectSkills(sources: ProjectSkillSource[]): ProjectSkill[] {
  const skills = sources
    .map(({ file, source }) => parseProjectSkill(source, file))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  for (const skill of skills) {
    if (paths.has(skill.path)) throw new ProjectSkillError(skill.path, "duplicate skill path");
    paths.add(skill.path);
  }
  return skills;
}

export async function loadAgentCatalog(directory: string): Promise<AgentManifest[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(join(directory, file), "utf8") })),
  );
  return parseAgentCatalog(sources);
}

export function findAgent(manifests: AgentManifest[], name: string): AgentManifest {
  const manifest = manifests.find((candidate) => candidate.name === name && candidate.enabled);
  if (!manifest) throw new AgentManifestError(`${AGENT_DIRECTORY}/${name}.md`, "agent not found");
  return manifest;
}

export function triggerIdentity(trigger: AgentTrigger): string {
  return "name" in trigger ? `${trigger.type}:${trigger.name}` : trigger.type;
}

/**
 * Resolves the author gate of a GitHub trigger. Manifests parsed before the field existed carry no
 * value, so the default is applied here rather than by the schema to keep stored snapshots and
 * content hashes unchanged.
 */
export function githubTriggerAuthors(
  trigger: Extract<AgentTrigger, { type: "github" }>,
): "any" | readonly GithubAuthorAssociation[] {
  return trigger.authors ?? DEFAULT_GITHUB_TRIGGER_AUTHORS;
}

export function githubTriggerAllowsAuthor(
  trigger: Extract<AgentTrigger, { type: "github" }>,
  association: GithubAuthorAssociation,
): boolean {
  const authors = githubTriggerAuthors(trigger);
  return authors === "any" || authors.includes(association);
}
