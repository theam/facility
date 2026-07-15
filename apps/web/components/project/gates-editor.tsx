"use client";

import { Button, Field, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Settings = Record<string, unknown> & {
  default_branch?: string;
  provision_cmd?: string;
  check_cmds?: string[];
};

/**
 * The project's acceptance gates — what the control-plane lane runs after the agent
 * finishes and what kickstart detected. One command per line.
 */
export function GatesEditor({ projectId, settings }: { projectId: string; settings: Settings }) {
  const router = useRouter();
  const [branch, setBranch] = useState(settings.default_branch ?? "main");
  const [provision, setProvision] = useState(settings.provision_cmd ?? "");
  const [checks, setChecks] = useState((settings.check_cmds ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const nextSettings: Settings = {
        ...settings,
        default_branch: branch.trim() || "main",
        provision_cmd: provision.trim() || undefined,
        check_cmds: checks
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      };
      const res = await fetch(`/api/v1/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: nextSettings }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setNote("saved");
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex max-w-xl flex-col gap-5">
      <Field label="default branch">
        <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
      </Field>
      <Field label="provision command" hint="Runs once before the agent starts.">
        <TextInput
          value={provision}
          onChange={(e) => setProvision(e.target.value)}
          placeholder="pnpm install"
        />
      </Field>
      <Field
        label="acceptance gates"
        hint="One command per line. The control plane runs these after the agent finishes; failures mark the session."
      >
        <textarea
          value={checks}
          onChange={(e) => setChecks(e.target.value)}
          rows={4}
          className="w-full border border-(--line) bg-transparent px-3 py-2 font-mono text-[12.5px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
          placeholder={"pnpm lint\npnpm test"}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? "saving…" : "save gates"}
        </Button>
        {note ? <span className="font-mono text-[11px] text-(--dim)">{note}</span> : null}
      </div>
    </form>
  );
}
