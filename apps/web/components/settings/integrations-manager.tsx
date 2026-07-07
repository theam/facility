"use client";

import { Button, Field, Select, StatusDot, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentDef, Integration, IntegrationEvent, Project } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { fmtAgo } from "@/lib/run-format";

const KINDS = ["feedback", "transcripts", "data-source", "custom"];

type Config = { projectId?: string; agent?: string; enqueueRun?: boolean };

function routingOf(row: Integration): string {
  const config = (row.config ?? {}) as Config;
  if (config.enqueueRun && config.agent) return `→ dispatches ${config.agent}`;
  return "alerts only";
}

/**
 * Event sources, configured once and referenced semantically: "the data
 * comes from here, use this key, route events to that agent." Inbound
 * deliveries land on /webhooks/inbound/:id and can dispatch sessions.
 */
export function IntegrationsManager({
  integrations,
  projects,
}: {
  integrations: Integration[];
  projects: Array<Pick<Project, "id" | "slug">>;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, IntegrationEvent[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(row: Integration) {
    setBusyId(row.id);
    setError(null);
    const res = await clientApi("PATCH", `/v1/integrations/${row.id}`, {
      enabled: !row.enabled,
    });
    setBusyId(null);
    if (!res.ok) return setError(res.message);
    router.refresh();
  }

  async function open(row: Integration) {
    const next = openId === row.id ? null : row.id;
    setOpenId(next);
    if (next && !events[row.id]) {
      const res = await clientApi<IntegrationEvent[]>("GET", `/v1/integrations/${row.id}/events`);
      if (res.ok) setEvents((current) => ({ ...current, [row.id]: res.data }));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {integrations.length === 0 ? (
        <p className="text-sm text-(--dim)">
          No event sources yet. Connect one below — its events can raise alerts or dispatch an agent
          session (the Feedback pattern).
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {integrations.map((row) => {
            const projectSlug = projects.find((p) => p.id === row.projectId)?.slug;
            return (
              <div key={row.id} className="flex flex-col border-b border-(--line) last:border-b-0">
                <button
                  type="button"
                  onClick={() => void open(row)}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-(--card)"
                >
                  <StatusDot tone={row.enabled ? "ok" : "machine"} />
                  <span className="font-mono text-[12.5px] text-(--ink)">{row.name}</span>
                  <span className="font-mono text-[10.5px] text-(--dim)">{row.kind}</span>
                  <span className="font-mono text-[11px] text-(--mut)">{routingOf(row)}</span>
                  {projectSlug ? (
                    <span className="font-mono text-[10px] text-(--dim)">in {projectSlug}</span>
                  ) : null}
                  <span className="ml-auto text-[11px] font-medium text-(--dim)">
                    {openId === row.id ? "close" : "details"}
                  </span>
                </button>
                {openId === row.id ? (
                  <div className="flex flex-col gap-3 border-t border-(--line) bg-(--bg-subtle) px-4 py-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-[11px] font-medium text-(--dim)">
                        deliver events to
                      </span>
                      <code className="border border-(--line) bg-(--bg) px-2 py-1 font-mono text-[11px] text-(--code)">
                        POST /webhooks/inbound/{row.id}
                      </code>
                      <span className="font-mono text-[10px] text-(--dim)">
                        {row.hasSecret ? "signed — secret sealed" : "no signing secret"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        disabled={busyId === row.id}
                        onClick={() => void toggle(row)}
                      >
                        {row.enabled ? "disable" : "enable"}
                      </Button>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[11px] font-medium text-(--dim)">
                        recent deliveries
                      </span>
                      {(events[row.id] ?? []).length === 0 ? (
                        <p className="text-[12px] text-(--dim)">
                          Nothing received yet on this endpoint.
                        </p>
                      ) : (
                        (events[row.id] ?? []).slice(0, 8).map((event) => (
                          <div
                            key={event.id}
                            className="flex items-center gap-3 font-mono text-[11px]"
                          >
                            <StatusDot
                              tone={event.error ? "bad" : event.processedAt ? "ok" : "info"}
                            />
                            <span className="text-(--mut)">{event.eventType}</span>
                            {event.error ? (
                              <span className="truncate text-(--bad)">{event.error}</span>
                            ) : null}
                            <span className="ml-auto text-(--dim)">{fmtAgo(event.receivedAt)}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <CreateIntegration projects={projects} onError={setError} />
      {error ? <span className="font-mono text-[11.5px] text-(--bad)">{error}</span> : null}
    </div>
  );
}

function CreateIntegration({
  projects,
  onError,
}: {
  projects: Array<Pick<Project, "id" | "slug">>;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("feedback");
  const [projectId, setProjectId] = useState("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agent, setAgent] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function projectChanged(nextId: string) {
    setProjectId(nextId);
    setAgent("");
    setAgents([]);
    if (!nextId) return;
    const res = await clientApi<AgentDef[]>("GET", `/v1/projects/${nextId}/agents`);
    if (res.ok) {
      setAgents(res.data.filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name })));
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    const config: Config = {};
    if (projectId) config.projectId = projectId;
    if (agent) {
      config.agent = agent;
      config.enqueueRun = true;
    }
    const res = await clientApi("POST", "/v1/integrations", {
      name: name.trim(),
      kind,
      config,
      ...(secret.trim() ? { secret: secret.trim() } : {}),
      ...(projectId ? { projectId } : {}),
    });
    setBusy(false);
    if (!res.ok) return onError(res.message);
    setName("");
    setSecret("");
    setAgent("");
    router.refresh();
  }

  return (
    <form onSubmit={create} className="flex flex-col gap-4 border border-(--line) p-5">
      <span className="text-[11px] font-medium text-(--dim)">connect an event source</span>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="uservoice"
            required
          />
        </Field>
        <Field label="kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="project">
          <Select value={projectId} onChange={(e) => void projectChanged(e.target.value)}>
            <option value="">org-wide (alerts only)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.slug}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="route events to"
          hint={projectId && agents.length === 0 ? "no enabled agents in this project" : undefined}
        >
          <Select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            disabled={!projectId || agents.length === 0}
          >
            <option value="">raise alerts only</option>
            {agents.map((a) => (
              <option key={a.id} value={a.name}>
                dispatch {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="signing secret — optional" className="min-w-64 flex-1">
          <TextInput
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            type="password"
            placeholder="sealed at rest, never shown again"
          />
        </Field>
        <Button size="sm" variant="primary" tone="agent" disabled={busy || name.trim() === ""}>
          {busy ? "connecting…" : "connect"}
        </Button>
      </div>
    </form>
  );
}
