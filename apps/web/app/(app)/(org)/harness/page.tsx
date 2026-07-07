import { Eyebrow, PillTag } from "@facility/ui";
import { HarnessList } from "@/components/harness/harness-list";
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
 * researches: skills, rules, contracts, guards — searchable, facetable,
 * and authorable in product.
 */
export default async function HarnessPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  const [registry, projects] = await Promise.all([
    api.registry(kind ? `?kind=${kind}` : ""),
    api.projects(),
  ]);
  if (!registry.ok)
    return registry.offline ? <Offline /> : <ErrorNotice message={registry.message} />;

  const items = registry.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>harness</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Harness</h1>
        <p className="text-[12.5px] text-(--dim)">
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

      <HarnessList
        items={items}
        projects={projects.ok ? projects.data.map((p) => ({ id: p.id, slug: p.slug })) : []}
        activeKind={kind}
      />
    </div>
  );
}
