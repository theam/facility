"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AboutRow,
  ArtifactPage,
  type PanelLinkGroup,
} from "@/components/product/artifact-page";
import { NavTree } from "@/components/product/nav-tree";
import { NewEntry } from "@/components/product/new-entry";
import {
  artifactIdFor,
  chainIdFromConfig,
  fmtStamp,
  groupSections,
  type KbDecision,
  type KbEntry,
  type KbSpace,
  referencedIds,
  splitFrontmatter,
  typeLabelFor,
} from "@/lib/kb";
import { fetchNeighborhood, type Neighborhood, patchEntry, saveSpace } from "@/lib/kb-client";

/**
 * The Product workspace: page tree on the left, the unified artifact page on
 * the right. Every artifact — decisions, docs, signals, L pages (learnings on
 * the product chain, literature on research), and the charter/active context
 * docs — renders through the same template. Selection is URL state (?doc=D001)
 * so artifact links deep-link and survive refreshes.
 */
export function ProductWorkspace({
  projectId,
  space,
  entries,
  decisions,
  signalRuns,
  canWrite,
}: {
  projectId: string;
  space: KbSpace;
  entries: KbEntry[];
  decisions: KbDecision[];
  signalRuns: Record<string, string>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [creating, setCreating] = useState<"R" | "D" | null>(null);
  const [hood, setHood] = useState<Neighborhood | null>(null);

  const byArtifactId = useMemo(() => {
    const map = new Map<string, KbEntry>();
    for (const entry of entries) map.set(artifactIdFor(entry), entry);
    return map;
  }, [entries]);

  const chain = chainIdFromConfig(space.config);
  const sections = useMemo(() => groupSections(entries, chain), [entries, chain]);
  const doc = searchParams.get("doc") ?? "active";
  const isPin = doc === "charter" || doc === "active";
  const entry = isPin ? null : (byArtifactId.get(doc) ?? null);

  const navigate = useCallback(
    (next: string) => {
      setCreating(null);
      const target = next === "CHARTER" ? "charter" : next === "ACTIVE" ? "active" : next;
      router.replace(`?doc=${encodeURIComponent(target)}`, { scroll: false });
    },
    [router],
  );

  const selectedEntryIdRef = useRef<string | null>(null);
  const refreshHood = useCallback((entryId: string) => {
    void fetchNeighborhood(entryId).then((res) => {
      // A late response for a page we already left must not win.
      if (res.ok && selectedEntryIdRef.current === entryId) setHood(res.data);
    });
  }, []);

  // Neighborhood powers the links panel + decision chains; fetched per entry
  // and re-fetched after every save (cites add/remove graph links).
  useEffect(() => {
    selectedEntryIdRef.current = entry?.id ?? null;
    setHood(null);
    if (!entry) return;
    refreshHood(entry.id);
  }, [entry, refreshHood]);

  let page: React.ReactNode;
  if (creating) {
    page = (
      <div className="h-full min-h-0 overflow-y-auto p-5">
        <div className="flex flex-col gap-3">
          <span className="text-[12.5px] font-medium text-(--dim)">
            new {creating === "D" ? "decision" : "documentation page"}
          </span>
          <NewEntry
            projectId={projectId}
            type={creating}
            chain={chain}
            entries={entries}
            onCreated={(artifactId) => {
              setCreating(null);
              navigate(artifactId);
            }}
            onCancel={() => setCreating(null)}
          />
        </div>
      </div>
    );
  } else if (isPin) {
    const which = doc as "charter" | "active";
    const raw = which === "charter" ? space.charterMd : space.activeMd;
    const { frontmatter, body } = splitFrontmatter(raw);
    const docUpdated =
      (which === "charter" ? space.charterUpdatedAt : space.activeUpdatedAt) ?? space.updatedAt;
    const monoId = which.toUpperCase();
    const cites = [...referencedIds(raw)]
      .filter((id) => byArtifactId.has(id))
      .map((id) => {
        const target = byArtifactId.get(id) as KbEntry;
        return { key: id, ref: id, label: target.slug.replaceAll("-", " ") };
      });
    const citedBy = entries
      .filter((candidate) => referencedIds(candidate.bodyMd).has(monoId))
      .map((candidate) => ({
        key: candidate.id,
        ref: artifactIdFor(candidate),
        label: candidate.slug.replaceAll("-", " "),
      }));
    page = (
      <ArtifactPage
        key={which}
        docKey={which}
        meta={{
          typeLabel: "resource",
          artifactId: monoId,
          createdAt: space.createdAt ?? null,
          updatedAt: docUpdated ?? null,
        }}
        body={body}
        readOnly={!canWrite}
        placeholder={
          which === "charter"
            ? "the product charter — what this project is and why"
            : "the active working state — what's true right now"
        }
        onSave={async (md) => {
          const res = await saveSpace(
            projectId,
            which === "charter" ? { charterMd: frontmatter + md } : { activeMd: frontmatter + md },
          );
          if (!res.ok) return { ok: false, message: res.error.message };
          router.refresh();
          return { ok: true };
        }}
        linkGroups={[
          { label: "references", items: cites },
          { label: "referenced by", items: citedBy },
        ]}
        versionsUrl={`/api/v1/projects/${projectId}/kb/space/versions?doc=${which}`}
        onNavigate={navigate}
      />
    );
  } else if (entry) {
    const { frontmatter, body } = splitFrontmatter(entry.bodyMd);
    const linkGroups: PanelLinkGroup[] = [
      { label: "supersedes", relation: "supersedes" as const },
      { label: "superseded by", relation: "superseded-by" as const },
      { label: "links", relation: "linked" as const },
    ].map((group) => ({
      label: group.label,
      items: (hood?.linked ?? [])
        .filter((neighbor) => neighbor.relation === group.relation)
        .map((neighbor) => ({
          key: neighbor.id,
          ref: neighbor.artifactId,
          label: neighbor.slug.replaceAll("-", " "),
        })),
    }));
    page = (
      <ArtifactPage
        key={entry.id}
        docKey={entry.id}
        meta={{
          typeLabel: typeLabelFor(entry.type, chain),
          artifactId: artifactIdFor(entry),
          status: entry.status,
          createdAt: entry.createdAt ?? null,
          updatedAt: entry.updatedAt ?? null,
        }}
        body={body}
        readOnly={!canWrite}
        onSave={async (md) => {
          const res = await patchEntry(entry.id, { bodyMd: frontmatter + md });
          if (!res.ok) return { ok: false, message: res.error.message };
          refreshHood(entry.id);
          router.refresh();
          return { ok: true };
        }}
        aboutRows={aboutRowsFor(entry, projectId, signalRuns[entry.id] ?? null)}
        linkGroups={linkGroups}
        versionsUrl={`/api/v1/kb/entries/${entry.id}/versions`}
        onNavigate={navigate}
      />
    );
  } else {
    page = (
      <p className="p-5 text-[12.5px] text-(--dim)">No page selected — pick one from the tree.</p>
    );
  }

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[270px_minmax(0,1fr)]">
      <div className="min-h-0 overflow-y-auto border-r border-(--line) px-4 py-4">
        <NavTree
          sections={sections}
          decisions={decisions}
          selected={creating ? "" : doc}
          canWrite={canWrite}
          chain={chain}
          onSelect={navigate}
          onNew={(type) => setCreating(type)}
        />
      </div>
      <div className="min-h-0 min-w-0">{page}</div>
    </div>
  );
}

/** Type-specific context for the details panel — a Signal's provenance, etc. */
function aboutRowsFor(entry: KbEntry, projectId: string, reviewRunId: string | null): AboutRow[] {
  if (entry.type !== "S") return [];
  const provenance =
    entry.frontmatter.provenance && typeof entry.frontmatter.provenance === "object"
      ? (entry.frontmatter.provenance as Record<string, unknown>)
      : {};
  const source =
    typeof entry.frontmatter.source === "string"
      ? entry.frontmatter.source
      : typeof provenance.source === "string"
        ? (provenance.source as string)
        : null;
  const rows: AboutRow[] = [];
  if (source) rows.push({ label: "source", value: source });
  if (typeof provenance.receivedAt === "string") {
    rows.push({ label: "received", value: fmtStamp(provenance.receivedAt) });
  }
  rows.push(
    reviewRunId
      ? {
          label: "review run",
          value: "open →",
          href: `/projects/${projectId}/sessions/${reviewRunId}`,
        }
      : { label: "review run", value: "none" },
  );
  return rows;
}
