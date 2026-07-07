export function fmtCost(cents?: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function fmtDuration(start?: string | null, end?: string | null): string {
  if (!start) return "—";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Lifecycle statuses in words a person would say. Unknown statuses pass through. */
const STATUS_WORDS: Record<string, string> = {
  queued: "queued",
  provisioning: "provisioning",
  running: "running",
  awaiting_human: "waiting on human",
  succeeded: "succeeded",
  failed: "failed",
  canceled: "canceled",
};

export function fmtStatus(status: string): string {
  return STATUS_WORDS[status] ?? status.replaceAll("_", " ");
}

export function fmtAgo(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
