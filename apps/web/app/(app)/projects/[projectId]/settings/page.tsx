import { Divider, Eyebrow, PillTag, StatusDot } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { GatesEditor } from "@/components/project/gates-editor";
import { api } from "@/lib/api";

export const metadata = { title: "project settings" };

function fingerprintTone(status: string): "ok" | "bad" | "machine" {
  if (status === "ok") return "ok";
  if (status === "drifted" || status === "corrupted") return "bad";
  return "machine";
}

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, repos] = await Promise.all([api.project(projectId), api.projectRepos(projectId)]);

  if (!project.ok) {
    return project.offline ? (
      <Offline />
    ) : (
      <ErrorNotice message={`project not found (${project.status})`} />
    );
  }

  const p = project.data;
  const repoList = repos.ok ? repos.data : [];
  const settings = (p.settings ?? {}) as Record<string, unknown>;

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Eyebrow>settings</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
          Project settings
        </h1>
        <p className="text-[12.5px] text-(--dim)">
          {p.slug} · system {p.systemVersion ?? "unpinned"}
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <Eyebrow>repositories</Eyebrow>
        {!repos.ok ? (
          <ErrorNotice message={`Couldn't load repositories — ${repos.message}`} />
        ) : repoList.length === 0 ? (
          <p className="text-sm text-(--dim)">
            No repository connected.{" "}
            <Link href="/projects/new" className="text-(--ink) underline underline-offset-4">
              Kickstart one
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col border border-(--line)">
            {repoList.map((repo) => (
              <div
                key={repo.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--line) px-5 py-4 last:border-b-0"
              >
                <a
                  href={`https://github.com/${repo.owner}/${repo.name}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-(--ink) underline-offset-4 hover:underline"
                >
                  {repo.owner}/{repo.name}
                </a>
                <span className="font-mono text-[11px] text-(--dim)">{repo.defaultBranch}</span>
                <span className="ml-auto inline-flex items-center gap-2 text-[11px] font-medium text-(--mut)">
                  <StatusDot tone={fingerprintTone(repo.fingerprintStatus ?? "unknown")} />
                  fingerprint {repo.fingerprintStatus ?? "unknown"}
                </span>
                {repo.installationId ? (
                  <PillTag>app connected</PillTag>
                ) : (
                  <PillTag>no installation</PillTag>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Divider />

      <section className="flex flex-col gap-4">
        <Eyebrow>gates</Eyebrow>
        <GatesEditor
          projectId={projectId}
          settings={settings}
          builderPlanPolicy={p.builderPlanPolicy ?? "optional"}
        />
      </section>

      <Divider />

      <section className="flex flex-col gap-2">
        <Eyebrow>org-level</Eyebrow>
        <p className="text-sm leading-relaxed text-(--mut)">
          Keys, providers, budgets, and members are managed in{" "}
          <Link href="/settings" className="text-(--ink) underline underline-offset-4">
            org settings
          </Link>
          . Agents, skills, and schedules live in the{" "}
          <Link href="/harness" className="text-(--ink) underline underline-offset-4">
            harness
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
