import { Divider, Eyebrow, PillTag } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "project settings" };

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
      <ErrorNotice message={`Project not found (${project.status})`} />
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Eyebrow>settings</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
          {project.data.name}
        </h1>
        <p className="text-sm leading-relaxed text-(--mut)">
          Repository behavior is configured in <code>.facility.yml</code>. Agent prompts, engines,
          models and triggers are configured together under <code>.agents/</code>.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <Eyebrow>repositories</Eyebrow>
        {!repos.ok ? (
          <ErrorNotice message={`Repositories could not be loaded: ${repos.message}`} />
        ) : repos.data.length === 0 ? (
          <p className="text-sm text-(--dim)">
            No repository connected.{" "}
            <Link href="/projects/new" className="underline">
              Connect one
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col border border-(--line)">
            {repos.data.map((repo, index) => (
              <div
                key={repo.id}
                className="flex flex-wrap items-center gap-3 border-b border-(--line) px-5 py-4 last:border-0"
              >
                <a
                  href={`https://github.com/${repo.owner}/${repo.name}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] underline-offset-4 hover:underline"
                >
                  {repo.owner}/{repo.name}
                </a>
                <PillTag>{index === 0 ? "primary" : "related"}</PillTag>
                <span className="ml-auto font-mono text-[11px] text-(--dim)">
                  {repo.defaultBranch}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Divider />

      <section className="flex flex-col gap-3">
        <Eyebrow>access model</Eyebrow>
        <p className="text-sm leading-relaxed text-(--mut)">
          Every configured agent gets the same full shell, network, Docker, browser and GitHub App
          installation access. There are no per-agent permission profiles or internal approvals.
          GitHub branch protection and pull-request review remain the merge boundary.
        </p>
      </section>
    </div>
  );
}
