/**
 * Shared KB view-model helpers for the Product tab. The server owns the
 * canonical versions of these rules (packages/harness/src/validate.ts,
 * chain.ts) — this file mirrors only what display needs, and says so where
 * it does.
 */

export type KbEntry = {
  id: string;
  type: string;
  number: number;
  slug: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  status: string | null;
  supersedes: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type KbSpace = {
  charterMd: string;
  activeMd: string;
  config?: unknown;
  createdAt?: string;
  updatedAt?: string;
  charterUpdatedAt?: string | null;
  activeUpdatedAt?: string | null;
};

export type KbChainId = "product" | "research";

export type KbDecision = KbEntry & {
  artifactId: string;
  supersededBy: string | null;
  active: boolean;
};

export type KbNeighbor = {
  id: string;
  artifactId: string;
  type: string;
  number: number;
  slug: string;
  status: string | null;
  relation: "supersedes" | "superseded-by" | "linked";
};

export const TYPE_LABELS: Record<string, string> = {
  S: "signals",
  D: "decisions",
  T: "tasks",
  V: "verifications",
  R: "documentation",
  H: "hypotheses",
  E: "experiments",
  F: "findings",
  L: "learnings",
  CR: "change requests",
  SR: "status reports",
};

/** Singular per-page labels for the unified artifact header. */
const TYPE_SINGULAR: Record<string, string> = {
  S: "signal",
  D: "decision",
  T: "task",
  V: "verification",
  R: "documentation",
  H: "hypothesis",
  E: "experiment",
  F: "finding",
  L: "learning",
  CR: "change request",
  SR: "status report",
};

export function typeLabelsFor(chain: KbChainId): Record<string, string> {
  if (chain === "research") return { ...TYPE_LABELS, L: "literature" };
  return TYPE_LABELS;
}

export function typeLabelFor(type: string, chain: KbChainId = "product"): string {
  if (type === "L" && chain === "research") return "literature";
  return TYPE_SINGULAR[type] ?? type.toLowerCase();
}

/** Header timestamp: `2026-07-23 12:30` in local time. */
export function fmtStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Artifact ids a markdown body references — bare codes are the detection
 * unit (they also match inside [[wikilinks]]).
 */
const REF_SCAN_RE = /\b([A-Z]{1,2}\d{3}|CHARTER|ACTIVE)\b/g;

export function referencedIds(md: string): Set<string> {
  const refs = new Set<string>();
  for (const match of md.matchAll(REF_SCAN_RE)) {
    const id = match[1];
    if (id) refs.add(id);
  }
  return refs;
}

/** Mirror of packages/harness/src/validate.ts artifactIdFor — keep in sync. */
export function artifactIdFor(entry: Pick<KbEntry, "type" | "number" | "frontmatter">): string {
  const id = entry.frontmatter?.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  return `${entry.type}${String(entry.number).padStart(3, "0")}`;
}

/** Mirror of packages/harness/src/chain.ts chainFromConfig — keep in sync. */
export function chainIdFromConfig(config: unknown): KbChainId {
  const value = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const explicit = value.chain ?? value.harnessChain;
  if (explicit === "product" || explicit === "product-chain") return "product";
  if (explicit === "research" || explicit === "research-chain") return "research";
  const artifactTypes = Array.isArray(value.artifact_types) ? value.artifact_types : [];
  const prefixes = new Set(
    artifactTypes
      .map((item) =>
        item && typeof item === "object" ? (item as Record<string, unknown>).prefix : undefined,
      )
      .filter((item): item is string => typeof item === "string"),
  );
  if (["S", "D", "T", "V"].some((prefix) => prefixes.has(prefix))) return "product";
  return "research";
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Display-only: YAML frontmatter is metadata, not prose — never render it raw. */
export function stripFrontmatter(md: string): string {
  const match = md.match(FRONTMATTER_RE);
  return match ? md.slice(match[0].length) : md;
}

/**
 * Editing round-trip: the editor works on prose only; the original
 * frontmatter block (if any) is re-attached verbatim on save.
 */
export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: "", body: md };
  return { frontmatter: match[0], body: md.slice(match[0].length) };
}

export type KbSection = {
  key: string;
  label: string;
  entries: KbEntry[];
  /** Collapsed by default in the nav (pipeline artifacts, research chain). */
  secondary: boolean;
};

const PRIMARY_ORDER = ["D", "R", "S", "L"] as const;

/**
 * Section layout of the nav tree: Decisions, Documentation, Signals, and
 * Learnings as first-class sections; every remaining type (pipeline T/V,
 * research chain, …) lands in one "additional resources" freeform group —
 * which also hosts the charter/active context docs in the nav.
 *
 * `L` is "learnings" on the product chain and "literature" on research.
 */
export function groupSections(entries: KbEntry[], chain: KbChainId = "product"): KbSection[] {
  const byType = new Map<string, KbEntry[]>();
  for (const entry of entries) {
    byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
  }

  // Primary sections always render — an empty Decisions section with its
  // "+ new" affordance is the onboarding, not a gap to hide.
  const PRIMARY_LABELS: Record<string, string> = {
    D: "decisions (ADRs)",
    R: "documentation",
    S: "signals",
    L: chain === "research" ? "literature" : "learnings",
  };
  const sections: KbSection[] = [];
  for (const type of PRIMARY_ORDER) {
    const list = byType.get(type) ?? [];
    byType.delete(type);
    sections.push({
      key: type,
      label: PRIMARY_LABELS[type] ?? TYPE_LABELS[type] ?? type,
      entries: sortForSection(type, list),
      secondary: false,
    });
  }

  const rest: KbEntry[] = [];
  for (const [, list] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rest.push(...list);
  }
  rest.sort((a, b) => a.type.localeCompare(b.type) || b.number - a.number);
  sections.push({ key: "extra", label: "additional resources", entries: rest, secondary: true });
  return sections;
}

function sortForSection(type: string, list: KbEntry[]): KbEntry[] {
  if (type === "R") return [...list].sort((a, b) => a.slug.localeCompare(b.slug));
  return [...list].sort((a, b) => b.number - a.number);
}
