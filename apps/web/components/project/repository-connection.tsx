"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ProjectRepo } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

type Installation = {
  id: string;
  installationId: number;
  connectionName: string | null;
  accountLogin: string;
  suspendedAt: string | null;
  disabledAt: string | null;
};
export function RepositoryConnection({
  projectId,
  repository,
}: {
  projectId: string;
  repository: ProjectRepo;
}) {
  const router = useRouter();
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [selection, setSelection] = useState("");
  const [name, setName] = useState(`${repository.owner}/${repository.name}`);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    void clientApi<Installation[]>("GET", "/v1/github/installations").then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setInstallations(result.data);
      setSelection(
        String(
          result.data.find((item) => item.id === repository.installationId)?.installationId ?? "",
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [editing, repository.installationId]);
  async function save() {
    const parts = name.trim().split("/");
    if (parts.length !== 2 || !parts.every(Boolean)) {
      setError("Use owner/repository.");
      return;
    }
    setPending(true);
    setError("");
    const result = await clientApi(
      "PATCH",
      `/v1/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repository.id)}`,
      {
        installationId: Number(selection),
        owner: parts[0],
        name: parts[1],
        idempotency_key: `connection-${crypto.randomUUID()}`,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditing(false);
    router.refresh();
  }
  if (!editing)
    return (
      <Button size="sm" onClick={() => setEditing(true)}>
        Change GitHub connection
      </Button>
    );
  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-sm text-(--mut)">
        Switch the app used for this repository, including after an organization transfer. Facility
        verifies its GitHub identity and keeps its stories. Existing sandbox checkouts are not
        moved.
      </p>
      <label className="text-sm">
        GitHub connection
        <select
          className="ml-2 rounded-md border border-(--line) bg-(--bg-subtle) p-2"
          value={selection}
          disabled={pending}
          onChange={(event) => setSelection(event.target.value)}
        >
          <option value="">Select a connection</option>
          {installations.map((item) => (
            <option
              key={item.id}
              value={item.installationId}
              disabled={!!item.disabledAt || !!item.suspendedAt}
            >
              {item.connectionName ?? "Instance default"} · {item.accountLogin}
              {item.disabledAt || item.suspendedAt ? " (unavailable)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Repository
        <input
          className="ml-2 rounded-md border border-(--line) bg-(--bg-subtle) p-2"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !selection} onClick={() => void save()}>
          {pending ? "Verifying…" : "Verify and update connection"}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
