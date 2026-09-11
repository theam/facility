"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { ProjectRepo } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

export function DisconnectRepository({
  projectId,
  repository,
  canWrite,
}: {
  projectId: string;
  repository: Pick<ProjectRepo, "id" | "owner" | "name" | "role">;
  canWrite: boolean;
}) {
  const router = useRouter();
  const confirmationId = useId();
  const requestKey = useRef("");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState("");
  if (!canWrite) return null;
  if (removed)
    return (
      <p role="status" className="text-sm">
        Repository disconnected.
      </p>
    );

  async function disconnect() {
    if (!confirmed || pending) return;
    setPending(true);
    setError("");
    const result = await clientApi(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repository.id)}`,
      { idempotency_key: requestKey.current },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRemoved(true);
    router.refresh();
  }
  return (
    <div
      className={confirming ? "flex basis-full flex-col gap-3 border-t border-(--line) pt-3" : ""}
    >
      {!confirming ? (
        <Button
          size="sm"
          onClick={() => {
            requestKey.current = `ui-disconnect-${crypto.randomUUID()}`;
            setConfirming(true);
            setConfirmed(false);
            setError("");
          }}
        >
          disconnect
        </Button>
      ) : (
        <>
          <p className="text-sm">
            Disconnect{" "}
            <strong>
              {repository.owner}/{repository.name}
            </strong>{" "}
            from this project?
          </p>
          <p className="text-sm text-(--mut)">
            This removes the connection and its synchronized GitHub issue, PR, branch, review and CI
            data. The GitHub repository is not deleted or modified. Retained Facility stories or
            workspaces block disconnection; they are never deleted by this action.
          </p>
          {repository.role === "primary" ? (
            <p className="text-sm text-(--mut)">
              The oldest remaining repository becomes primary. If none remains, the project has no
              connected repository. Review .facility.yml and .agents/ before starting new work.
            </p>
          ) : null}
          <label htmlFor={confirmationId} className="flex items-center gap-2 text-sm">
            <input
              id={confirmationId}
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand the connection and synchronized data will be removed.
          </label>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={!confirmed || pending} onClick={disconnect}>
              {pending ? "disconnecting…" : "confirm disconnect"}
            </Button>
            <Button size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
