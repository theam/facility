"use client";

import { Button, Terminal, type TerminalLine, TextInput } from "@facility/ui";
import { useState } from "react";
import type { RunEvent } from "@/lib/api";

// A check's pass/fail can arrive as `result` (agent self-reports) or `status`
// (platform gates emit status: "passed"|"failed"). Recognize both vocabularies so
// a passed platform gate isn't mis-toned red.
function checkTone(data: Record<string, unknown>): "ok" | "bad" | "machine" {
  const verdict = `${data.status ?? data.result ?? ""}`;
  if (["passed", "success", "ok", "succeeded"].includes(verdict)) return "ok";
  if (["failed", "failure", "error"].includes(verdict)) return "bad";
  return "machine";
}

// Known machine payloads become sentences; unknown ones become terse
// key–value pairs. Raw JSON never reaches the terminal either.
function fallbackText(data: Record<string, unknown>): string | null {
  if (typeof data.queue === "string") {
    return data.queue === "runs.dispatch" ? "waiting in the dispatch queue" : `queue ${data.queue}`;
  }
  const pairs = Object.entries(data)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 3)
    .map(([k, v]) => `${k} ${String(v)}`);
  return pairs.length > 0 ? pairs.join(" · ") : null;
}

function toLine(event: RunEvent): TerminalLine {
  const ts = new Date(event.ts).toLocaleTimeString("en-GB", { hour12: false });
  const text =
    typeof event.data.text === "string"
      ? event.data.text
      : typeof event.data.message === "string"
        ? event.data.message
        : typeof event.data.command === "string"
          ? event.data.command
          : (fallbackText(event.data) ?? event.type);
  switch (event.type) {
    case "status":
      return { tag: ts, text, tone: "info" };
    case "tool":
    case "shell":
      return { tag: ts, text, tone: "machine" };
    case "error":
      return { tag: ts, text, tone: "bad" };
    case "check":
      return { tag: ts, text, tone: checkTone(event.data) };
    case "steer":
      return { tag: ts, text: `⟶ steer: ${text}`, tone: "human" };
    case "assistant":
      return { tag: ts, text, tone: "plain" };
    default:
      return {
        tag: ts,
        text: text === event.type ? event.type : `${event.type}: ${text}`,
        tone: "muted",
      };
  }
}

export function RunTranscript({
  runId,
  events,
  live,
  canSteer,
}: {
  runId: string;
  events: RunEvent[];
  live: boolean;
  canSteer: boolean;
}) {
  const [steer, setSteer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendSteer(e: React.FormEvent) {
    e.preventDefault();
    if (!steer.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/runs/${runId}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: steer }),
      });
      if (!res.ok) throw new Error(`steer failed (${res.status})`);
      setSteer("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "steer failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Terminal
      title={live ? "live session" : "session recording"}
      lines={events.map(toLine)}
      maxHeight="max-h-[560px]"
      footer={
        canSteer && live ? (
          <form onSubmit={sendSteer} className="flex items-center gap-3">
            <TextInput
              name="steer"
              aria-label="Steer this session — appended to the agent's STEERING.md and audited"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
              placeholder="Steer this session — appended to the agent's STEERING.md and audited"
              className="border-0 bg-transparent px-0"
            />
            <Button type="submit" size="sm" variant="outline" disabled={sending || !steer.trim()}>
              steer
            </Button>
            {error ? <span className="font-mono text-[11px] text-(--bad)">{error}</span> : null}
          </form>
        ) : undefined
      }
    >
      {events.length === 0 ? (
        <p className="font-mono text-[12px] text-(--dim)">
          {live ? "waiting for the first event…" : "no events recorded"}
        </p>
      ) : null}
    </Terminal>
  );
}
