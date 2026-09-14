import { parseDocument } from "yaml";
import { z } from "zod";

const RepositoryName = z
  .string()
  .min(3)
  .max(240)
  .transform((value, context) => {
    const match =
      /^(?:https:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
    if (!match) {
      context.addIssue({ code: "custom", message: "must be github.com/owner/repository" });
      return z.NEVER;
    }
    return `${match[1]}/${match[2]}`;
  });

const ServiceSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    protocol: z.enum(["http", "https"]).default("http"),
    websocket: z.boolean().default(true),
  })
  .strict();

const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const ProjectManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    repositories: z
      .object({
        primary: RepositoryName,
        related: z.array(RepositoryName).default([]),
      })
      .strict(),
    environment: z
      .object({
        image: z.string().min(1).max(500).optional(),
        setup: z.string().min(1).max(4_000).optional(),
        start: z.string().min(1).max(4_000),
        ready: z.string().min(1).max(4_000).optional(),
        stop: z.string().min(1).max(4_000).optional(),
        seed: z.string().min(1).max(4_000).optional(),
        browser_test: z.string().min(1).max(4_000).optional(),
        secrets: z.array(EnvironmentName).default([]),
        variables: z.array(EnvironmentName).default([]),
        services: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), ServiceSchema).default({}),
      })
      .strict(),
  })
  .strict();

export class ProjectManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectManifestError";
  }
}

/** @param {string} source */
export function parseProjectManifest(source) {
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ProjectManifestError(document.errors.map((error) => error.message).join("; "));
  }

  const result = ProjectManifestSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    throw new ProjectManifestError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}

/** @param {string} name */
export function parseEnvironmentName(name) {
  return EnvironmentName.parse(name);
}
