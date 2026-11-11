"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { clientApi } from "@/lib/client-api";

export function DevelopmentBranch({
  projectId,
  branch,
  defaultBranch,
  canWrite,
}: {
  projectId: string;
  branch: string | null;
  defaultBranch: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(branch ?? "");
  const [saved, setSaved] = useState(branch ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function save() {
    setPending(true);
    setError("");
    setMessage("");
    const developmentBranch = value.trim() || null;
    const result = await clientApi<{ settings: { developmentBranch?: string | null } }>(
      "PATCH",
      `/v1/projects/${encodeURIComponent(projectId)}`,
      {
        developmentBranch,
        idempotency_key: `ui-development-branch-${crypto.randomUUID()}`,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (
      !result.data?.settings ||
      !("developmentBranch" in result.data.settings) ||
      result.data.settings.developmentBranch !== developmentBranch
    ) {
      setError(
        "The server did not confirm this setting. Refresh after the API deployment completes.",
      );
      return;
    }
    setValue(developmentBranch ?? "");
    setSaved(developmentBranch ?? "");
    setMessage(`Development source saved: ${developmentBranch ?? defaultBranch}.`);
    router.refresh();
  }
  return (
    <section className="flex flex-col gap-3">
      <Eyebrow>development branch</Eyebrow>
      <p className="text-sm text-(--mut)">
        Read agents, skills and .facility.yml from this branch of the primary repository. New
        stories and configuration pull requests use the same base. Existing story branches and
        queued or running turns keep their work.
      </p>
      <p className="text-sm text-(--mut)">
        Leave empty to use the GitHub default: <code>{defaultBranch}</code>.
      </p>
      <label htmlFor={id} className="text-sm">
        Branch name
      </label>
      <input
        id={id}
        value={value}
        placeholder={defaultBranch}
        disabled={!canWrite || pending}
        className="border border-(--line) bg-transparent px-3 py-2 font-mono text-sm"
        onChange={(event) => {
          setValue(event.target.value);
          setMessage("");
        }}
      />
      {canWrite && (
        <div>
          <Button size="sm" disabled={pending || value.trim() === saved} onClick={save}>
            {pending ? "saving…" : "save development branch"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
