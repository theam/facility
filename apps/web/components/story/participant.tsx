"use client";

import { cx } from "@facility/ui";
import { useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { engineIdentity, modelIdentity, modelProductLabel } from "@/lib/ai-identity";
import type { StoryMessageAuthor, StoryTurnSummary } from "@/lib/api";
import { authorDescription, initials } from "@/lib/story-presentation";

/** A person or trigger: image when available, initials otherwise, never blank. */
export function Avatar({ author, className }: { author: StoryMessageAuthor; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = author.avatarUrl && !failed ? author.avatarUrl : null;
  return (
    <span
      className={cx(
        "inline-flex size-7 shrink-0 select-none items-center justify-center overflow-hidden border border-(--line) bg-(--card) font-mono text-[10px] font-semibold tracking-wide text-(--human)",
        className,
      )}
      aria-hidden="true"
    >
      {src ? (
        // biome-ignore lint/performance/noImgElement: avatars come from external identity providers
        <img
          src={src}
          alt=""
          width={28}
          height={28}
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(author.name)
      )}
    </span>
  );
}

/** Who asked: avatar, name, and the kind of participant, in words rather than color. */
export function Person({ author }: { author: StoryMessageAuthor }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar author={author} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-(--ink)">{author.name}</span>
        <span className="truncate text-[11px] text-(--mut)">
          {author.handle ? `${author.handle} · ` : ""}
          {authorDescription(author)}
        </span>
      </span>
    </span>
  );
}

/** Which agent answered, with the engine and the model that run actually recorded. */
export function AgentLine({
  name,
  turn,
  reportedModel,
}: {
  name: string;
  turn: StoryTurnSummary | null;
  reportedModel?: string | null;
}) {
  const engine = turn ? engineIdentity(turn.engine) : null;
  const model = turn ? (reportedModel ?? turn.model) : null;
  const modelLabel =
    model && engine?.brand === "claude"
      ? modelProductLabel(model)
      : model
        ? modelIdentity(model).label
        : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className="inline-flex size-7 shrink-0 items-center justify-center border border-(--accent)/60 bg-(--card)"
        aria-hidden="true"
      >
        {engine ? (
          <AiIdentity identity={{ brand: engine.brand, label: "" }} iconClassName="size-4" />
        ) : (
          <span className="font-mono text-[10px] font-semibold text-(--accent)">AI</span>
        )}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-(--ink)">
          <span className="font-mono">{name}</span>{" "}
          <span className="font-normal text-(--mut)">agent</span>
        </span>
        <span className="truncate text-[11px] text-(--mut)">
          {!turn
            ? "Engine and model are recorded when the run starts"
            : `${engine?.label ?? "Engine not recorded"} · ${modelLabel ?? "model not recorded"}`}
        </span>
      </span>
    </span>
  );
}
