import { Eyebrow, PillTag } from "@facility/ui";
import Link from "next/link";
import { IssueCard } from "@/components/inbox/issue-card";
import { ProposalCard } from "@/components/inbox/proposal-card";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, type Outcome } from "@/lib/api";

export const metadata = { title: "inbox" };

function fmtAgo(iso: string | null) {
  if (!iso) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function prUrl(outcome: Outcome) {
  return `https://github.com/${outcome.repo}/pull/${outcome.prNumber}`;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; projectId?: string }>;
}) {
  const [{ focus, projectId }, inbox, outcomes, projects] = await Promise.all([
    searchParams,
    api.inboxFull(),
    api.outcomes("?state=open&limit=50"),
    api.projects(),
  ]);
  if (!inbox.ok) return inbox.offline ? <Offline /> : <ErrorNotice message={inbox.message} />;

  const slugById = new Map((projects.ok ? projects.data : []).map((p) => [p.id, p.slug]));
  const byProject = <T extends { projectId?: string | null }>(items: T[]) =>
    projectId ? items.filter((item) => item.projectId === projectId) : items;

  const proposals = byProject(inbox.data.proposals);
  const issues = byProject(inbox.data.issues);
  const openPrs = byProject(outcomes.ok ? outcomes.data : []);
  const waiting = proposals.length + issues.length + openPrs.length;

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <div className="flex flex-col gap-2">
        <Eyebrow>inbox</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Inbox</h1>
        <p className="text-[12.5px] text-(--dim)">
          {proposals.length} gate{proposals.length === 1 ? "" : "s"} · {openPrs.length} PR
          {openPrs.length === 1 ? "" : "s"} to review · {issues.length} issue
          {issues.length === 1 ? "" : "s"}
        </p>
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-(--mut)">
          Facility decisions and watchtower issues are handled here. Gate 2 remains human validation
          of the live preview, pull-request review, and squash merge in GitHub.
        </p>
      </div>

      {projectId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/inbox">
            <PillTag>all projects</PillTag>
          </Link>
          <PillTag active>{slugById.get(projectId) ?? projectId}</PillTag>
        </div>
      ) : null}

      {waiting === 0 ? (
        <p className="text-sm text-(--dim)">Nothing is waiting on you.</p>
      ) : (
        <div className="flex max-w-3xl flex-col gap-10">
          {openPrs.length > 0 ? (
            <section className="flex flex-col gap-4">
              <Eyebrow>pull requests awaiting review · {openPrs.length}</Eyebrow>
              <div className="flex flex-col border border-(--line)">
                {openPrs.map((outcome) => (
                  <div
                    key={outcome.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--line) px-5 py-3.5 last:border-b-0"
                  >
                    <a
                      href={prUrl(outcome)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[13px] text-(--ink) underline-offset-4 hover:underline"
                    >
                      {outcome.repo}#{outcome.prNumber}
                    </a>
                    <span className="font-mono text-[10.5px] text-(--dim)">
                      {outcome.agentLane}
                    </span>
                    {slugById.get(outcome.projectId) ? (
                      <span className="text-[11px] font-medium text-(--mut)">
                        {slugById.get(outcome.projectId)}
                      </span>
                    ) : null}
                    {outcome.runId ? (
                      <Link
                        href={`/projects/${outcome.projectId}/sessions/${outcome.runId}`}
                        className="font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
                      >
                        session →
                      </Link>
                    ) : null}
                    <span className="ml-auto font-mono text-[11px] text-(--dim)">
                      opened {fmtAgo(outcome.openedAt)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-4">
            <Eyebrow>gates · {proposals.length}</Eyebrow>
            {proposals.length === 0 ? (
              <p className="text-sm text-(--dim)">No decisions waiting.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} focused={p.id === focus} />
                ))}
              </div>
            )}
          </section>

          {issues.length > 0 ? (
            <section className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between">
                <Eyebrow className="text-(--bad)">issues · {issues.length}</Eyebrow>
                <span className="text-[12px] font-medium text-(--dim)">from watchtower</span>
              </div>
              <div className="flex flex-col gap-4">
                {issues.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
