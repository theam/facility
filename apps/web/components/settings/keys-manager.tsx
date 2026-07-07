"use client";

import { Button, Field, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApiKey, Role } from "@/lib/api";

/**
 * Issue and revoke API keys. The secret is shown exactly once, on creation —
 * the server only ever stores its hash.
 */
export function KeysManager({ keys, roles }: { keys: ApiKey[]; roles: Role[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, roleId }),
      });
      const body = (await res.json().catch(() => null)) as {
        secret?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.secret)
        throw new Error(body?.error?.message ?? `failed (${res.status})`);
      setIssued(body.secret);
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const key = keys.find((item) => item.id === id);
    setRevokingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `revoke failed (${res.status})`);
      }
      setPendingRevokeId(null);
      setRevokedIds((current) => new Set(current).add(id));
      setNotice(`revoked ${key?.name ?? "key"}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke failed");
    } finally {
      setRevokingId(null);
    }
  }

  const live = keys.filter((k) => !k.revokedAt && !revokedIds.has(k.id));

  return (
    <div className="flex flex-col gap-5">
      {issued ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-2 border border-(--line-strong) bg-(--bg-subtle) p-4"
        >
          <span className="text-[12px] font-medium text-(--ink)">copy this now — shown once</span>
          <code className="break-all font-mono text-[13px] text-(--ink)">{issued}</code>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="self-start text-[12px] font-medium text-(--mut) hover:text-(--ink)"
          >
            dismiss
          </button>
        </div>
      ) : null}

      <form onSubmit={issue} className="flex flex-wrap items-end gap-3">
        <Field label="new key name" className="min-w-0 flex-1">
          <TextInput
            required
            name="key-name"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ci-pipeline"
          />
        </Field>
        <Field label="role">
          <Select name="key-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !name || !roleId}>
          {busy ? "issuing…" : "issue key"}
        </Button>
      </form>
      {notice ? (
        <p role="status" aria-live="polite" className="font-mono text-[11px] text-(--ok)">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" aria-live="assertive" className="font-mono text-[11px] text-(--bad)">
          {error}
        </p>
      ) : null}

      {live.length === 0 ? (
        <p className="text-sm text-(--dim)">No active keys.</p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {live.map((k) => (
            <div
              key={k.id}
              className="flex min-w-0 items-center gap-4 border-b border-(--line) px-4 py-3 last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono text-[13px] text-(--ink)">{k.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-(--dim)">
                {k.prefix}…{k.last4}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-(--dim)">{k.scopeType}</span>
              {pendingRevokeId === k.id ? (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  <span className="text-[11.5px] font-medium text-(--bad)">revoke this key?</span>
                  <button
                    type="button"
                    onClick={() => revoke(k.id)}
                    disabled={revokingId !== null}
                    className="text-[12px] font-medium text-(--bad) disabled:opacity-50"
                  >
                    {revokingId === k.id ? "revoking…" : "confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRevokeId(null)}
                    disabled={revokingId !== null}
                    className="text-[12px] font-medium text-(--mut) hover:text-(--ink) disabled:opacity-50"
                  >
                    cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setPendingRevokeId(k.id);
                  }}
                  className="ml-auto text-[12px] font-medium text-(--mut) hover:text-(--bad)"
                >
                  revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
