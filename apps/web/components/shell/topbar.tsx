import { Avatar, PillTag } from "@facility/ui";
import { SignOutButton } from "@/components/shell/sign-out";
import { ProjectSwitcher } from "@/components/shell/switcher";
import type { Me, Project } from "@/lib/api";
import { avatarInitial } from "@/lib/pipeline";

export function Topbar({
  me,
  projects,
  current,
}: {
  me: Me;
  projects: Pick<Project, "id" | "slug" | "name">[];
  current?: Pick<Project, "id" | "slug" | "name">;
}) {
  return (
    <header className="hidden items-center justify-between border-b border-(--line) px-8 py-3.5 lg:flex">
      <div className="flex min-w-0 items-center gap-3">
        <PillTag>{me.org?.name ?? "Facility"}</PillTag>
        <span className="text-(--dim)">/</span>
        <ProjectSwitcher projects={projects} current={current} />
      </div>
      <div className="flex items-center gap-4">
        <span className="hidden text-[11px] font-medium text-(--dim) xl:inline">⌘K</span>
        <span
          className="flex items-center gap-2 font-mono text-[11px] text-(--dim)"
          title={me.principal.email}
        >
          <Avatar
            size={20}
            src={me.principal.avatarUrl ?? undefined}
            initial={avatarInitial(me.principal.githubLogin ?? me.principal.email)}
          />
          {me.principal.githubLogin ? `@${me.principal.githubLogin}` : me.principal.email}
        </span>
        <SignOutButton />
      </div>
    </header>
  );
}
