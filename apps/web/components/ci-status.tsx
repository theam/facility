import { StatusDot } from "@facility/ui";

type CiState = "pending" | "success" | "failure";

export function CiStatusLink({
  state,
  url,
  failureNames = [],
  className = "",
}: {
  state: CiState;
  url: string;
  failureNames?: string[];
  className?: string;
}) {
  const label = ciStatusLabel(state, failureNames);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={
        state === "failure" && failureNames.length > 3
          ? `checks · failed · ${failureNames.join(", ")}`
          : undefined
      }
      className={`flex items-center gap-2 font-mono text-[11px] text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline ${className}`}
    >
      <StatusDot tone={ciTone(state)} />
      {label}
    </a>
  );
}

export function ciStatusLabel(state: CiState, failureNames: string[] = []) {
  const outcome = state === "success" ? "passed" : state;
  if (state !== "failure" || failureNames.length === 0) return `checks · ${outcome}`;
  const visible = failureNames.slice(0, 3);
  const remaining = failureNames.length - visible.length;
  return `checks · failed · ${visible.join(", ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

function ciTone(state: CiState): "info" | "ok" | "bad" {
  if (state === "success") return "ok";
  if (state === "failure") return "bad";
  return "info";
}
