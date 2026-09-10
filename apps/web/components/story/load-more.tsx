"use client";

import { Button } from "@facility/ui";

export type LoadState = "idle" | "loading" | "error" | "end";

/** The footer of a paged list: one clear state at a time, always keyboard reachable. */
export function LoadMore({
  state,
  label,
  endLabel,
  error,
  onLoad,
}: {
  state: LoadState;
  label: string;
  endLabel: string;
  error?: string;
  onLoad: () => void;
}) {
  if (state === "end") return <p className="text-[11.5px] text-(--dim)">{endLabel}</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={onLoad} disabled={state === "loading"}>
        {state === "loading" ? "loading…" : state === "error" ? "try again" : label}
      </Button>
      {state === "error" ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          {error ?? "Could not load more."}
        </p>
      ) : null}
    </div>
  );
}
