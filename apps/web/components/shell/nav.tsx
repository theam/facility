"use client";

import { cx } from "@facility/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NavIcon, type NavIconName } from "./nav-icons";

export type NavProject = { id: string; slug: string; name?: string };

type NavItem = { href: string; icon: NavIconName; label: string; badge?: number };

/** Org mode is the projects dashboard; everything else is the platform beneath it. */
export function orgNav(): NavItem[] {
  return [{ href: "/projects", icon: "projects", label: "Projects" }];
}

/** Cross-project operator surfaces — secondary by design. */
export function orgPlatformNav(): NavItem[] {
  return [
    { href: "/sessions", icon: "activity", label: "Activity" },
    { href: "/harness", icon: "skills", label: "Skills & Rules" },
    { href: "/audit", icon: "audit", label: "Audit log" },
    { href: "/settings", icon: "settings", label: "Settings" },
  ];
}

/** The project world: everything scoped to the project in focus. */
export function projectNav(projectId: string, inboxCount?: number): NavItem[] {
  const base = `/projects/${projectId}`;
  return [
    { href: base, icon: "overview", label: "Overview" },
    { href: `${base}/product`, icon: "product", label: "Product Owner" },
    { href: `${base}/stories`, icon: "stories", label: "Stories" },
    { href: `${base}/sessions`, icon: "runs", label: "Runs" },
    {
      href: `${base}/approvals`,
      icon: "approvals",
      label: "Approvals",
      badge: inboxCount,
    },
    { href: `${base}/agents`, icon: "agents", label: "Agents" },
    { href: `${base}/settings`, icon: "settings", label: "Settings" },
  ];
}

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  items,
  exactFirst = false,
  onNavigate,
}: {
  items: NavItem[];
  /** Project nav: the first item (overview) is the section root — match it exactly. */
  exactFirst?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col" aria-label="Primary">
      {items.map((item, i) => {
        const active = isActive(pathname, item.href, exactFirst && i === 0);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cx(
              "group flex items-center gap-3 border-l-2 px-5 py-3.5 text-[13px] transition-colors lg:py-2",
              active
                ? "border-(--line-strong) font-medium text-(--ink)"
                : "border-transparent text-(--mut) hover:text-(--ink)",
            )}
          >
            <NavIcon
              name={item.icon}
              className={cx(
                "size-4 shrink-0 transition-colors",
                active ? "text-(--ink)" : "text-(--dim) group-hover:text-(--ink)",
              )}
            />
            <span className="min-w-0">{item.label}</span>
            {item.badge ? (
              <span className="ml-auto font-mono text-[11px] text-(--human)">{item.badge}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-(--dim)">
      {children}
    </span>
  );
}

function NavSections({
  project,
  inboxCount,
  onNavigate,
}: {
  project?: NavProject;
  inboxCount?: number;
  onNavigate?: () => void;
}) {
  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        <NavLinks items={orgNav()} onNavigate={onNavigate} />
        <div className="flex flex-col gap-2">
          <SectionLabel>platform</SectionLabel>
          <NavLinks items={orgPlatformNav()} onNavigate={onNavigate} />
        </div>
      </div>
    );
  }
  // Project mode: the sidebar belongs to the project. The way out is explicit
  // (back link on top) and the section is titled by the project itself.
  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/projects"
        onClick={onNavigate}
        className="flex items-center gap-2 px-5 text-[12px] text-(--mut) transition-colors hover:text-(--ink)"
      >
        <span aria-hidden className="font-mono">
          ←
        </span>
        Back to all projects
      </Link>
      <div className="flex flex-col gap-2">
        <SectionLabel>{project.name ?? project.slug}</SectionLabel>
        <NavLinks items={projectNav(project.id, inboxCount)} exactFirst onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function FooterSignature() {
  return (
    <p className="px-5 font-mono text-[10px] leading-relaxed text-(--dim)">
      An initiative by{" "}
      <a
        href="https://theagilemonkeys.com"
        className="underline-offset-4 hover:text-(--mut) hover:underline"
      >
        The Agile Monkeys
      </a>
    </p>
  );
}

export function Sidebar({ project, inboxCount }: { project?: NavProject; inboxCount?: number }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col justify-between border-r border-(--line) py-6 lg:flex">
      <div className="flex flex-col gap-8">
        <Link href="/" className="px-5 font-mono text-[15px] font-semibold tracking-tight">
          facility<span className="text-(--accent)">.</span>
        </Link>
        <NavSections project={project} inboxCount={inboxCount} />
      </div>
      <FooterSignature />
    </aside>
  );
}

export function MobileNav({ project, inboxCount }: { project?: NavProject; inboxCount?: number }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes. pathname is the trigger, not
  // a value the body reads — that's exactly the dependency we want here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended change-trigger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-(--line) bg-(--bg)/95 px-5 py-4 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-3">
          <Link href="/" className="font-mono text-[15px] font-semibold tracking-tight">
            facility<span className="text-(--accent)">.</span>
          </Link>
          {project ? (
            <span className="truncate font-mono text-[12px] text-(--mut)">{project.slug}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="flex h-9 w-9 flex-col items-center justify-center gap-1.5"
        >
          <span
            className={cx(
              "h-px w-5 bg-(--ink) transition-transform",
              open && "translate-y-[3.5px] rotate-45",
            )}
          />
          <span
            className={cx(
              "h-px w-5 bg-(--ink) transition-transform",
              open && "-translate-y-[3.5px] -rotate-45",
            )}
          />
        </button>
      </div>
      {open ? (
        <div className="fixed inset-0 top-[57px] z-30 flex flex-col justify-between overflow-y-auto bg-(--bg) pb-8 pt-4">
          <NavSections
            project={project}
            inboxCount={inboxCount}
            onNavigate={() => setOpen(false)}
          />
          <FooterSignature />
        </div>
      ) : null}
    </div>
  );
}
