"use client";

import { Button, cx } from "@facility/ui";
import { useState } from "react";
import type { AuditEvent } from "@/lib/api";

/**
 * The forensic layer over the audit list: row → full-payload drawer, plus the
 * hash-chain verify walk the API always had and the UI never called.
 */
export function AuditExplorer({ events }: { events: AuditEvent[] }) {
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; firstBreakSeq: number | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const selected = events.find((event) => event.seq === openSeq) ?? null;

  async function runVerify() {
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch("/api/v1/audit/verify");
      if (!res.ok) throw new Error(`verify failed (${res.status})`);
      setVerify((await res.json()) as { ok: boolean; firstBreakSeq: number | null });
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "verify failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" disabled={verifying} onClick={() => void runVerify()}>
          {verifying ? "verifying chain…" : "verify hash chain"}
        </Button>
        {verify ? (
          <span
            className={cx(
              "font-mono text-[11px] uppercase tracking-[0.14em]",
              verify.ok ? "text-(--ok)" : "text-(--bad)",
            )}
          >
            {verify.ok ? "chain intact" : `chain breaks at seq ${verify.firstBreakSeq}`}
          </span>
        ) : null}
        {verifyError ? (
          <span className="font-mono text-[11px] text-(--bad)">{verifyError}</span>
        ) : null}
      </div>

      <div className="overflow-x-auto border border-(--line)">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-(--line)">
              {["seq", "actor", "action", "target", "when"].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-(--dim)"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                key={event.seq}
                onClick={() => setOpenSeq(event.seq)}
                className={cx(
                  "cursor-pointer border-b border-(--line) transition-colors last:border-b-0 hover:bg-(--card)",
                  event.seq === openSeq && "bg-(--card)",
                )}
              >
                <td className="tabular px-5 py-3 font-mono text-[11px] text-(--dim)">
                  {event.seq}
                </td>
                <td className="px-5 py-3 font-mono text-[12px] text-(--mut)">
                  {event.actor.name ?? event.actor.id}
                  <span className="ml-2 text-[10px] uppercase text-(--dim)">
                    {event.actor.type}
                  </span>
                </td>
                <td className="px-5 py-3 font-mono text-[12px] text-(--ink)">{event.action}</td>
                <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">
                  {event.target ? `${event.target.type}/${event.target.id}` : "—"}
                </td>
                <td className="px-5 py-3 font-mono text-[11px] text-(--dim)">
                  {new Date(event.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div
          className="fixed inset-0 z-[90] flex justify-end bg-black/50"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpenSeq(null);
          }}
          role="dialog"
          aria-modal="true"
          aria-label={`Audit event ${selected.seq}`}
        >
          <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-(--line) bg-(--bg)">
            <div className="flex items-center justify-between border-b border-(--line) px-6 py-4">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-(--dim)">
                event · seq {selected.seq}
              </span>
              <button
                type="button"
                onClick={() => setOpenSeq(null)}
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-(--mut) hover:text-(--ink)"
              >
                close
              </button>
            </div>
            <div className="flex flex-col gap-5 px-6 py-5">
              <DrawerRow label="action" value={selected.action} strong />
              <DrawerRow
                label="actor"
                value={`${selected.actor.type} · ${selected.actor.name ?? selected.actor.id}`}
              />
              <DrawerRow
                label="target"
                value={selected.target ? `${selected.target.type}/${selected.target.id}` : "—"}
              />
              <DrawerRow label="project" value={selected.projectId ?? "org-wide"} />
              <DrawerRow label="when" value={new Date(selected.createdAt).toISOString()} />
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                  payload
                </span>
                <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap border border-(--line) bg-(--bg-subtle) p-3 font-mono text-[11px] leading-relaxed text-(--mut)">
                  {JSON.stringify(selected.payload ?? {}, null, 2)}
                </pre>
              </div>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                  chain
                </span>
                <p className="break-all font-mono text-[10.5px] leading-relaxed text-(--dim)">
                  prev {selected.prevHash ?? "genesis"}
                  <br />
                  hash {selected.hash}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DrawerRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
        {label}
      </span>
      <span
        className={cx(
          "break-words font-mono text-[12.5px]",
          strong ? "text-(--ink)" : "text-(--mut)",
        )}
      >
        {value}
      </span>
    </div>
  );
}
