import { PillTag } from "@facility/ui";
import Image from "next/image";
import { SignOutButton } from "@/components/shell/sign-out";
import { ProjectSwitcher } from "@/components/shell/switcher";
import type { Me, Project } from "@/lib/api";

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
    <header className="hidden items-center justify-between border-b border-(--line) bg-(--bg-subtle) px-8 py-3 lg:flex">
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
          {me.principal.avatarUrl ? (
            <Image
              src={me.principal.avatarUrl}
              alt=""
              width={20}
              height={20}
              unoptimized
              referrerPolicy="no-referrer"
              className="size-5 rounded-full border border-(--line)"
            />
          ) : null}
          {me.principal.githubLogin ? `@${me.principal.githubLogin}` : me.principal.email}
        </span>
        <SignOutButton />
      </div>
    </header>
  );
}
