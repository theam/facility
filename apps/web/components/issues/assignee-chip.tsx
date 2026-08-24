"use client";

import Image from "next/image";
import { useState } from "react";
import { assigneeInitial, githubAvatarUrl } from "@/lib/pipeline";

export function AssigneeChip({ login }: { login: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-(--dim)">
      {broken ? (
        <span className="grid size-4 place-items-center rounded-full border border-(--line) text-[9px] text-(--mut)">
          {assigneeInitial(login)}
        </span>
      ) : (
        <Image
          src={githubAvatarUrl(login)}
          alt=""
          width={16}
          height={16}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="size-4 rounded-full border border-(--line)"
        />
      )}
      @{login}
    </span>
  );
}
