"use client";

import type { ProjectBudget } from "@facility/sdk";
import { Button, Field, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BudgetForm({ projectId, budget }: { projectId: string; budget: ProjectBudget }) {
  const router = useRouter();
  const [limit, setLimit] = useState(
    budget.monthly_limit_cents === null ? "" : String(budget.monthly_limit_cents / 100),
  );
  const [warning, setWarning] = useState(String(budget.warning_percent ?? 80));
  const [enabled, setEnabled] = useState(budget.id ? budget.enabled : true);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const amount = Number(limit);
    const warningPercent = Number(warning);
    if (
      !Number.isFinite(amount) ||
      amount < 0 ||
      !Number.isInteger(warningPercent) ||
      warningPercent < 1 ||
      warningPercent > 100
    ) {
      setState("error");
      setMessage("Enter a non-negative monthly limit and a whole warning percentage.");
      return;
    }
    setState("saving");
    setMessage("");
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/budget`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        monthly_limit_cents: Math.round(amount * 100),
        warning_percent: warningPercent,
        enabled,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setState("error");
      setMessage(payload?.error?.message ?? "The budget could not be saved.");
      return;
    }
    setState("saved");
    setMessage("Budget saved.");
    router.refresh();
  }

  return (
    <form
      onSubmit={save}
      className="grid gap-4 border border-(--line) bg-(--bg-subtle) p-5 sm:grid-cols-3"
    >
      <Field label="Monthly limit (USD)">
        <TextInput
          inputMode="decimal"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          placeholder="250.00"
          required
        />
      </Field>
      <Field label="Warn at (%)">
        <TextInput
          inputMode="numeric"
          value={warning}
          onChange={(event) => setWarning(event.target.value)}
          required
        />
      </Field>
      <div className="flex flex-col justify-end gap-3">
        <label className="flex items-center gap-2 text-[12px] text-(--mut)">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enforce for new turns
        </label>
        <Button type="submit" disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : "Save budget"}
        </Button>
      </div>
      {message ? (
        <p
          className={
            state === "error"
              ? "text-sm text-(--bad) sm:col-span-3"
              : "text-sm text-(--ok) sm:col-span-3"
          }
          role={state === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
