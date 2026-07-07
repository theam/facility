"use client";

import { Field, Select, TextInput } from "@facility/ui";
import { useMemo, useState } from "react";
import { cronToForm, cronToWords, formToCron, type ScheduleForm } from "@/lib/schedule";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Props = {
  /** Stored cron, or null when the agent has no schedule. */
  value: { cron: string; timezone?: string | null } | null;
  onChange: (next: { cron: string } | null) => void;
  /** Zone the cron is evaluated in (scheduler truth). Display only — preserved by the parent on save. */
  timezone?: string | null;
};

/**
 * Structured schedule editing — frequency + time pickers produce the cron;
 * nobody types cron syntax unless they choose "custom". The words preview is
 * exact by construction for every non-custom shape.
 */
export function ScheduleBuilder({ value, onChange, timezone }: Props) {
  const zone = timezone && timezone !== "UTC" ? timezone : "utc";
  const initial: ScheduleForm | null = useMemo(
    () => (value ? cronToForm(value.cron) : null),
    [value],
  );
  const [form, setForm] = useState<ScheduleForm | null>(initial);

  function update(next: ScheduleForm | null) {
    setForm(next);
    onChange(next ? { cron: formToCron(next) } : null);
  }

  function switchKind(kind: string) {
    if (kind === "none") return update(null);
    if (kind === "hourly") return update({ kind: "hourly", minute: 0 });
    if (kind === "weekly") return update({ kind: "weekly", dow: 1, hour: 6, minute: 0 });
    if (kind === "monthly") return update({ kind: "monthly", dom: 1, hour: 6, minute: 0 });
    if (kind === "custom")
      return update({ kind: "custom", cron: form ? formToCron(form) : "0 6 * * *" });
    return update({ kind: "daily", hour: 6, minute: 0 });
  }

  const timeValue = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  function updateTime(raw: string) {
    const [h, m] = raw.split(":").map((part) => Number(part));
    if (form && form.kind !== "custom" && form.kind !== "hourly") {
      update({
        ...form,
        hour: Number.isFinite(h) ? (h ?? 0) : 0,
        minute: Number.isFinite(m) ? (m ?? 0) : 0,
      });
    }
  }

  const cron = form ? formToCron(form) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="frequency">
          <Select value={form?.kind ?? "none"} onChange={(e) => switchKind(e.target.value)}>
            <option value="none">no schedule</option>
            <option value="hourly">hourly</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
            <option value="custom">custom (cron)</option>
          </Select>
        </Field>

        {form?.kind === "hourly" ? (
          <Field label="at minute">
            <TextInput
              type="number"
              min={0}
              max={59}
              value={form.minute}
              onChange={(e) =>
                update({
                  kind: "hourly",
                  minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)),
                })
              }
            />
          </Field>
        ) : null}

        {form?.kind === "weekly" ? (
          <Field label="day">
            <Select
              value={form.dow}
              onChange={(e) => update({ ...form, dow: Number(e.target.value) })}
            >
              {DOW.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {form?.kind === "monthly" ? (
          <Field label="day of month">
            <TextInput
              type="number"
              min={1}
              max={31}
              value={form.dom}
              onChange={(e) =>
                update({ ...form, dom: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })
              }
            />
          </Field>
        ) : null}

        {form && (form.kind === "daily" || form.kind === "weekly" || form.kind === "monthly") ? (
          <Field label={`time (${zone})`}>
            <TextInput
              type="time"
              value={timeValue(form.hour, form.minute)}
              onChange={(e) => updateTime(e.target.value)}
            />
          </Field>
        ) : null}

        {form?.kind === "custom" ? (
          <Field label={`cron expression (${zone})`} className="sm:col-span-2">
            <TextInput
              value={form.cron}
              onChange={(e) => update({ kind: "custom", cron: e.target.value })}
              placeholder="0 6 * * *"
            />
          </Field>
        ) : null}
      </div>

      {cron ? (
        <p className="font-mono text-[11.5px] text-(--mut)">
          {cronToWords(cron, timezone)}
          <span className="ml-3 text-[10.5px] text-(--dim)">stored as {cron}</span>
        </p>
      ) : (
        <p className="text-[12.5px] text-(--dim)">
          No schedule — the agent runs on demand or when an event routes to it.
        </p>
      )}
    </div>
  );
}
