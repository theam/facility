import { ButtonLink, Cell, Eyebrow, HairlineGrid, PillTag } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "projects" };

export default async function ProjectsPage() {
  const projects = await api.projects();
  if (!projects.ok) {
    return projects.offline ? <Offline /> : <ErrorNotice message={projects.message} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>projects</Eyebrow>
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Projects</h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-(--mut)">
            Each project connects one or more GitHub repositories to persistent story workspaces.
          </p>
        </div>
        <ButtonLink href="/projects/new" variant="primary">
          connect project
        </ButtonLink>
      </div>

      {projects.data.length === 0 ? (
        <div className="max-w-2xl border border-(--line) p-8">
          <p className="text-sm leading-relaxed text-(--mut)">
            Connect a repository, add <code>.facility.yml</code> and the shared{" "}
            <code>.agents/</code>
            catalog, then start the first story from MCP or this UI.
          </p>
        </div>
      ) : (
        <HairlineGrid cols="sm:grid-cols-2">
          {projects.data.map((project) => (
            <Cell key={project.id} interactive className="p-0">
              <Link
                href={`/projects/${project.id}`}
                className="flex h-full flex-col gap-4 p-6 sm:p-8"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-semibold tracking-tight text-(--ink)">
                      {project.name}
                    </span>
                    <span className="truncate font-mono text-[11px] text-(--dim)">
                      {project.slug}
                    </span>
                  </span>
                  {project.status === "archived" ? <PillTag>archived</PillTag> : null}
                </div>
                <p className="line-clamp-3 flex-1 text-[13px] leading-relaxed text-(--mut)">
                  {project.description ?? "Persistent workspaces and shared agent conversations."}
                </p>
                <span className="font-mono text-[11px] text-(--dim)">open project →</span>
              </Link>
            </Cell>
          ))}
        </HairlineGrid>
      )}
    </div>
  );
}
