"use client";

import { cx } from "@facility/ui";
import Image from "next/image";

/**
 * Renders a single assignee avatar with GitHub avatar URL and initial-letter fallback.
 * The avatar is a link to the GitHub profile.
 */
function AssigneeAvatar({ login }: { login: string }) {
  const avatarUrl = `https://github.com/${login}.png?size=40`;
  const initial = login.charAt(0).toUpperCase();

  return (
    <a
      href={`https://github.com/${login}`}
      target="_blank"
      rel="noreferrer"
      title={`@${login} on GitHub`}
      className="relative flex-shrink-0"
      aria-label={`@${login} on GitHub`}
    >
      <Image
        src={avatarUrl}
        alt=""
        width={20}
        height={20}
        unoptimized
        referrerPolicy="no-referrer"
        className={cx(
          "size-5 rounded-full border border-(--line)",
          "transition-opacity duration-150",
        )}
        onError={(e) => {
          // Fallback to initial letter when GitHub avatar fails to load
          e.currentTarget.style.display = "none";
          (
            e.currentTarget.parentElement?.querySelector("[data-assignee-initial]") as HTMLElement
          )?.style.setProperty("display", "flex");
        }}
      />
      <span
        data-assignee-initial
        className={cx(
          "absolute inset-0 flex items-center justify-center rounded-full border border-(--line) bg-(--bg-subtle) font-mono text-[10px] font-medium text-(--ink)",
          "hidden",
        )}
      >
        {initial}
      </span>
    </a>
  );
}

/**
 * Renders assignees for a story.
 * - First assignee shows avatar + @login
 * - Additional assignees show as "+N" with avatar stack on hover
 * - Unassigned renders nothing
 */
export function Assignees({ assignees }: { assignees: string[] }) {
  if (!assignees || assignees.length === 0) return null;

  const first = assignees[0]!;
  const rest = assignees.slice(1);
  const restCount = rest.length;

  return (
    <span className="flex items-center gap-1.5">
      {/* First assignee: avatar + @login */}
      <span className="flex items-center gap-1">
        <AssigneeAvatar login={first} />
        <span className="font-mono text-[11px] text-(--dim)">@{first}</span>
      </span>

      {/* Additional assignees: +N with avatar stack on hover */}
      {restCount > 0 && (
        <span className="relative flex items-center gap-1">
          <span className="font-mono text-[11px] text-(--dim)">+{restCount}</span>
          {/* Avatar stack tooltip */}
          <span
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex gap-[-6px] opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100"
            role="tooltip"
          >
            {rest.slice(0, 3).map((login) => (
              <AssigneeAvatar key={login} login={login} />
            ))}
            {rest.length > 3 && (
              <span
                className={cx(
                  "flex size-5 items-center justify-center rounded-full border border-(--line) bg-(--bg-subtle) font-mono text-[10px] font-medium text-(--dim)",
                )}
              >
                +{rest.length - 3}
              </span>
            )}
            <span className="absolute bottom-[-4px] left-1/2 -translate-x-1/2 border-4 border-transparent border-t-(--bg)"></span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Compact assignees for dense rows - just avatar + @login for first, +N for rest
 */
export function CompactAssignees({ assignees }: { assignees: string[] }) {
  if (!assignees || assignees.length === 0) return null;

  const first = assignees[0]!;
  const restCount = assignees.length - 1;

  return (
    <span className="flex items-center gap-1">
      <AssigneeAvatar login={first} />
      <span className="font-mono text-[11px] text-(--dim)">@{first}</span>
      {restCount > 0 && <span className="font-mono text-[11px] text-(--dim)">+{restCount}</span>}
    </span>
  );
}