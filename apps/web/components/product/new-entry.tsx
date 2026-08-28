"use client";

import { Button, Field, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { CrepeEditor } from "@/components/product/crepe-editor";
import { ValidationReportPanel } from "@/components/product/validation-report";
import { artifactIdFor, type KbChainId, type KbEntry, typeLabelsFor } from "@/lib/kb";
import { createEntry, createEntryDry, type DryRunResult } from "@/lib/kb-client";

/**
 * "New page" for a KB section: slug + links + body, validated with the
 * server-side dry run (shows the assigned artifact id + the validator's
 * report) before the real create.
 */
export function NewEntry({
  projectId,
  type,
  chain,
  entries,
  onCreated,
  onCancel,
}: {
  projectId: string;
  /** Section-scoped: R (documentation) or D (decision). */
  type: "R" | "D";
  chain: KbChainId;
  entries: KbEntry[];
  onCreated: (artifactId: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"proposed" | "decided">("proposed");
  const [links, setLinks] = useState<Set<string>>(new Set());
  const markdownRef = useRef("");
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Decisions chain from Signals — surface them first in the links picker.
  const linkCandidates = useMemo(() => {
    const sorted = [...entries].sort((a, b) => {
      if (type === "D") {
        if (a.type === "S" && b.type !== "S") return -1;
        if (b.type === "S" && a.type !== "S") return 1;
      }
      return a.type.localeCompare(b.type) || b.number - a.number;
    });
    return sorted;
  }, [entries, type]);

  function body(): {
    type: string;
    slug: string;
    bodyMd: string;
    status?: string;
    links: string[];
  } {
    return {
      type,
      slug: slug.trim(),
      bodyMd: markdownRef.current,
      ...(type === "D" ? { status } : {}),
      links: [...links],
    };
  }

  async function validate() {
    setBusy(true);
    setNote(null);
    setDry(null);
    const res = await createEntryDry(projectId, body());
    setBusy(false);
    if (!res.ok) {
      setNote(res.error.message);
      return;
    }
    setDry(res.data);
  }

  async function create() {
    setBusy(true);
    setNote(null);
    const res = await createEntry(projectId, body());
    setBusy(false);
    if (!res.ok) {
      setNote(res.error.message);
      return;
    }
    // Creation side-effects parent bodies and the space's ACTIVE — refetch all.
    router.refresh();
    onCreated(artifactIdFor(res.data));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="slug" className="min-w-[240px] flex-1">
          <TextInput
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={type === "D" ? "adopt-postgres-for-x" : "architecture-overview"}
          />
        </Field>
        {type === "D" ? (
          <Field label="status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="proposed">proposed</option>
              <option value="decided">decided</option>
            </Select>
          </Field>
        ) : null}
      </div>

      {linkCandidates.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-(--dim)">
            links{type === "D" ? " · decisions derive from signals" : ""}
          </span>
          <div className="flex max-h-40 flex-col overflow-auto border border-(--line)">
            {linkCandidates.map((candidate) => {
              const id = artifactIdFor(candidate);
              return (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-baseline gap-2 border-b border-(--line) px-3 py-1.5 text-[12px] last:border-b-0 hover:bg-(--card)"
                >
                  <input
                    type="checkbox"
                    checked={links.has(id)}
                    onChange={(e) => {
                      const next = new Set(links);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      setLinks(next);
                    }}
                  />
                  <span className="font-mono text-[10.5px] text-(--dim)">{id}</span>
                  <span className="min-w-0 truncate text-(--mut)">
                    {candidate.slug.replaceAll("-", " ")}
                  </span>
                  <span className="ml-auto text-[10px] text-(--dim)">
                    {typeLabelsFor(chain)[candidate.type] ?? candidate.type}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="min-h-[280px] border border-(--line) bg-(--bg-subtle)">
        <CrepeEditor
          docKey={`new-${type}`}
          value=""
          placeholder="the page body — markdown; cite other pages as [[D001]]"
          onMarkdownChange={(md) => {
            markdownRef.current = md;
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy}
          onClick={() => void validate()}
        >
          {busy ? "validating…" : "validate"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          cancel
        </Button>
        <span className="font-mono text-[10px] text-(--dim)">
          dry run first — shows the assigned id and the validator's verdict
        </span>
        {note ? <span className="font-mono text-[11px] text-(--bad)">{note}</span> : null}
      </div>

      {dry ? (
        <div className="flex flex-col gap-3">
          {dry.entry && dry.report.errors.length === 0 ? (
            <p className="font-mono text-[12px] text-(--mut)">
              will be created as{" "}
              <span className="text-(--ink)">
                {dry.entry.artifactId ?? artifactIdFor(dry.entry)}
              </span>
            </p>
          ) : null}
          <ValidationReportPanel report={dry.report} />
          {dry.report.errors.length === 0 ? (
            <div>
              <Button
                size="sm"
                variant="primary"
                tone="agent"
                disabled={busy}
                onClick={() => void create()}
              >
                {busy ? "creating…" : `create ${type === "D" ? "decision" : "page"}`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
