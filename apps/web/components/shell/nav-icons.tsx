import type { ReactNode } from "react";

export type NavIconName =
  | "activity"
  | "agents"
  | "approvals"
  | "audit"
  | "overview"
  | "product"
  | "projects"
  | "runs"
  | "settings"
  | "skills"
  | "stories";

const shapes: Record<NavIconName, ReactNode> = {
  activity: <path d="M1.5 8h3l1.5-3.5L8.5 11l1.5-3h4.5" />,
  agents: (
    <>
      <rect x="4" y="4" width="8" height="8" />
      <path d="M6 1.5V4m4-2.5V4M6 12v2.5m4-2.5v2.5M1.5 6H4m-2.5 4H4m8-4h2.5M12 10h2.5" />
    </>
  ),
  approvals: (
    <>
      <rect x="2" y="2" width="12" height="12" />
      <path d="m4.5 8 2.25 2.25L11.5 5.5" />
    </>
  ),
  audit: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  overview: (
    <>
      <rect x="2" y="2" width="5" height="12" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </>
  ),
  product: (
    <>
      <path d="M3 1.75h7l3 3v9.5H3z" />
      <path d="M10 1.75v3h3M5.5 7.5h5m-5 3h5" />
    </>
  ),
  projects: (
    <>
      <rect x="2" y="4" width="9" height="9" />
      <path d="M5 4V2h9v9h-3" />
    </>
  ),
  runs: (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" />
      <path d="m4 5.25 2.25 2.25L4 9.75M8.25 10h3.5" />
    </>
  ),
  settings: (
    <>
      <path d="M2 4h3m3 0h6M2 11h7m3 0h2" />
      <rect x="5" y="2.5" width="3" height="3" />
      <rect x="9" y="9.5" width="3" height="3" />
    </>
  ),
  skills: (
    <>
      <path d="M1.5 3.25h4.75C7.22 3.25 8 4.03 8 5v7.75c0-.83-.67-1.5-1.5-1.5h-5z" />
      <path d="M14.5 3.25H9.75C8.78 3.25 8 4.03 8 5v7.75c0-.83.67-1.5 1.5-1.5h5z" />
    </>
  ),
  stories: (
    <>
      <rect x="1.75" y="2" width="3" height="3" />
      <rect x="11.25" y="2" width="3" height="3" />
      <rect x="11.25" y="11" width="3" height="3" />
      <path d="M4.75 3.5h2A2.25 2.25 0 0 1 9 5.75v4.5a2.25 2.25 0 0 0 2.25 2.25M9 7.5h2.25" />
    </>
  ),
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="square"
      strokeLinejoin="miter"
      strokeWidth="1.25"
      viewBox="0 0 16 16"
    >
      {shapes[name]}
    </svg>
  );
}
