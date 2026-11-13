"use client";

import { cx } from "@facility/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NavIcon, type NavIconName } from "./nav-icons";

export type NavProject = { id: string; slug: string; name?: string };

type NavItem = {
  href: string;
  icon: NavIconName;
  label: string;
  badge?: number;
  exact?: boolean;
  aliases?: string[];
};

/** Org mode is the projects dashboard; everything else is the platform beneath it. */
export function orgNav(): NavItem[] {
  return [{ href: "/projects", icon: "projects", label: "Projects" }];
}

/** Cross-project operator surfaces — secondary by design. */
export function orgPlatformNav(): NavItem[] {
  return [{ href: "/settings", icon: "settings", label: "Organization settings" }];
}

/** The project world: everything scoped to the project in focus. */
export function projectNav(projectId: string, _inboxCount?: number): NavItem[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return [
    {
      href: base,
      icon: "approvals",
      label: "Attention",
      exact: true,
      aliases: [`${base}/attention`],
    },
    { href: `${base}/stories`, icon: "stories", label: "Stories" },
  ];
}

export function projectToolsNav(projectId: string): NavItem[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return [
    { href: `${base}/activity`, icon: "activity", label: "Activity" },
    { href: `${base}/insights`, icon: "audit", label: "Insights" },
    { href: `${base}/settings`, icon: "settings", label: "Settings", aliases: [`${base}/agents`] },
  ];
}

function isActive(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  items,
  label = "Primary",
  onNavigate,
  quiet = false,
}: {
  items: NavItem[];
  label?: string;
  onNavigate?: () => void;
  quiet?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col" aria-label={label}>
      {items.map((item) => {
        const active =
          isActive(pathname, item.href, item.exact ?? false) ||
          item.aliases?.some((path) => isActive(pathname, path, false));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cx(
              "group mx-3 flex items-center gap-3 rounded-lg px-3 transition-colors [--focus-offset:-2px]",
              quiet ? "min-h-9 py-1.5 text-[13px]" : "min-h-10 py-2 text-[14px]",
              "pointer-coarse:min-h-11",
              active
                ? "bg-(--bg-subtle) font-medium text-(--ink) shadow-(--shadow-card) ring-1 ring-(--line)"
                : "text-(--mut) hover:bg-(--bg-subtle)/70 hover:text-(--ink)",
            )}
          >
            <NavIcon
              name={item.icon}
              className={cx(
                "size-4 shrink-0 transition-colors",
                active ? "text-(--info)" : "text-(--dim) group-hover:text-(--ink)",
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
    <span className="px-6 text-[11px] font-medium uppercase tracking-[0.08em] text-(--dim)">
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
          <NavLinks
            items={orgPlatformNav()}
            label="Organization settings"
            onNavigate={onNavigate}
          />
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
        className="mx-3 flex min-h-9 items-center gap-2 rounded-lg px-3 text-[13px] text-(--mut) transition-colors hover:bg-(--bg-subtle)/70 hover:text-(--ink)"
      >
        <span aria-hidden className="font-mono">
          ←
        </span>
        All projects
      </Link>
      <div className="flex flex-col gap-1">
        <SectionLabel>{project.name ?? project.slug}</SectionLabel>
        <NavLinks items={projectNav(project.id, inboxCount)} onNavigate={onNavigate} />
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel>tools</SectionLabel>
        <NavLinks
          items={projectToolsNav(project.id)}
          label="Project tools"
          onNavigate={onNavigate}
          quiet
        />
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
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between border-r border-(--line) bg-(--card) py-5 lg:flex">
      <div className="flex flex-col gap-8">
        <Link
          href="/"
          className="mx-6 inline-flex min-h-10 self-start items-center font-mono text-[16px] font-semibold tracking-tight"
        >
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
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation closes the modal even when it is initiated outside its links.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (open && !modal.open) modal.showModal();
    else if (!open && modal.open) modal.close();
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", closeOnDesktop);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-(--line) bg-(--bg-subtle)/95 px-5 py-3 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-3">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center font-mono text-[15px] font-semibold tracking-tight"
          >
            facility<span className="text-(--accent)">.</span>
          </Link>
          {project ? (
            <span className="truncate font-mono text-[12px] text-(--mut)">{project.slug}</span>
          ) : null}
        </div>
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Open menu"
          className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-1.5 focus-visible:outline-2 focus-visible:outline-(--info)"
        >
          <span className="h-px w-5 bg-(--ink)" />
          <span className="h-px w-5 bg-(--ink)" />
        </button>
      </div>
      <dialog
        ref={dialog}
        aria-label={project ? "Project navigation" : "Organization navigation"}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"),
          ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onClose={(event) => {
          // A queued close event may arrive after the menu was opened again.
          if (event.currentTarget.open) return;
          setOpen(false);
          if (trigger.current?.getBoundingClientRect().width) trigger.current.focus();
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none flex-col border-0 bg-(--bg) p-0 text-(--ink) open:flex"
      >
        <div className="flex items-center justify-between gap-3 border-b border-(--line) px-5 py-3">
          <p className="min-w-0 break-words text-sm">
            {project?.name ?? project?.slug ?? "Facility"}
          </p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="min-h-11 shrink-0 px-3 text-sm underline focus-visible:outline-2 focus-visible:outline-(--info)"
          >
            Close menu
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto py-5">
          <NavSections
            project={project}
            inboxCount={inboxCount}
            onNavigate={() => setOpen(false)}
          />
          <FooterSignature />
        </div>
      </dialog>
    </div>
  );
}
