import { Eyebrow } from "@facility/ui";
import type React from "react";
import type { ApiResult } from "@/lib/api";

/** Honest failure state — never fake data when the control plane is down. */
export function Offline({ detail }: { detail?: string }) {
  return (
    <div className="flex flex-col items-start gap-4 border border-(--line) bg-(--bg-subtle) p-8">
      <Eyebrow>control plane unreachable</Eyebrow>
      <p className="max-w-md text-sm leading-relaxed text-(--mut)">
        The web app is up, but the Facility API did not answer
        {detail ? <> ({detail})</> : null}. Start it with{" "}
        <code className="font-mono text-[12.5px] text-(--code)">
          pnpm --filter @facility/api dev
        </code>{" "}
        and reload.
      </p>
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="border border-(--bad)/40 bg-(--bg-subtle) p-6">
      <p className="font-mono text-[12px] text-(--bad)">{message}</p>
    </div>
  );
}

/** Shared fallback for any failed ApiResult: offline vs. real error. */
export function resultFallback(result: ApiResult<unknown>, prefix?: string): React.ReactNode {
  if (result.ok) return null;
  if (result.offline) return <Offline detail={result.message} />;
  return <ErrorNotice message={prefix ? `${prefix}: ${result.message}` : result.message} />;
}
