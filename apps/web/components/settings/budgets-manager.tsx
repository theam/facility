"use client";

import { Button, Field, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Budget } from "@/lib/api";

const money = (cents: number) => `$${(cents / 100).toFixed(0)}`;

/** Org-level budgets: soft warns, hard stops the gateway. */
export function BudgetsManager({ budgets }: { budgets: Budget[] }) {
  const router = useRouter();
  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("monthly");
  const [mode, setMode] = useState<"soft" | "hard">("soft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/v1/budgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "org",
          period,
          mode,
          limitCents: Math.round(Number(limit) * 100),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `failed (${res.status})`);
      }
      setNotice(`added ${mode} ${period} budget of $${Number(limit)}`);
      setLimit("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function patch(b: Budget, body: Record<string, unknown>, ok: string) {
    setRowBusyId(b.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/budgets/${b.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(parsed?.error?.message ?? `failed (${res.status})`);
      }
      setNotice(ok);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setRowBusyId(null);
    }
  }

  async function remove(b: Budget) {
    setRowBusyId(b.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/budgets/${b.id}`, { method: "DELETE" });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(parsed?.error?.message ?? `remove failed (${res.status})`);
      }
      setPendingDeleteId(null);
      setRemovedIds((current) => new Set(current).add(b.id));
      setNotice(`removed ${money(b.limitCents)} / ${b.period} budget`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "remove failed");
    } finally {
      setRowBusyId(null);
    }
  }

  const live = budgets.filter((b) => !removedIds.has(b.id));

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <Field label="limit (usd)">
          <TextInput
            required
            type="number"
            min="0"
            inputMode="decimal"
            name="budget-limit"
            autoComplete="off"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="500"
            className="w-28"
          />
        </Field>
        <Field label="period">
          <Select
            name="budget-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
          >
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </Select>
        </Field>
        <Field label="mode">
          <Select
            name="budget-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="soft">soft — warn</option>
            <option value="hard">hard — stop</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !limit}>
          {busy ? "adding…" : "add budget"}
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
        <p className="text-sm text-(--dim)">No budgets. Spend is uncapped.</p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {live.map((b) => (
            <div
              key={b.id}
              className={`flex min-w-0 items-center gap-4 border-b border-(--line) px-4 py-3 last:border-b-0 ${
                b.enabled ? "" : "opacity-55"
              }`}
            >
              <span className="tabular shrink-0 font-mono text-[13px] text-(--ink)">
                {money(b.limitCents)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-(--dim)">/ {b.period}</span>
              <span
                className="shrink-0 text-[11px] font-medium"
                style={{ color: b.mode === "hard" ? "var(--bad)" : "var(--human)" }}
              >
                {b.mode}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-(--dim)">{b.scope}</span>
              {b.enabled ? null : (
                <span className="shrink-0 text-[11px] font-medium text-(--dim)">disabled</span>
              )}
              {pendingDeleteId === b.id ? (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  <span className="text-[11.5px] font-medium text-(--bad)">
                    remove this budget?
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(b)}
                    disabled={rowBusyId !== null}
                    className="text-[12px] font-medium text-(--bad) disabled:opacity-50"
                  >
                    {rowBusyId === b.id ? "removing…" : "confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDeleteId(null)}
                    disabled={rowBusyId !== null}
                    className="text-[12px] font-medium text-(--mut) hover:text-(--ink) disabled:opacity-50"
                  >
                    cancel
                  </button>
                </div>
              ) : (
                <div className="ml-auto flex shrink-0 items-center gap-4">
                  <button
                    type="button"
                    onClick={() =>
                      patch(
                        b,
                        { enabled: !b.enabled },
                        b.enabled ? "budget disabled" : "budget enabled",
                      )
                    }
                    disabled={rowBusyId !== null}
                    className="text-[12px] font-medium text-(--mut) hover:text-(--ink) disabled:opacity-50"
                  >
                    {b.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setPendingDeleteId(b.id);
                    }}
                    className="text-[12px] font-medium text-(--mut) hover:text-(--bad)"
                  >
                    remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
