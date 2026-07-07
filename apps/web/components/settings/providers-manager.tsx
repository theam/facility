"use client";

import { Button, Field, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Provider } from "@/lib/api";

/**
 * Add and remove LLM provider credentials. The secret is sealed server-side on
 * submit and never returned — the list shows only provider/name/base URL.
 */
export function ProvidersManager({ providers }: { providers: Provider[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState("anthropic");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/v1/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          name,
          secret,
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `failed (${res.status})`);
      }
      setName("");
      setBaseUrl("");
      setSecret("");
      setNotice(`added ${provider} credential`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const row = providers.find((item) => item.id === id);
    setDeletingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/providers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `remove failed (${res.status})`);
      }
      setPendingDeleteId(null);
      setRemovedIds((current) => new Set(current).add(id));
      setNotice(`removed ${row?.name ?? "credential"}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "remove failed");
    } finally {
      setDeletingId(null);
    }
  }

  const live = providers.filter((row) => !removedIds.has(row.id));

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <Field label="provider">
          <Select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </Select>
        </Field>
        <Field label="name" className="min-w-0 flex-1">
          <TextInput
            required
            name="provider-name"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="default"
          />
        </Field>
        <Field label="base url (optional)" className="min-w-0 flex-1">
          <TextInput
            type="url"
            inputMode="url"
            name="provider-base-url"
            autoComplete="off"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com/v1"
          />
        </Field>
        <Field label="secret">
          <TextInput
            required
            type="password"
            name="provider-secret"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="sk-…"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !name || !secret}>
          {busy ? "adding…" : "add provider"}
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
        <p className="text-sm text-(--dim)">
          No provider credentials. The gateway can only proxy models once a key is added.
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {live.map((row) => (
            <div
              key={row.id}
              className="flex min-w-0 items-center gap-4 border-b border-(--line) px-4 py-3 last:border-b-0"
            >
              <span className="shrink-0 text-[11px] font-medium text-(--dim)">{row.provider}</span>
              <span className="shrink-0 font-mono text-[13px] text-(--ink)">{row.name}</span>
              {row.baseUrl ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-(--dim)">
                  {row.baseUrl}
                </span>
              ) : null}
              {pendingDeleteId === row.id ? (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  <span className="text-[11.5px] font-medium text-(--bad)">
                    remove this credential?
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    disabled={deletingId !== null}
                    className="text-[12px] font-medium text-(--bad) disabled:opacity-50"
                  >
                    {deletingId === row.id ? "removing…" : "confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDeleteId(null)}
                    disabled={deletingId !== null}
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
                    setPendingDeleteId(row.id);
                  }}
                  className="ml-auto text-[12px] font-medium text-(--mut) hover:text-(--bad)"
                >
                  remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
