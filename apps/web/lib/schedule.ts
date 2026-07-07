/**
 * Schedules speak human in the chrome (law L4/L7): the UI edits a structured
 * form and displays words; cron is the storage format, shown only as fine
 * print. Parsing is display-only — the scheduler's cron-parser remains the
 * single execution truth (nextRunAt always comes from the API).
 */

export type ScheduleForm =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dow: number; hour: number; minute: number }
  | { kind: "monthly"; dom: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

export function formToCron(form: ScheduleForm): string {
  switch (form.kind) {
    case "hourly":
      return `${form.minute} * * * *`;
    case "daily":
      return `${form.minute} ${form.hour} * * *`;
    case "weekly":
      return `${form.minute} ${form.hour} * * ${form.dow}`;
    case "monthly":
      return `${form.minute} ${form.hour} ${form.dom} * *`;
    case "custom":
      return form.cron.trim();
  }
}

const num = (field: string): number | null => (/^\d{1,2}$/.test(field) ? Number(field) : null);

/** Recover the structured form from a stored cron when it matches a simple shape. */
export function cronToForm(cron: string): ScheduleForm {
  const fields = cron.trim().split(/\s+/);
  if (fields.length === 5) {
    const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
    const minute = num(m);
    const hour = num(h);
    if (minute !== null && h === "*" && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "hourly", minute };
    }
    if (minute !== null && hour !== null && dom === "*" && mon === "*") {
      const dowNum = num(dow === "7" ? "0" : dow);
      if (dow === "*") return { kind: "daily", hour, minute };
      if (dowNum !== null && dowNum <= 6) return { kind: "weekly", dow: dowNum, hour, minute };
    }
    if (minute !== null && hour !== null && mon === "*" && dow === "*") {
      const day = num(dom);
      if (day !== null && day >= 1 && day <= 31) return { kind: "monthly", dom: day, hour, minute };
    }
  }
  return { kind: "custom", cron: cron.trim() };
}

/** "every day at 06:00 UTC" — falls back to the raw expression when exotic. */
export function cronToWords(cron: string, timezone?: string | null): string {
  const zone = ` ${timezone && timezone !== "UTC" ? timezone : "UTC"}`;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `cron ${cron}`;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minute = num(m);
  const hour = num(h);

  if (mon === "*") {
    if (m === "*" && h === "*" && dom === "*" && dow === "*") return "every minute";
    const everyNMin = m.match(/^\*\/(\d{1,2})$/);
    if (everyNMin && h === "*" && dom === "*" && dow === "*") {
      return `every ${everyNMin[1]} minutes`;
    }
    const everyNHours = h.match(/^\*\/(\d{1,2})$/);
    if (minute !== null && everyNHours && dom === "*" && dow === "*") {
      return `every ${everyNHours[1]} hours at :${pad(minute)}`;
    }
    if (minute !== null && h === "*" && dom === "*" && dow === "*") {
      return `hourly at :${pad(minute)}`;
    }
    if (minute !== null && hour !== null && dom === "*") {
      if (dow === "*") return `every day at ${timeOf(hour, minute)}${zone}`;
      if (dow === "1-5") return `weekdays at ${timeOf(hour, minute)}${zone}`;
      const days = dow
        .split(",")
        .map((d) => num(d === "7" ? "0" : d))
        .map((d) => (d !== null && d <= 6 ? DOW_NAMES[d] : null));
      if (days.length > 0 && days.every((d) => d !== null)) {
        const label =
          days.length === 1
            ? `every ${days[0]}`
            : `on ${days.map((d) => d?.slice(0, 3)).join(", ")}`;
        return `${label} at ${timeOf(hour, minute)}${zone}`;
      }
    }
    if (minute !== null && hour !== null && dow === "*") {
      const day = num(dom);
      if (day !== null) return `monthly on day ${day} at ${timeOf(hour, minute)}${zone}`;
    }
  }
  return `cron ${cron}${zone}`;
}

/** "in 4h" / "in 3d" — for next-run display. */
export function fmtIn(when: string | Date | null | undefined): string | null {
  if (!when) return null;
  const t = typeof when === "string" ? new Date(when).getTime() : when.getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - Date.now();
  if (diff <= 0) return "due now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 2) return "in 1m";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
