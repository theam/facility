import { Eyebrow } from "@facility/ui";

/** Honest failure state — never fake data when the control plane is down. */
export function Offline({ detail }: { detail?: string }) {
  // Only a source checkout can act on the dev command; self-hosted operators need the service.
  const localDevelopment = process.env.NODE_ENV !== "production";
  return (
    <div className="flex flex-col items-start gap-4 border border-(--line) bg-(--bg-subtle) p-8">
      <Eyebrow>control plane unreachable</Eyebrow>
      <p className="max-w-md text-sm leading-relaxed text-(--mut)">
        {localDevelopment ? (
          <>
            The web app is up, but the Facility API did not answer
            {detail ? <> ({detail})</> : null}. Start it with{" "}
            <code className="font-mono text-[12.5px] text-(--code)">
              pnpm --filter @facility/api dev
            </code>{" "}
            and reload.
          </>
        ) : (
          <>
            Facility can't reach its API right now{detail ? <> ({detail})</> : null}. Please try
            again in a moment. If the problem continues, contact your Facility administrator.
          </>
        )}
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
