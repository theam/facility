import { Eyebrow, PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { SyncGithub } from "@/components/pipeline/sync-github";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api } from "@/lib/api";

export const metadata = { title: "pipeline" };

type Stage = "backlog" | "planning" | "building" | "validating" | "review" | "shipped";

const STAGES: Array<{ key: Stage; label: string }> = [
  { key: "backlog", label: "Backlog" },
  { key: "planning", label: "Planning" },
  { key: "building", label: "Building" },
  { key: "validating", label: "Validating" },
  { key: "review", label: "In review" },
  { key: "shipped", label: "Shipped" },
];

export default async function PipelinePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const result = await api.projectPipeline(projectId);
  if (!result.ok) return result.offline ? <Offline /> : <ErrorNotice message={result.message} />;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={15} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>GitHub delivery mirror</Eyebrow>
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Pipeline</h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-(--dim)">
            Issues, pull requests, CI, and their persistent Facility stories in one view.
          </p>
        </div>
        <SyncGithub projectId={projectId} />
      </header>

      <div className="grid gap-4 xl:grid-cols-3 2xl:grid-cols-6">
        {STAGES.map((stage) => (
          <section key={stage.key} className="min-w-0 border border-(--line) bg-(--bg-subtle)">
            <header className="flex items-center justify-between border-b border-(--line) px-4 py-3">
              <Eyebrow>{stage.label}</Eyebrow>
              <span className="font-mono text-[11px] text-(--dim)">
                {result.data.counts[stage.key]}
              </span>
            </header>
            <div className="flex flex-col gap-px bg-(--line)">
              {result.data.stages[stage.key].length === 0 ? (
                <p className="bg-(--bg) px-4 py-6 text-[12px] text-(--dim)">No items</p>
              ) : (
                result.data.stages[stage.key].map((item) => (
                  <article key={item.key} className="bg-(--bg) p-4">
                    <div className="flex items-start gap-2">
                      <StatusDot
                        tone={
                          item.state.includes("failed") ? "bad" : item.story ? "agent" : "machine"
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[13px] font-medium leading-snug hover:underline"
                        >
                          {item.title}
                        </a>
                        <p className="mt-1 font-mono text-[10px] text-(--dim)">
                          {item.repository} #{item.number}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <PillTag>{item.state}</PillTag>
                      {item.story ? (
                        <PillTag>{item.story.activeAgentName ?? item.story.status}</PillTag>
                      ) : null}
                    </div>
                    {item.story ? (
                      <Link
                        href={`/projects/${projectId}/stories/${item.story.id}`}
                        className="mt-3 block text-[11px] text-(--accent) hover:underline"
                      >
                        Open workspace →
                      </Link>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
