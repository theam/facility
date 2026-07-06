import { Eyebrow, PillTag } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "harness" };

const KINDS = [
  "skill",
  "rule",
  "agent_contract",
  "harness",
  "guard",
  "module",
  "template_set",
  "standard_section",
] as const;

/**
 * The harness defines how well the factory implements, verifies, and
 * researches: skills, rules, contracts, guards. Read view for now — item
 * detail, version diffs, and draft→publish editing land with P4.
 */
export default async function HarnessPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  const registry = await api.registry(kind ? `?kind=${kind}` : "");
  if (!registry.ok)
    return registry.offline ? <Offline /> : <ErrorNotice message={registry.message} />;

  const items = registry.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>harness</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Harness</h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          {items.length} published item{items.length === 1 ? "" : "s"}
          {kind ? ` · ${kind.replace("_", " ")}` : ""} · immutable once published
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <a href="/harness">
          <PillTag active={!kind}>all</PillTag>
        </a>
        {KINDS.map((k) => (
          <a key={k} href={`/harness?kind=${k}`}>
            <PillTag active={kind === k}>{k.replace("_", " ")}</PillTag>
          </a>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-(--dim)">Nothing published under this filter yet.</p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-(--line) px-5 py-4 last:border-b-0"
            >
              <span className="font-mono text-[13px] text-(--ink)">{item.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-(--dim)">
                {item.kind} · {item.scope} · v{item.latestVersion}
              </span>
              {item.description ? (
                <span className="w-full text-[12.5px] leading-relaxed text-(--mut) sm:w-auto sm:flex-1">
                  {item.description}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
