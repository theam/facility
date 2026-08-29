import type { ArtifactChainConfig } from "./chain.js";
import { chainFromConfig } from "./chain.js";

export type HarnessKbEntry = {
  id: string;
  type: string;
  number: number;
  slug: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  status?: string | null;
  supersedes?: string | null;
};

export type HarnessKbLink = {
  fromEntry: string;
  toEntry: string;
};

export type HarnessKbSpace = {
  charterMd: string;
  activeMd: string;
  config?: unknown;
};

export type ValidationIssue = {
  code: string;
  message: string;
  entryId?: string;
};

export type ValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export type ValidateInput = {
  space: HarnessKbSpace;
  entries: HarnessKbEntry[];
  links: HarnessKbLink[];
  entryId?: string;
  chain?: ArtifactChainConfig;
  validateSpecials?: boolean;
};

export function validate(input: ValidateInput): ValidationReport {
  const chain = input.chain ?? chainFromConfig(input.space.config);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byRowId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const byArtifactId = new Map<string, HarnessKbEntry>();
  const outgoing = new Map<string, Set<string>>();

  for (const entry of input.entries) {
    const artifactId = artifactIdFor(entry);
    if (byArtifactId.has(artifactId)) {
      errors.push(issue("duplicate_artifact_id", `Duplicate artifact id ${artifactId}`, entry.id));
    }
    byArtifactId.set(artifactId, entry);
  }

  for (const link of input.links) {
    if (!byRowId.has(link.fromEntry) || !byRowId.has(link.toEntry)) {
      errors.push(issue("link_target_missing", "KB link points at a missing row", link.fromEntry));
      continue;
    }
    const set = outgoing.get(link.fromEntry) ?? new Set<string>();
    set.add(link.toEntry);
    outgoing.set(link.fromEntry, set);
  }

  const entriesToCheck = input.entryId
    ? input.entries.filter((entry) => entry.id === input.entryId)
    : input.entries;

  for (const entry of entriesToCheck) {
    validateEntry({ chain, entry, byRowId, byArtifactId, outgoing, errors, warnings });
  }

  if (!input.entryId) {
    for (const link of input.links) {
      if (!outgoing.get(link.toEntry)?.has(link.fromEntry)) {
        errors.push(
          issue(
            "backlink_missing",
            `Missing backlink from ${labelFor(byRowId.get(link.toEntry))} to ${labelFor(
              byRowId.get(link.fromEntry),
            )}`,
            link.toEntry,
          ),
        );
      }
    }
  }

  if (input.validateSpecials ?? !input.entryId) {
    validateSpecialNotes(input.space, errors, warnings);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateEntry(args: {
  chain: ArtifactChainConfig;
  entry: HarnessKbEntry;
  byRowId: Map<string, HarnessKbEntry>;
  byArtifactId: Map<string, HarnessKbEntry>;
  outgoing: Map<string, Set<string>>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}) {
  const { chain, entry, byRowId, byArtifactId, outgoing, errors } = args;
  const typeConfig = chain.types[entry.type];
  if (!typeConfig) {
    errors.push(issue("unknown_artifact_type", `Unknown artifact type ${entry.type}`, entry.id));
    return;
  }

  const artifactId = artifactIdFor(entry);
  const expectedId = expectedArtifactId(entry);
  if (artifactId !== expectedId) {
    errors.push(
      issue(
        "id_number_mismatch",
        `Artifact id ${artifactId} must match type/number ${expectedId}`,
        entry.id,
      ),
    );
  }
  if (entry.frontmatter.type !== entry.type) {
    errors.push(
      issue("frontmatter_type_mismatch", "Frontmatter type must match row type", entry.id),
    );
  }
  const aliases = Array.isArray(entry.frontmatter.aliases) ? entry.frontmatter.aliases : [];
  if (!aliases.includes(artifactId)) {
    errors.push(issue("alias_missing_own_id", `Aliases must include ${artifactId}`, entry.id));
  }
  const schema = typeConfig.schema.safeParse(entry.frontmatter);
  if (!schema.success) {
    errors.push(
      issue(
        "frontmatter_schema_invalid",
        schema.error.issues.map((item) => `${item.path.join(".")}: ${item.message}`).join("; "),
        entry.id,
      ),
    );
  }
  if (!hasLinksSection(entry.bodyMd)) {
    errors.push(
      issue("links_section_missing", "Entry body must include a ## Links section", entry.id),
    );
  }

  const bodyRefs = wikilinks(entry.bodyMd).filter((ref) => ref !== "ACTIVE" && ref !== "CHARTER");
  for (const ref of bodyRefs) {
    if (!byArtifactId.has(ref)) {
      errors.push(issue("link_ref_missing", `Body link [[${ref}]] does not resolve`, entry.id));
    }
  }
  const bodyRefRowIds = new Set(
    bodyRefs
      .map((ref) => byArtifactId.get(ref)?.id)
      .filter((rowId) => rowId !== entry.id)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const refId of bodyRefRowIds) {
    if (!outgoing.get(entry.id)?.has(refId)) {
      errors.push(
        issue(
          "link_table_missing",
          `Missing stored link to ${labelFor(byRowId.get(refId))}`,
          entry.id,
        ),
      );
    }
  }

  if (typeConfig.parentTypes.length > 0) {
    const linkedParents = [...(outgoing.get(entry.id) ?? [])]
      .map((rowId) => byRowId.get(rowId))
      .filter((candidate): candidate is HarnessKbEntry => Boolean(candidate))
      .filter((candidate) => typeConfig.parentTypes.includes(candidate.type));
    if (linkedParents.length === 0) {
      errors.push(
        issue(
          "parent_required",
          `${entry.type} requires a parent link to ${typeConfig.parentTypes.join("|")}`,
          entry.id,
        ),
      );
    }
  }
}

function validateSpecialNotes(
  space: HarnessKbSpace,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  const activeHeadings = headings(space.activeMd);
  for (const required of ["Objective", "Next Step", "Blocker", "Links"]) {
    if (!activeHeadings.includes(required)) {
      errors.push(issue("active_heading_missing", `ACTIVE is missing ## ${required}`));
    }
  }
  const allowed = new Set(["Objective", "Next Step", "Blocker", "Links"]);
  for (const heading of activeHeadings) {
    if (!allowed.has(heading)) {
      errors.push(issue("active_not_narrow", `ACTIVE contains unsupported heading ## ${heading}`));
    }
  }
  const charterHeadings = headings(space.charterMd);
  if (!charterHeadings.includes("Blocked Stop Condition")) {
    warnings.push(
      issue("charter_blocked_stop_missing", "CHARTER should define Blocked Stop Condition"),
    );
  }
}

export function artifactIdFor(entry: HarnessKbEntry): string {
  const id = entry.frontmatter.id;
  return typeof id === "string" && id.trim() ? id : expectedArtifactId(entry);
}

export function expectedArtifactId(entry: Pick<HarnessKbEntry, "type" | "number">): string {
  return `${entry.type}${String(entry.number).padStart(3, "0")}`;
}

export type StrandedEntry = { entryId: string; artifactId: string; type: string };

/**
 * Entries a chain leaves undeclared. A space is re-chained by rewriting its
 * config, and `validate()` judges every entry by the chain configured *now* —
 * so an entry that was legal when written fails as `unknown_artifact_type` on
 * every later validation, with nothing having been written wrongly. A caller
 * changing a space's config refuses the change while this is non-empty,
 * instead of storing a config that re-litigates history.
 */
export function entriesStrandedByChain(
  entries: HarnessKbEntry[],
  chain: ArtifactChainConfig,
): StrandedEntry[] {
  return entries
    .filter((entry) => !chain.types[entry.type])
    .map((entry) => ({ entryId: entry.id, artifactId: artifactIdFor(entry), type: entry.type }));
}

export function wikilinks(markdown: string): string[] {
  const matches = markdown.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
  return [...matches]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

export function hasLinksSection(markdown: string): boolean {
  return /^## Links\s*$/im.test(markdown);
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]?.trim() ?? "");
}

function labelFor(entry: HarnessKbEntry | undefined) {
  return entry ? artifactIdFor(entry) : "missing entry";
}

function issue(code: string, message: string, entryId?: string): ValidationIssue {
  return { code, message, entryId };
}
