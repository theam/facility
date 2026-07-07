"use client";

import { Button, cx, PillTag } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/markdown";

export type KbEntry = {
  id: string;
  type: string;
  number: number;
  slug: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  status: string | null;
  supersedes: string | null;
};

export type KbSpace = {
  charterMd: string;
  activeMd: string;
};

const TYPE_LABELS: Record<string, string> = {
  S: "signals",
  D: "decisions",
  T: "tasks",
  V: "verifications",
  H: "hypotheses",
  E: "experiments",
  F: "findings",
  L: "learnings",
  CR: "change requests",
  SR: "status reports",
};

type Doc = { kind: "charter" } | { kind: "active" } | { kind: "entry"; entry: KbEntry };

/** Display-only: YAML frontmatter is metadata, not prose — never render it raw. */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? md.slice(match[0].length) : md;
}

/**
 * The Owner's knowledge base, readable like a wiki: charter + active pinned,
 * the typed artifact chain grouped and ordered, every entry one click away.
 */
export function KbReader({
  space,
  entries,
  projectId,
  canWrite = false,
}: {
  space: KbSpace;
  entries: KbEntry[];
  projectId: string;
  canWrite?: boolean;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<Doc>({ kind: "active" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const editablePin = doc.kind === "charter" || doc.kind === "active";

  async function saveSpace() {
    setBusy(true);
    setNote(null);
    try {
      const next = {
        charterMd: doc.kind === "charter" ? draft : space.charterMd,
        activeMd: doc.kind === "active" ? draft : space.activeMd,
        config: {},
      };
      const res = await fetch(`/api/v1/projects/${projectId}/kb/space`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setEditing(false);
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const groups = useMemo(() => {
    const byType = new Map<string, KbEntry[]>();
    for (const entry of entries) {
      byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
    }
    for (const list of byType.values()) list.sort((a, b) => b.number - a.number);
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  const selectedEntry = doc.kind === "entry" ? doc.entry : null;
  // Charter/active read live from props even after an edit+refresh; the pinned
  // draft is only used while actively editing.
  const body =
    doc.kind === "charter"
      ? space.charterMd
      : doc.kind === "active"
        ? space.activeMd
        : (selectedEntry?.bodyMd ?? "");

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Knowledge base" className="flex flex-col gap-4">
        <div className="flex flex-col border border-(--line)">
          {(
            [
              { key: "charter", label: "charter" },
              { key: "active", label: "active" },
            ] as const
          ).map((pin) => (
            <button
              key={pin.key}
              type="button"
              onClick={() => setDoc({ kind: pin.key })}
              className={cx(
                "border-b border-(--line) px-4 py-2.5 text-left text-[12.5px] font-medium last:border-b-0 hover:bg-(--card)",
                doc.kind === pin.key ? "bg-(--card) text-(--ink)" : "text-(--mut)",
              )}
            >
              {pin.label}
            </button>
          ))}
        </div>
        {groups.map(([type, list]) => (
          <div key={type} className="flex flex-col gap-1">
            <span className="text-[10.5px] font-medium text-(--dim)">
              {TYPE_LABELS[type] ?? type} · {list.length}
            </span>
            <div className="flex flex-col">
              {list.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setDoc({ kind: "entry", entry })}
                  title={entry.slug}
                  className={cx(
                    "flex items-baseline gap-2 px-2 py-1.5 text-left text-[12.5px] hover:text-(--ink)",
                    selectedEntry?.id === entry.id ? "font-medium text-(--ink)" : "text-(--mut)",
                  )}
                >
                  <span className="shrink-0 font-mono text-[10.5px] text-(--dim)">
                    {entry.type}-{entry.number}
                  </span>
                  <span className="min-w-0 truncate">{entry.slug.replaceAll("-", " ")}</span>
                  {entry.status === "superseded" ? (
                    <span className="text-[9.5px] font-medium text-(--dim)">old</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
        {entries.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-(--dim)">
            No entries yet — the Owner writes them as it works.
          </p>
        ) : null}
      </nav>

      <article className="flex min-w-0 flex-col gap-3">
        {selectedEntry ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-(--ink)">
              {selectedEntry.type}-{selectedEntry.number} · {selectedEntry.slug}
            </span>
            {selectedEntry.status ? <PillTag>{selectedEntry.status}</PillTag> : null}
            {selectedEntry.supersedes ? (
              <span className="font-mono text-[10px] text-(--dim)">
                supersedes {selectedEntry.supersedes}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-medium text-(--dim)">{doc.kind}</span>
            {canWrite && editablePin && !editing ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(body);
                  setEditing(true);
                  setNote(null);
                }}
              >
                edit {doc.kind}
              </Button>
            ) : null}
          </div>
        )}
        {editing && editablePin ? (
          <div className="flex flex-col gap-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={22}
              aria-label={`Edit ${doc.kind}`}
              className="w-full border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[12.5px] leading-relaxed text-(--ink) outline-none focus:border-(--line-strong)"
            />
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="primary"
                tone="agent"
                disabled={busy}
                onClick={() => void saveSpace()}
              >
                {busy ? "saving…" : `save ${doc.kind}`}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
                cancel
              </Button>
              <span className="font-mono text-[10px] text-(--dim)">
                steering the Owner: this is its memory, re-read every session
              </span>
              {note ? <span className="font-mono text-[11px] text-(--bad)">{note}</span> : null}
            </div>
          </div>
        ) : (
          <div className="max-h-[68vh] overflow-auto border border-(--line) bg-(--bg-subtle) p-5">
            {body.trim() ? (
              <Markdown source={stripFrontmatter(body)} />
            ) : (
              <p className="font-mono text-[12.5px] text-(--dim)">(empty)</p>
            )}
          </div>
        )}
      </article>
    </div>
  );
}
