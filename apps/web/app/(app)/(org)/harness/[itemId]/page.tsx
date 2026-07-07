import { Eyebrow } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HarnessItemEditor } from "@/components/harness/item-editor";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "harness item" };

export default async function HarnessItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await api.registryItem(itemId);
  if (!item.ok) {
    if (item.offline) return <Offline />;
    if (item.status === 404) notFound();
    return <ErrorNotice message={item.message} />;
  }

  const data = item.data;
  const activeVersion = data.versions.find((v) => v.status === "active");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/harness" className="text-[12px] font-medium text-(--mut) hover:text-(--ink)">
          ← harness
        </Link>
        <Eyebrow>
          {data.kind.replace("_", " ")} · {data.scope}
        </Eyebrow>
        <h1 className="font-mono text-[clamp(20px,2.6vw,28px)] font-semibold tracking-tight">
          {data.name}
        </h1>
        <p className="text-[12.5px] text-(--dim)">
          {data.versions.length} version{data.versions.length === 1 ? "" : "s"} ·{" "}
          {activeVersion ? `v${activeVersion.version} active` : "no active version"} · publish
          supersedes atomically
        </p>
        {data.description ? (
          <p className="max-w-xl text-sm leading-relaxed text-(--mut)">{data.description}</p>
        ) : null}
      </div>

      <HarnessItemEditor item={data} />
    </div>
  );
}
