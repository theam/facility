"use client";

import { cx } from "@facility/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export type NavProject = { id: string; slug: string };

type NavItem = { href: string; label: string; badge?: number };

/** Org-level destinations — thin by design; the daily loop lives inside a project. */
export function orgNav(inboxCount?: number): NavItem[] {
  return [
    { href: "/projects", label: "projects" },
    { href: "/inbox", label: "inbox", badge: inboxCount },
    { href: "/harness", label: "harness" },
    { href: "/audit", label: "audit" },
    { href: "/settings", label: "settings" },
  ];
}

/** The project world: everything scoped to the project in focus. */
export function projectNav(projectId: string): NavItem[] {
  const base = `/projects/${projectId}`;
  return [
    { href: base, label: "overview" },
    { href: `${base}/issues`, label: "issues" },
    { href: `${base}/sessions`, label: "sessions" },
    { href: `${base}/settings`, label: "settings" },
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
              "group flex items-baseline gap-3 border-l-2 px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.18em] transition-colors",
              active
                ? "border-(--line-strong) text-(--ink)"
                : "border-transparent text-(--mut) hover:text-(--ink)",
            )}
          >
            <span className={cx("text-[10px]", active ? "text-(--ink)" : "text-(--dim)")}>
              {String(i + 1).padStart(2, "0")}
            </span>
            {item.label}
            {item.badge ? (
              <span className="ml-auto font-mono text-[10px] text-(--human)">{item.badge}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-5 font-mono text-[9px] uppercase tracking-[0.24em] text-(--dim)">
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
    return <NavLinks items={orgNav(inboxCount)} onNavigate={onNavigate} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <SectionLabel>project</SectionLabel>
        <NavLinks items={projectNav(project.id)} exactFirst onNavigate={onNavigate} />
      </div>
      <div className="flex flex-col gap-2">
        <SectionLabel>org</SectionLabel>
        <NavLinks items={orgNav(inboxCount)} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function FacilityMark() {
  return (
    <span
      aria-hidden
      className="relative h-8 w-8 shrink-0 overflow-hidden rounded-[1.5px] bg-(--card)"
    >
      <span className="absolute left-1 right-1 top-1/2 h-px -translate-y-1/2 bg-(--machine)" />
      <span className="absolute left-[9px] top-2 h-4 w-px bg-(--ink)" />
      <span className="absolute right-[9px] top-2 h-4 w-px bg-(--ink)" />
      <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-(--accent)" />
    </span>
  );
}

function FooterSignature({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cx("flex items-center gap-3 px-5", compact && "items-start")}>
      <FacilityMark />
      <p className="font-mono text-[10px] leading-relaxed text-(--dim)">
        An initiative by{" "}
        <a
          href="https://theagilemonkeys.com"
          className="underline-offset-4 hover:text-(--mut) hover:underline"
        >
          The Agile Monkeys
        </a>
      </p>
    </div>
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
          <FooterSignature compact />
        </div>
      ) : null}
    </div>
  );
}
