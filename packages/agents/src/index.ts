import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import cronParser from "cron-parser";
import { parseDocument } from "yaml";
import { z } from "zod";

export const AGENT_DIRECTORY = ".agents";

const AgentName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case name");

const ManualTrigger = z.object({ type: z.literal("manual") }).strict();

const ScheduleTrigger = z
  .object({
    type: z.literal("schedule"),
    name: AgentName,
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

const GithubTrigger = z
  .object({
    type: z.literal("github"),
    name: AgentName,
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
  })
  .strict();

export const AgentTriggerSchema = z.union([ManualTrigger, ScheduleTrigger, GithubTrigger]);

export const AgentManifestFrontmatterSchema = z
  .object({
    name: AgentName,
    description: z.string().min(1).max(240),
    engine: z.enum(["claude_code", "codex"]),
    model: z.string().min(1).max(160),
    enabled: z.boolean().default(true),
    options: z
      .object({
        reasoning_effort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
          .optional(),
        max_turns: z.number().int().min(1).max(1_000).optional(),
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

export class AgentManifestError extends Error {
  readonly code = "agent_manifest_invalid";

  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "AgentManifestError";
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
  if (trigger.type === "manual") return "manual";
  return `${trigger.type}:${trigger.name}`;
}
