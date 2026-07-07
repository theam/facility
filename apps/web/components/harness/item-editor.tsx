"use client";

import { Button, cx, PillTag } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { RegistryItemWithVersions, RegistryVersion } from "@/lib/api";

/**
 * Read + evolve one harness item. Editing never mutates a published version:
 * "edit" always drafts the next version; publish supersedes atomically (the
 * ratchet stays under the editor UX).
 */
export function HarnessItemEditor({ item }: { item: RegistryItemWithVersions }) {
  const router = useRouter();
  const versions = useMemo(
    () => [...item.versions].sort((a, b) => b.version - a.version),
    [item.versions],
  );
  const active = versions.find((v) => v.status === "active");
  const [selectedId, setSelectedId] = useState<string | null>(
    active?.id ?? versions[0]?.id ?? null,
  );
  const selected = versions.find((v) => v.id === selectedId) ?? null;

  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  function startDraft() {
    setDraftContent(selected?.content ?? "");
    setChangelog("");
    setEditing(true);
    setNote(null);
  }

  async function saveDraft() {
    setBusy("draft");
    setNote(null);
    try {
      const res = await fetch(`/api/v1/registry/items/${item.id}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draftContent, changelog: changelog.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`draft failed (${res.status})`);
      const created = (await res.json()) as RegistryVersion;
      setEditing(false);
      setSelectedId(created.id ?? null);
      setNote(`draft v${created.version} created`);
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "draft failed");
    } finally {
      setBusy(null);
    }
  }

  async function lifecycle(action: "publish" | "deprecate", versionId: string) {
    if (armed !== `${action}:${versionId}`) {
      setArmed(`${action}:${versionId}`);
      return;
    }
    setArmed(null);
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch(`/api/v1/registry/versions/${versionId}/${action}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`${action} failed (${res.status})`);
      setNote(`${action}ed`);
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <span className="text-[11px] font-medium text-(--dim)">versions</span>
        <div className="flex flex-col border border-(--line)">
          {versions.map((version) => (
            <button
              key={version.id}
              type="button"
              onClick={() => {
                setSelectedId(version.id);
                setEditing(false);
                setArmed(null);
              }}
              className={cx(
                "flex items-center gap-3 border-b border-(--line) px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-(--card)",
                version.id === selectedId && "bg-(--card)",
              )}
            >
              <span className="font-mono text-[12.5px] text-(--ink)">v{version.version}</span>
              <PillTag active={version.status === "active"}>{version.status}</PillTag>
              <span className="ml-auto font-mono text-[10px] text-(--dim)">
                {new Date(version.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
          {versions.length === 0 ? (
            <p className="px-4 py-3 text-sm text-(--dim)">No versions yet.</p>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[12px] text-(--mut)">
                v{selected.version} · {selected.status}
                {selected.changelog ? ` · ${selected.changelog}` : ""}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {note ? <span className="font-mono text-[11px] text-(--dim)">{note}</span> : null}
                {!editing ? (
                  <Button size="sm" variant="outline" onClick={startDraft} disabled={busy !== null}>
                    edit as new draft
                  </Button>
                ) : null}
                {selected.status === "draft" ? (
                  <Button
                    size="sm"
                    variant={armed === `publish:${selected.id}` ? "primary" : "outline"}
                    tone={armed === `publish:${selected.id}` ? "agent" : undefined}
                    disabled={busy !== null}
                    onClick={() => void lifecycle("publish", selected.id)}
                  >
                    {armed === `publish:${selected.id}`
                      ? "confirm publish (supersedes active)"
                      : "publish"}
                  </Button>
                ) : null}
                {selected.status === "active" ? (
                  <Button
                    size="sm"
                    variant={armed === `deprecate:${selected.id}` ? "danger" : "outline"}
                    disabled={busy !== null}
                    onClick={() => void lifecycle("deprecate", selected.id)}
                  >
                    {armed === `deprecate:${selected.id}` ? "confirm deprecate" : "deprecate"}
                  </Button>
                ) : null}
                {armed ? (
                  <Button size="sm" variant="outline" onClick={() => setArmed(null)}>
                    cancel
                  </Button>
                ) : null}
              </div>
            </div>

            {editing ? (
              <div className="flex flex-col gap-3">
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  rows={24}
                  className="w-full border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[12.5px] leading-relaxed text-(--ink) outline-none focus:border-(--line-strong)"
                  aria-label="Draft content"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    value={changelog}
                    onChange={(e) => setChangelog(e.target.value)}
                    placeholder="changelog — what changed and why"
                    aria-label="Changelog"
                    className="min-w-0 flex-1 border border-(--line) bg-transparent px-3 py-2 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim)"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    tone="agent"
                    disabled={busy !== null || !draftContent.trim()}
                    onClick={() => void saveDraft()}
                  >
                    {busy === "draft" ? "saving…" : "save draft"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                    discard
                  </Button>
                </div>
              </div>
            ) : (
              <div className="max-h-[70vh] overflow-auto border border-(--line) bg-(--bg-subtle) p-5">
                <Markdown source={selected.content} />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-(--dim)">Select a version.</p>
        )}
      </div>
    </div>
  );
}
