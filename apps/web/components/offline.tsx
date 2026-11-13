import { Eyebrow } from "@facility/ui";

/** Honest failure state — never fake data when the control plane is down. */
export function Offline({ detail }: { detail?: string }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-(--line) bg-(--bg-subtle) p-8 shadow-(--shadow-card)">
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
    <div role="alert" className="rounded-xl border border-(--bad)/25 bg-[#fef3f2] px-5 py-4">
      <p className="break-words text-sm text-(--bad)">{message}</p>
    </div>
  );
}
