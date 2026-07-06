"use client";

import { Button, cx, PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentDef } from "@/lib/api";

type ScheduleTrigger = { type: "schedule"; config?: { cron?: string; timezone?: string } };

function scheduleOf(agent: AgentDef): { cron: string; timezone?: string } | null {
  const trigger = agent.triggers.find((t) => (t as { type?: string }).type === "schedule") as
    | ScheduleTrigger
    | undefined;
  const cron = trigger?.config?.cron;
  return cron ? { cron, timezone: trigger?.config?.timezone } : null;
}

function modelOf(agent: AgentDef): string {
  const model = (agent.model as { model?: unknown }).model;
  return typeof model === "string" ? model : "default";
}

/**
 * One agent of the project's harness: engine, model, schedule, permissions,
 * enabled — all editable in place (the prompt/contract is a harness item and
 * links to its draft→publish editor).
 */
export function AgentRow({ projectId, agent }: { projectId: string; agent: AgentDef }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(modelOf(agent) === "default" ? "" : modelOf(agent));
  const [cron, setCron] = useState(scheduleOf(agent)?.cron ?? "");
  const [permissions, setPermissions] = useState(agent.permissions.join(" "));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const schedule = scheduleOf(agent);

  async function patch(body: Record<string, unknown>, doneNote: string) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(payload?.error?.message ?? `save failed (${res.status})`);
      setNote(doneNote);
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const nextTriggers = (() => {
      const others = agent.triggers.filter((t) => (t as { type?: string }).type !== "schedule");
      const trimmed = cron.trim();
      if (!trimmed) return others;
      const existing = scheduleOf(agent);
      return [
        ...others,
        {
          type: "schedule",
          config: { cron: trimmed, ...(existing?.timezone ? { timezone: existing.timezone } : {}) },
        },
      ];
    })();
    void patch(
      {
        model: model.trim() ? { ...agent.model, model: model.trim() } : agent.model,
        triggers: nextTriggers,
        permissions: permissions.split(/[\s,]+/).filter(Boolean),
      },
      "saved",
    );
  }

  return (
    <div className="flex flex-col border-b border-(--line) last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-left transition-colors hover:bg-(--card)"
        aria-expanded={open}
      >
        <StatusDot tone={agent.enabled ? "ok" : "machine"} />
        <span className="font-mono text-[13.5px] text-(--ink)">{agent.name}</span>
        <span className="font-mono text-[11px] text-(--dim)">{agent.engine}</span>
        <span className="font-mono text-[11px] text-(--mut)">{modelOf(agent)}</span>
        {schedule ? <PillTag>cron {schedule.cron}</PillTag> : null}
        {!agent.enabled ? <PillTag>disabled</PillTag> : null}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-(--dim)">
          {open ? "close" : "edit"}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-(--line) bg-(--bg-subtle) px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                model
              </span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="engine default"
                className="border border-(--line) bg-transparent px-3 py-2 font-mono text-[12.5px] text-(--ink) outline-none placeholder:text-(--dim)"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                schedule (cron, UTC) — empty disables
              </span>
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 6 * * *"
                className="border border-(--line) bg-transparent px-3 py-2 font-mono text-[12.5px] text-(--ink) outline-none placeholder:text-(--dim)"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
              permissions — space-separated; you can only grant what you hold
            </span>
            <input
              value={permissions}
              onChange={(e) => setPermissions(e.target.value)}
              placeholder="kb:write tasks:write hitl:write"
              className="border border-(--line) bg-transparent px-3 py-2 font-mono text-[12.5px] text-(--ink) outline-none placeholder:text-(--dim)"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="primary" tone="agent" disabled={busy} onClick={save}>
              {busy ? "saving…" : "save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void patch({ enabled: !agent.enabled }, agent.enabled ? "disabled" : "enabled")
              }
            >
              {agent.enabled ? "disable" : "enable"}
            </Button>
            <Link
              href={`/harness/${agent.contractItemId}`}
              className={cx(
                "font-mono text-[11px] uppercase tracking-[0.16em] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline",
              )}
            >
              edit prompt (contract) →
            </Link>
            {agent.harnessItemId ? (
              <Link
                href={`/harness/${agent.harnessItemId}`}
                className="font-mono text-[11px] uppercase tracking-[0.16em] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
              >
                harness item →
              </Link>
            ) : null}
            {note ? <span className="font-mono text-[11px] text-(--dim)">{note}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
