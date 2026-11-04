import { Divider, Eyebrow, PillTag } from "@facility/ui";
import Link from "next/link";
import { ErrorNotice, Offline } from "@/components/offline";
import { DevelopmentBranch } from "@/components/project/development-branch";
import { DisconnectRepository } from "@/components/project/disconnect-repository";
import { NativePreviews } from "@/components/project/native-previews";
import { WorkflowPolicy } from "@/components/project/workflow-policy";
import { WorkspaceVariables } from "@/components/story/workspace-variables";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";

export const metadata = { title: "project settings" };

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, repos, me, workflow, agents] = await Promise.all([
    api.project(projectId),
    api.projectRepos(projectId),
    api.me(),
    api.projectWorkflowPolicy(projectId),
    api.storyAgents(projectId),
  ]);
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

      {repos.ok && repos.data.find((repo) => repo.role === "primary") && (
        <DevelopmentBranch
          key={`${projectId}-${String(project.data.settings.developmentBranch ?? "")}`}
          projectId={projectId}
          branch={
            typeof project.data.settings.developmentBranch === "string"
              ? project.data.settings.developmentBranch
              : null
          }
          defaultBranch={
            repos.data.find((repo) => repo.role === "primary")?.defaultBranch ?? "main"
          }
          canWrite={
            can(me.ok ? me.data.permissions : [], "projects:write") &&
            can(me.ok ? me.data.permissions : [], "repos:write")
          }
        />
      )}

      {workflow.ok ? (
        <WorkflowPolicy
          key={projectId}
          projectId={projectId}
          initial={workflow.data}
          agents={agents.ok ? agents.data.agents : []}
          catalogError={agents.ok ? undefined : agents.message}
          canWrite={
            can(me.ok ? me.data.permissions : [], "projects:write") &&
            can(me.ok ? me.data.permissions : [], "repos:write")
          }
        />
      ) : (
        <ErrorNotice message={`Workflow policy unavailable: ${workflow.message}`} />
      )}

      <WorkspaceVariables
        projectId={projectId}
        canExecute={can(me.ok ? me.data.permissions : [], "workspaces:execute")}
      />

      <NativePreviews
        key={`${projectId}-${project.data.nativePreviews?.enabled ?? false}`}
        projectId={projectId}
        enabled={project.data.nativePreviews?.enabled ?? false}
        available={project.data.nativePreviews?.available ?? false}
        canWrite={can(me.ok ? me.data.permissions : [], "projects:write")}
      />

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
            {repos.data.map((repo) => (
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
                <PillTag>{repo.role}</PillTag>
                <span className="ml-auto font-mono text-[11px] text-(--dim)">
                  {repo.defaultBranch}
                </span>
                <DisconnectRepository
                  projectId={projectId}
                  repository={repo}
                  canWrite={can(me.ok ? me.data.permissions : [], "repos:write")}
                />
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
          installation access. Workflow policies can require plan approval before native execution;
          they do not narrow an agent’s tools or repository access. GitHub branch protection and
          pull-request review remain the merge boundary.
        </p>
      </section>
    </div>
  );
}
