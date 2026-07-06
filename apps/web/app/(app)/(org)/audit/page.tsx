import { Eyebrow } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "audit" };

export default async function AuditPage() {
  const audit = await api.audit("?limit=100");
  if (!audit.ok) return audit.offline ? <Offline /> : <ErrorNotice message={audit.message} />;

  const items = audit.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>audit</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Audit log</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          last {items.length} events · append-only · hash-chained
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-(--dim)">No events yet.</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:hidden">
            {items.map((event) => (
              <article key={event.seq} className="border border-(--line) bg-(--bg)">
                <div className="flex items-baseline justify-between gap-4 border-b border-(--line) px-4 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                    seq
                  </span>
                  <span className="tabular font-mono text-[11px] text-(--dim)">{event.seq}</span>
                </div>
                <dl className="grid gap-px bg-(--line)">
                  <div className="flex items-start justify-between gap-4 bg-(--bg) px-4 py-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                      actor
                    </dt>
                    <dd className="text-right font-mono text-[12px] text-(--mut)">
                      {event.actor.name ?? event.actor.id}
                      <span className="ml-2 text-[10px] uppercase text-(--dim)">
                        {event.actor.type}
                      </span>
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4 bg-(--bg) px-4 py-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                      action
                    </dt>
                    <dd className="break-words text-right font-mono text-[12px] text-(--ink)">
                      {event.action}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4 bg-(--bg) px-4 py-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                      target
                    </dt>
                    <dd className="break-all text-right font-mono text-[11px] text-(--dim)">
                      {event.target ? `${event.target.type}/${event.target.id}` : "—"}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4 bg-(--bg) px-4 py-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
                      when
                    </dt>
                    <dd className="text-right font-mono text-[11px] text-(--dim)">
                      {new Date(event.createdAt).toLocaleString()}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto border border-(--line) sm:block">
            <table className="w-full min-w-[640px] border-collapse text-left">
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
                {items.map((event) => (
                  <tr key={event.seq} className="border-b border-(--line) last:border-b-0">
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
        </>
      )}
    </div>
  );
}
