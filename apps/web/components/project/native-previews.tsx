"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { clientApi } from "@/lib/client-api";

export function NativePreviews({
  projectId,
  enabled,
  available,
  canWrite,
}: {
  projectId: string;
  enabled: boolean;
  available: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [checked, setChecked] = useState(enabled);
  const [saved, setSaved] = useState(enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function save() {
    setPending(true);
    setError("");
    setMessage("");
    const result = await clientApi<{ nativePreviews?: { enabled: boolean } }>(
      "PATCH",
      `/v1/projects/${encodeURIComponent(projectId)}`,
      {
        nativePreviewsEnabled: checked,
        idempotency_key: `ui-native-previews-${crypto.randomUUID()}`,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.data?.nativePreviews?.enabled !== checked) {
      setError(
        "The server did not confirm this setting. Refresh after the API deployment completes.",
      );
      return;
    }
    setSaved(checked);
    setMessage(checked ? "Project opt-in saved." : "Native previews disabled for this project.");
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-3">
      <Eyebrow>native preview URLs</Eyebrow>
      <p className="text-sm text-(--mut)">
        Use the Vercel Sandbox HTTPS URL with Facility login. Disabled by default; applies only to
        this project. These are not anonymous public previews. Existing preview-site configuration
        is unchanged.
      </p>
      <p className="text-sm text-(--mut)">
        Viewers still need previews:read or workspaces:execute. Enabling does not start or upgrade
        workspaces; prepare or wake them with a compatible runner. Disabling denies new native
        requests and hides native URLs from lifecycle integrations. Already-open connections are not
        terminated.
      </p>
      {!available && (
        <p role="note" className="text-sm text-(--mut)">
          Not available on this installation yet. You can save the project preference, but an
          operator must enable FACILITY_NATIVE_PREVIEWS on the Vercel API and worker with a
          compatible runner.
        </p>
      )}
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={!canWrite || pending}
          onChange={(event) => {
            setChecked(event.target.checked);
            setMessage("");
          }}
        />
        Enable native preview URLs for this project
      </label>
      {canWrite && (
        <div>
          <Button size="sm" disabled={pending || checked === saved} onClick={save}>
            {pending ? "saving…" : "save preview settings"}
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
