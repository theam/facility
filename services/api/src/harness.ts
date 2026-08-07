import { newId } from "@facility/core";
import type { createDb } from "@facility/db";
import { kbEntries, kbLinks, kbSpaces } from "@facility/db";
import {
  artifactIdFor,
  buildHarnessBundle,
  chainFromConfig,
  type HarnessKbEntry,
  type HarnessKbLink,
  type HarnessKbSpace,
  validate,
} from "@facility/harness";
import { and, eq } from "drizzle-orm";

type Db = ReturnType<typeof createDb>["db"];

export const DEFAULT_PROJECT_CHARTER_MD = `# Project charter

## Blocked Stop Condition

Stop when progress requires missing authority, credentials, or human judgment.
`;

export const DEFAULT_PROJECT_ACTIVE_MD = `## Objective

## Next Step

## Blocker

## Links
`;

/**
 * Ensure every project that runs a harness-backed agent has a valid recovery
 * space. This is deliberately idempotent so scheduled agents can repair
 * projects created before the default was introduced.
 */
export async function ensureProjectKbSpace(db: Db, orgId: string, projectId: string) {
  const existing = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)))
      .limit(1)
  )[0];
  if (existing) return existing;

  const created = (
    await db
      .insert(kbSpaces)
      .values({
        id: newId("kb"),
        orgId,
        projectId,
        charterMd: DEFAULT_PROJECT_CHARTER_MD,
        activeMd: DEFAULT_PROJECT_ACTIVE_MD,
        config: {},
      })
      .onConflictDoNothing({ target: kbSpaces.projectId })
      .returning()
  )[0];
  if (created) return created;

  const concurrent = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)))
      .limit(1)
  )[0];
  if (!concurrent) throw new Error(`kb_space_create_failed:${projectId}`);
  return concurrent;
}

export async function loadKbGraph(db: Db, orgId: string, projectId: string) {
  const space = (
    await db
      .select()
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)))
      .limit(1)
  )[0];
  if (!space) return null;
  const entries = await db
    .select()
    .from(kbEntries)
    .where(and(eq(kbEntries.orgId, orgId), eq(kbEntries.spaceId, space.id)));
  const links = await db
    .select()
    .from(kbLinks)
    .where(and(eq(kbLinks.orgId, orgId), eq(kbLinks.spaceId, space.id)));
  return { space, entries: entries.map(toHarnessEntry), links: links.map(toHarnessLink) };
}

export async function validateProjectKb(db: Db, orgId: string, projectId: string) {
  const graph = await loadKbGraph(db, orgId, projectId);
  if (!graph) {
    return {
      ok: false,
      errors: [{ code: "kb_space_missing", message: "KB space not found" }],
      warnings: [],
    };
  }
  return validate({
    space: toHarnessSpace(graph.space),
    entries: graph.entries,
    links: graph.links,
  });
}

export function toHarnessEntry(entry: typeof kbEntries.$inferSelect): HarnessKbEntry {
  return {
    id: entry.id,
    type: entry.type,
    number: entry.number,
    slug: entry.slug,
    frontmatter: objectOrEmpty(entry.frontmatter),
    bodyMd: entry.bodyMd,
    status: entry.status,
    supersedes: entry.supersedes,
  };
}

export function toHarnessLink(link: typeof kbLinks.$inferSelect): HarnessKbLink {
  return { fromEntry: link.fromEntry, toEntry: link.toEntry };
}

export function toHarnessSpace(space: typeof kbSpaces.$inferSelect): HarnessKbSpace {
  return { charterMd: space.charterMd, activeMd: space.activeMd, config: space.config };
}

export function normalizeKbDraft(input: {
  type: string;
  number: number;
  slug: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  parentEntries: HarnessKbEntry[];
}) {
  const id = `${input.type}${String(input.number).padStart(3, "0")}`;
  const aliases = Array.isArray(input.frontmatter.aliases)
    ? [...new Set([id, ...input.frontmatter.aliases.filter((item) => typeof item === "string")])]
    : [id];
  const frontmatter = {
    created: new Date().toISOString().slice(0, 10),
    tags: [],
    ...input.frontmatter,
    id,
    aliases,
    type: input.type,
  };
  const refs = [
    id,
    "ACTIVE",
    "CHARTER",
    ...input.parentEntries.map((entry) => artifactIdFor(entry)),
  ];
  return {
    frontmatter,
    bodyMd: ensureLinks(input.bodyMd, refs),
  };
}

export function ensureLinks(markdown: string, refs: string[]) {
  const uniqueRefs = [...new Set(refs.filter(Boolean))];
  const lines = uniqueRefs.map((ref) => `- [[${ref}]]`).join("\n");
  if (!/^## Links\s*$/im.test(markdown)) {
    const base = markdown.trimEnd();
    return `${base}${base ? "\n\n" : ""}## Links\n\n${lines}\n`;
  }
  let updated = markdown;
  for (const ref of uniqueRefs) {
    if (!new RegExp(`\\[\\[${escapeRegExp(ref)}(?:[|#][^\\]]*)?\\]\\]`).test(updated)) {
      updated = `${updated.trimEnd()}\n- [[${ref}]]\n`;
    }
  }
  return updated;
}

export function ensureActive(activeMd: string, refs: string[]) {
  const headings = ["Objective", "Next Step", "Blocker", "Links"];
  let markdown = activeMd.trim();
  if (!markdown) {
    markdown = "## Objective\n\n## Next Step\n\n## Blocker\n\n## Links\n";
  }
  for (const heading of headings) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "im").test(markdown)) {
      markdown = `${markdown.trimEnd()}\n\n## ${heading}\n`;
    }
  }
  return ensureLinks(markdown, refs);
}

export function harnessFragmentForBundle(input: {
  space: typeof kbSpaces.$inferSelect | undefined;
  harnessItemId: string | null | undefined;
  runId: string;
  mode?: string;
}) {
  // A KB space exists for every initialized project, but only agents with an
  // explicit harness receive its mandatory session protocol. This predicate
  // intentionally matches runUsesHarness(), which owns the terminal KB gate.
  if (!input.space || !input.harnessItemId) return undefined;
  return buildHarnessBundle({
    chain: chainFromConfig(input.space.config),
    charterMd: input.space.charterMd,
    activeMd: input.space.activeMd,
    runId: input.runId,
    mode: input.mode,
  });
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
