"use client";

import { Button, Field, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { providerIdentity } from "@/lib/ai-identity";
import type { Provider } from "@/lib/api";

/**
 * Add and remove LLM provider credentials. The secret is sealed server-side on
 * submit and never returned — the list shows only provider/name/base URL.
 */
export function ProvidersManager({ providers }: { providers: Provider[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState("anthropic");
  const [authMode, setAuthMode] = useState<"api_key" | "oauth">("api_key");
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
    const becomesStandby = providers.some(
      (row) => row.provider === provider && !removedIds.has(row.id),
    );
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
          authMode,
          secret,
          ...(authMode === "api_key" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
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
      const credentialKind = authMode === "oauth" ? "Claude subscription" : "API key";
      const providerLabel = providerIdentity(provider).label;
      setNotice(
        becomesStandby
          ? `added ${providerLabel} ${credentialKind} as standby; remove the active credential to switch`
          : `added ${providerLabel} ${credentialKind} as active`,
      );
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
  const activeIds = new Set<string>();
  for (const providerName of new Set(live.map((row) => row.provider))) {
    const [active] = live
      .filter((row) => row.provider === providerName)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
    if (active) activeIds.add(active.id);
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <Field label="provider">
          <AiIdentity
            identity={providerIdentity(provider)}
            className="mb-2 text-[11px] text-(--dim)"
          />
          <Select
            name="provider"
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              setProvider(next);
              if (next !== "anthropic") setAuthMode("api_key");
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </Select>
        </Field>
        {provider === "anthropic" ? (
          <Field label="authentication">
            <Select
              name="provider-auth-mode"
              value={authMode}
              onChange={(e) => setAuthMode(e.target.value as "api_key" | "oauth")}
            >
              <option value="api_key">API key</option>
              <option value="oauth">Claude subscription</option>
            </Select>
          </Field>
        ) : null}
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
        {authMode === "api_key" ? (
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
        ) : null}
        <Field label={authMode === "oauth" ? "setup token" : "secret"}>
          <TextInput
            required
            type="password"
            name="provider-secret"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={authMode === "oauth" ? "claude setup-token output" : "sk-…"}
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
              <AiIdentity
                identity={providerIdentity(row.provider)}
                className="shrink-0 text-[11px] font-medium text-(--dim)"
              />
              <span className="shrink-0 font-mono text-[10.5px] text-(--dim)">
                {activeIds.has(row.id) ? "active" : "standby"} ·{" "}
                {row.authMode === "oauth" ? "Claude subscription" : "API key"}
              </span>
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
