"use client";

import { isBuilderAgent } from "@facility/run-objective";
import {
  Button,
  Divider,
  Eyebrow,
  Field,
  Metric,
  PillTag,
  Select,
  StatusDot,
  TextArea,
  TextInput,
  toneFor,
} from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { Markdown } from "@/components/markdown";
import { agentHealth, triggerSummary } from "@/lib/agent-view";
import { engineIdentity, modelIdentity, providerIdentity } from "@/lib/ai-identity";
import type {
  AgentDef,
  AgentStatus,
  Catalog,
  RegistryItemWithVersions,
  RegistryVersion,
  Run,
} from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { fmtAgo, fmtCost, fmtDuration } from "@/lib/run-format";
import { cronToWords, fmtIn } from "@/lib/schedule";
import { PermissionMatrix } from "./permission-matrix";
import { ScheduleBuilder } from "./schedule-builder";

type Props = {
  projectId: string;
  agent: AgentDef;
  status: AgentStatus | null;
  item: RegistryItemWithVersions;
  catalog: Catalog;
  myPermissions: string[];
  sandboxProfiles: Array<{ id: string; name: string }>;
  recentRuns: Run[];
  builderPlanPolicy: "optional" | "required";
};

type ScheduleTriggerShape = {
  type?: unknown;
  config?: { cron?: unknown; timezone?: unknown };
};

function scheduleOf(agent: AgentDef): { cron: string; timezone: string | null } | null {
  const trigger = agent.triggers.find((t) => (t as ScheduleTriggerShape).type === "schedule") as
    | ScheduleTriggerShape
    | undefined;
  const cron = trigger?.config?.cron;
  if (typeof cron !== "string") return null;
  const tz = trigger?.config?.timezone;
  return { cron, timezone: typeof tz === "string" ? tz : null };
}

function modelOf(agent: AgentDef): string | null {
  const model = (agent.model as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function prLinkOf(run: Run): string | null {
  const gh = run.gh as { pr?: unknown } | null;
  const pr = gh && typeof gh === "object" ? gh.pr : null;
  if (typeof pr === "string") return pr;
  if (pr && typeof pr === "object" && typeof (pr as { url?: unknown }).url === "string") {
    return (pr as { url: string }).url;
  }
  return null;
}

function runCost(run: Run): number | null {
  const receipt = run.receipt as { usage?: { cost_cents?: unknown } } | null;
  const cents = receipt?.usage?.cost_cents;
  return typeof cents === "number" ? cents : null;
}

/** The flagship surface: one agent, fully understandable and operable. */
export function AgentDetail(props: Props) {
  const { projectId, agent, status, builderPlanPolicy } = props;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ scope: string; text: string } | null>(null);

  async function act(
    scope: string,
    fn: () => Promise<{ ok: boolean; message?: string }>,
    doneText?: string,
  ) {
    setBusy(scope);
    setNote(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) setNote({ scope, text: res.message ?? "failed" });
    else {
      if (doneText) setNote({ scope, text: doneText });
      router.refresh();
    }
    return res.ok;
  }

  async function runNow() {
    const trigger: Record<string, unknown> = { type: "manual", source: "agent-page" };
    if (isBuilderAgent(agent.name, agent.triggers)) {
      const objective = window.prompt(`Run ${agent.name} — what should it do?`);
      if (objective === null) return;
      const message = objective.trim();
      if (!message) {
        setNote({ scope: "run", text: "an objective is required to start this builder" });
        return;
      }
      trigger.message = message;
    }
    setBusy("run");
    setNote(null);
    const res = await clientApi<{ id: string }>("POST", `/v1/projects/${projectId}/runs`, {
      agentDefId: agent.id,
      mode: agent.name,
      trigger,
    });
    setBusy(null);
    if (!res.ok) return setNote({ scope: "run", text: res.message });
    router.push(`/projects/${projectId}/sessions/${res.data.id}`);
  }

  const health = status ? agentHealth(status) : null;
  const next = fmtIn(status?.nextRunAt ?? null);
  const builderRequiresPlan =
    builderPlanPolicy === "required" && isBuilderAgent(agent.name, agent.triggers);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-10">
      <div className="flex flex-col gap-3">
        <Eyebrow>
          <Link href={`/projects/${projectId}/agents`} className="hover:text-(--ink)">
            agents
          </Link>{" "}
          / {agent.name}
        </Eyebrow>
        <div className="flex flex-wrap items-center gap-4">
          {health ? <StatusDot tone={health.tone} pulse={health.pulse} /> : null}
          <h1 className="font-mono text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
            {agent.name}
          </h1>
          <PillTag>
            <AiIdentity identity={engineIdentity(agent.engine)} />
          </PillTag>
          <PillTag>
            {modelOf(agent) ? (
              <AiIdentity identity={modelIdentity(modelOf(agent) ?? "")} />
            ) : (
              "engine default"
            )}
          </PillTag>
          {!agent.enabled ? <PillTag>disabled</PillTag> : null}
          <span className="ml-auto flex items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              tone="agent"
              disabled={busy !== null || !agent.enabled || builderRequiresPlan}
              title={
                builderRequiresPlan
                  ? "Approve a current Architect plan from the story or GitHub issue"
                  : undefined
              }
              onClick={() => void runNow()}
            >
              {busy === "run" ? "starting…" : "run now"}
            </Button>
            {builderRequiresPlan ? (
              <span className="font-mono text-[10px] text-(--human)">plan approval required</span>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "enable",
                  () =>
                    clientApi("PATCH", `/v1/projects/${projectId}/agents/${agent.id}`, {
                      enabled: !agent.enabled,
                    }),
                  agent.enabled ? "disabled" : "enabled",
                )
              }
            >
              {agent.enabled ? "disable" : "enable"}
            </Button>
          </span>
        </div>
        <p className="text-[12.5px] text-(--dim)">
          {health?.word ?? "no status"}
          {status ? ` · ${triggerSummary(status)}` : ""}
        </p>
        {status?.description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-(--mut)">{status.description}</p>
        ) : null}
        {note?.scope === "run" || note?.scope === "enable" ? (
          <p className="font-mono text-[11.5px] text-(--bad)">{note.text}</p>
        ) : null}
      </div>

      {status?.liveRun ? (
        <Link
          href={`/projects/${projectId}/sessions/${status.liveRun.id}`}
          className="flex items-center gap-4 border border-(--line-strong) bg-(--card) px-5 py-4 transition-colors hover:border-(--accent)"
        >
          <StatusDot tone="agent" pulse />
          <span className="font-mono text-[13px] text-(--ink)">
            session {status.liveRun.status} right now
          </span>
          <span className="ml-auto text-[12px] font-medium text-(--mut)">open cockpit →</span>
        </Link>
      ) : null}

      <div className="grid gap-px border border-(--line) bg-(--line) sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-(--bg) p-5">
          <Metric
            label="next run"
            value={next ?? "—"}
            hint={
              status?.schedule
                ? cronToWords(status.schedule.cron, status.schedule.timezone)
                : "no schedule — on demand"
            }
          />
        </div>
        <div className="bg-(--bg) p-5">
          <Metric
            label="last session"
            value={status?.lastRun ? status.lastRun.status : "never"}
            hint={status?.lastRun ? fmtAgo(status.lastRun.queuedAt) : "—"}
          />
        </div>
        <div className="bg-(--bg) p-5">
          <Metric
            label="14d sessions"
            value={String(status?.counts14d.total ?? 0)}
            hint={
              status && status.counts14d.total > 0
                ? `${status.counts14d.succeeded} ok · ${status.counts14d.failed} failed`
                : "quiet fortnight"
            }
          />
        </div>
        <div className="bg-(--bg) p-5">
          <Metric
            label="14d prs"
            value={String(status?.prCount14d ?? 0)}
            hint="sessions that shipped a pull request"
          />
        </div>
      </div>

      <ContractSection {...props} act={act} busy={busy} note={note} />
      <Divider />
      <TriggersSection {...props} act={act} busy={busy} note={note} />
      <Divider />
      <RuntimeSection {...props} act={act} busy={busy} note={note} />
      <Divider />
      <AccessSection {...props} act={act} busy={busy} note={note} />
      <Divider />
      <SessionsSection {...props} />
      <Divider />
      <DangerSection {...props} busy={busy} setBusy={setBusy} setNote={setNote} note={note} />
    </div>
  );
}

type SectionProps = Props & {
  act: (
    scope: string,
    fn: () => Promise<{ ok: boolean; message?: string }>,
    doneText?: string,
  ) => Promise<boolean>;
  busy: string | null;
  note: { scope: string; text: string } | null;
};

function SectionNote({ note, scope }: { note: SectionProps["note"]; scope: string }) {
  if (!note || note.scope !== scope) return null;
  const failed = /fail|error|denied|not |unable/i.test(note.text);
  return (
    <span className={`font-mono text-[11.5px] ${failed ? "text-(--bad)" : "text-(--dim)"}`}>
      {note.text}
    </span>
  );
}

function ContractSection({ item, act, busy, note }: SectionProps) {
  const versions = useMemo(
    () => [...item.versions].sort((a, b) => b.version - a.version),
    [item.versions],
  );
  const active = versions.find((v) => v.status === "active") ?? versions[0];
  const [viewId, setViewId] = useState<string | null>(active?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [changelog, setChangelog] = useState("");
  const [armPublish, setArmPublish] = useState<string | null>(null);

  const viewed: RegistryVersion | undefined = versions.find((v) => v.id === viewId) ?? active;

  function startEdit() {
    setDraft(viewed?.content ?? "");
    setChangelog("");
    setEditing(true);
  }

  async function saveDraft() {
    const ok = await act(
      "contract",
      () =>
        clientApi("POST", `/v1/registry/items/${item.id}/versions`, {
          content: draft,
          ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
        }),
      `saved as draft v${(versions[0]?.version ?? 0) + 1}`,
    );
    if (ok) setEditing(false);
  }

  async function publish(versionId: string) {
    setArmPublish(null);
    await act(
      "contract",
      () => clientApi("POST", `/v1/registry/versions/${versionId}/publish`),
      "published — next session picks it up",
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Eyebrow>the contract — what this agent is</Eyebrow>
        <span className="text-[12px] text-(--dim)">{item.name}</span>
        <span className="ml-auto flex items-center gap-3">
          <SectionNote note={note} scope="contract" />
          {!editing ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={startEdit}>
              edit as new draft
            </Button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => {
              setViewId(v.id);
              setEditing(false);
            }}
            className="group"
          >
            <PillTag active={v.id === viewed?.id}>
              v{v.version}
              {v.status === "active" ? " · live" : v.status === "draft" ? " · draft" : ""}
            </PillTag>
          </button>
        ))}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={20}
            className="min-h-[360px] font-mono text-[12.5px] leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-3">
            <TextInput
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder="what changed, one line"
              className="max-w-sm"
            />
            <Button
              size="sm"
              variant="primary"
              tone="agent"
              disabled={busy !== null || draft.trim().length === 0}
              onClick={() => void saveDraft()}
            >
              {busy === "contract" ? "saving…" : "save draft"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              cancel
            </Button>
            <span className="text-[11.5px] text-(--dim)">
              published versions are immutable — this saves a new draft; publish to make it live
            </span>
          </div>
        </div>
      ) : viewed ? (
        <div className="flex flex-col gap-3">
          {viewed.status === "draft" ? (
            <div className="flex items-center gap-3 border border-(--line) bg-(--bg-subtle) px-4 py-2.5">
              <StatusDot tone="info" />
              <span className="text-[12.5px] text-(--mut)">
                draft — not what sessions run today
              </span>
              {armPublish === viewed.id ? (
                <span className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    tone="agent"
                    disabled={busy !== null}
                    onClick={() => void publish(viewed.id)}
                  >
                    confirm publish
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setArmPublish(null)}>
                    cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() => setArmPublish(viewed.id)}
                >
                  publish v{viewed.version}
                </Button>
              )}
            </div>
          ) : null}
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 border border-(--line) px-5 py-6 sm:px-8 lg:px-10">
              <div className="mx-auto max-w-[88ch]">
                <Markdown source={viewed.content} />
              </div>
            </div>
            <aside className="flex flex-col gap-5 border border-(--line) bg-(--bg-subtle) p-5 xl:sticky xl:top-6">
              <Eyebrow>revision</Eyebrow>
              <dl className="flex flex-col gap-3 text-[12.5px]">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-(--dim)">version</dt>
                  <dd className="font-mono text-(--ink)">v{viewed.version}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-(--dim)">status</dt>
                  <dd className="font-medium text-(--ink)">{viewed.status}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-(--dim)">contract</dt>
                  <dd className="min-w-0 break-words text-right font-mono text-(--mut)">
                    {item.name}
                  </dd>
                </div>
              </dl>
              <div className="border-t border-(--line) pt-4">
                <p className="mb-2 text-[11px] font-medium text-(--dim)">changelog</p>
                <p className="text-pretty text-[12.5px] leading-relaxed text-(--mut)">
                  {viewed.changelog ?? "No changelog was recorded for this revision."}
                </p>
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <p className="text-sm text-(--dim)">
          No contract content yet — edit to write the first version.
        </p>
      )}
    </section>
  );
}

function TriggersSection({
  projectId,
  agent,
  status,
  catalog,
  act,
  busy,
  note,
  builderPlanPolicy,
}: SectionProps) {
  const existing = scheduleOf(agent);
  const builderRequiresPlan =
    builderPlanPolicy === "required" && isBuilderAgent(agent.name, agent.triggers);
  const [editing, setEditing] = useState(false);
  const [nextSchedule, setNextSchedule] = useState<{ cron: string } | null>(
    existing ? { cron: existing.cron } : null,
  );

  async function saveSchedule() {
    const others = agent.triggers.filter((t) => (t as ScheduleTriggerShape).type !== "schedule");
    const triggers = nextSchedule
      ? [
          ...others,
          {
            type: "schedule",
            config: {
              cron: nextSchedule.cron,
              ...(existing?.timezone ? { timezone: existing.timezone } : {}),
            },
          },
        ]
      : others;
    const ok = await act(
      "triggers",
      () => clientApi("PATCH", `/v1/projects/${projectId}/agents/${agent.id}`, { triggers }),
      nextSchedule ? "schedule saved — scheduler arms within a minute" : "schedule removed",
    );
    if (ok) setEditing(false);
  }

  const bindings = status?.eventBindings ?? [];
  const triggerNotes = new Map(catalog.triggerTypes.map((t) => [t.type, t.note]));

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Eyebrow>triggers — when it wakes up</Eyebrow>
        <span className="ml-auto">
          <SectionNote note={note} scope="triggers" />
        </span>
      </div>

      <div className="flex flex-col gap-px border border-(--line) bg-(--line)">
        <div className="flex flex-col gap-3 bg-(--bg) px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-24 text-[11px] font-medium text-(--dim)">schedule</span>
            {existing && !editing ? (
              <>
                <span className="font-mono text-[12.5px] text-(--ink)">
                  {cronToWords(existing.cron, existing.timezone)}
                </span>
                {status?.nextRunAt ? (
                  <span className="font-mono text-[11px] text-(--code)">
                    next {fmtIn(status.nextRunAt)}
                  </span>
                ) : null}
              </>
            ) : !editing ? (
              <span className="text-[12.5px] text-(--dim)">none</span>
            ) : null}
            {!editing ? (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={busy !== null || builderRequiresPlan}
                title={
                  builderRequiresPlan
                    ? "Scheduled Builder runs cannot satisfy a per-plan human approval"
                    : undefined
                }
                onClick={() => setEditing(true)}
              >
                {existing ? "edit" : "add schedule"}
              </Button>
            ) : null}
            {builderRequiresPlan ? (
              <span className="font-mono text-[10px] text-(--human)">
                disabled by required plan gate
              </span>
            ) : null}
          </div>
          {editing ? (
            <div className="flex flex-col gap-3">
              <ScheduleBuilder
                value={existing ? { cron: existing.cron, timezone: existing.timezone } : null}
                timezone={existing?.timezone}
                onChange={setNextSchedule}
              />
              <div className="flex gap-3">
                <Button
                  size="sm"
                  variant="primary"
                  tone="agent"
                  disabled={busy !== null}
                  onClick={() => void saveSchedule()}
                >
                  {busy === "triggers" ? "saving…" : "save schedule"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                  cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-(--bg) px-5 py-4">
          <span className="w-24 text-[11px] font-medium text-(--dim)">events</span>
          {bindings.length === 0 ? (
            <span className="text-[12.5px] text-(--dim)">
              no event source routes here yet — connect one under{" "}
              <Link href="/settings" className="text-(--ink) underline underline-offset-4">
                settings → integrations
              </Link>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {bindings.map((b) => (
                <span
                  key={b.integrationId}
                  className="inline-flex items-center gap-2 border border-(--line) px-2.5 py-1"
                >
                  <StatusDot tone={b.enabled && b.dispatchesRuns ? "ok" : "machine"} />
                  <span className="font-mono text-[11.5px] text-(--ink)">{b.name}</span>
                  <span className="font-mono text-[10px] text-(--dim)">
                    {b.kind}
                    {!b.dispatchesRuns ? " · alerts only" : ""}
                    {!b.enabled ? " · off" : ""}
                  </span>
                </span>
              ))}
              <Link
                href="/settings"
                className="text-[11.5px] font-medium text-(--mut) hover:text-(--ink)"
              >
                manage →
              </Link>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 bg-(--bg) px-5 py-4">
          <span className="w-24 text-[11px] font-medium text-(--dim)">on demand</span>
          <span className="text-[12.5px] text-(--mut)">
            always — run now here, trigger from an issue, or{" "}
            <span className="font-mono text-(--code)">/{agent.name}</span> in a comment on a
            connected repo
          </span>
        </div>
      </div>

      <p className="max-w-2xl text-[11.5px] leading-relaxed text-(--dim)">
        {triggerNotes.get("schedule")}. {triggerNotes.get("generic_inbound")}.
      </p>
    </section>
  );
}

function RuntimeSection({
  projectId,
  agent,
  catalog,
  sandboxProfiles,
  act,
  busy,
  note,
}: SectionProps) {
  const currentModel = modelOf(agent);
  const [engine, setEngine] = useState(agent.engine);
  const knownModel = currentModel === null || catalog.models.some((m) => m.id === currentModel);
  const [modelChoice, setModelChoice] = useState(
    currentModel === null ? "__default" : knownModel ? currentModel : "__custom",
  );
  const [customModel, setCustomModel] = useState(knownModel ? "" : (currentModel ?? ""));
  const [profileId, setProfileId] = useState(agent.sandboxProfileId ?? "__default");

  const chosen =
    modelChoice === "__default"
      ? null
      : modelChoice === "__custom"
        ? customModel.trim()
        : modelChoice;
  const price = catalog.models.find((m) => m.id === chosen);

  async function save() {
    const model: Record<string, unknown> = { ...agent.model };
    if (chosen) model.model = chosen;
    else delete model.model;
    await act(
      "runtime",
      () =>
        clientApi("PATCH", `/v1/projects/${projectId}/agents/${agent.id}`, {
          engine,
          model,
          sandboxProfileId: profileId === "__default" ? undefined : profileId,
        }),
      "runtime saved — applies to the next session",
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Eyebrow>runtime — what it runs on</Eyebrow>
        <span className="ml-auto">
          <SectionNote note={note} scope="runtime" />
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="engine">
          <AiIdentity identity={engineIdentity(engine)} className="mb-2 text-[11px] text-(--dim)" />
          <Select value={engine} onChange={(e) => setEngine(e.target.value)}>
            {catalog.engines.map((eng) => (
              <option key={eng.id} value={eng.id}>
                {eng.label}
              </option>
            ))}
            {catalog.engines.some((e) => e.id === agent.engine) ? null : (
              <option value={agent.engine}>{engineIdentity(agent.engine).label}</option>
            )}
          </Select>
        </Field>
        <Field label="model">
          {modelChoice !== "__default" ? (
            <AiIdentity
              identity={modelIdentity(modelChoice === "__custom" ? customModel : modelChoice)}
              className="mb-2 text-[11px] text-(--dim)"
            />
          ) : null}
          <Select value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
            <option value="__default">engine default</option>
            {catalog.models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelIdentity(m.id).label} · {providerIdentity(m.provider).label}
              </option>
            ))}
            <option value="__custom">custom…</option>
          </Select>
        </Field>
        {modelChoice === "__custom" ? (
          <Field label="custom model id">
            <TextInput
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="provider model id"
            />
          </Field>
        ) : (
          <Field label="sandbox profile">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="__default">project default</option>
              {sandboxProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy !== null || (modelChoice === "__custom" && customModel.trim() === "")}
          onClick={() => void save()}
        >
          {busy === "runtime" ? "saving…" : "save runtime"}
        </Button>
        <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-(--dim)">
          <AiIdentity identity={engineIdentity(engine)} />
          <span>
            {catalog.engines.find((e) => e.id === engine)?.note}
            {price ? ` · $${price.inputPer1M}/M in, $${price.outputPer1M}/M out` : ""}
          </span>
        </span>
      </div>
    </section>
  );
}

function AccessSection({
  projectId,
  agent,
  catalog,
  myPermissions,
  act,
  busy,
  note,
}: SectionProps) {
  const [perms, setPerms] = useState<string[]>(agent.permissions);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Eyebrow>access — what it may touch</Eyebrow>
        <span className="ml-auto">
          <SectionNote note={note} scope="access" />
        </span>
      </div>
      <PermissionMatrix
        value={perms}
        onChange={setPerms}
        grantable={myPermissions}
        resources={catalog.permissions.resources}
        special={catalog.permissions.special}
      />
      <div>
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy !== null}
          onClick={() =>
            void act(
              "access",
              () =>
                clientApi("PATCH", `/v1/projects/${projectId}/agents/${agent.id}`, {
                  permissions: perms,
                }),
              "access saved",
            )
          }
        >
          {busy === "access" ? "saving…" : "save access"}
        </Button>
      </div>
    </section>
  );
}

function SessionsSection({ projectId, agent, recentRuns }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <Eyebrow>recent sessions</Eyebrow>
        <Link
          href={`/projects/${projectId}/sessions?agent=${agent.id}`}
          className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
        >
          all sessions →
        </Link>
      </div>
      {recentRuns.length === 0 ? (
        <p className="text-sm text-(--dim)">
          This agent has never run. "run now" above starts a governed session in a sandbox.
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {recentRuns.map((run) => {
            const pr = prLinkOf(run);
            return (
              <div
                key={run.id}
                className="flex items-center gap-4 border-b border-(--line) px-5 py-3.5 last:border-b-0"
              >
                <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                <Link
                  href={`/projects/${projectId}/sessions/${run.id}`}
                  className="font-mono text-[12.5px] text-(--ink) hover:text-(--accent)"
                >
                  {run.id.slice(0, 14)}…
                </Link>
                <span className="text-[12px] text-(--mut)">{run.status}</span>
                {pr ? (
                  <a
                    href={pr}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[11px] text-(--info) underline-offset-4 hover:underline"
                  >
                    PR ↗
                  </a>
                ) : null}
                <span className="ml-auto hidden font-mono text-[11px] text-(--mut) sm:inline">
                  {fmtDuration(run.startedAt, run.endedAt)}
                </span>
                <span className="hidden font-mono text-[11px] text-(--code) sm:inline">
                  {fmtCost(runCost(run))}
                </span>
                <span className="font-mono text-[11px] text-(--dim)">{fmtAgo(run.queuedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DangerSection({
  projectId,
  agent,
  busy,
  setBusy,
  setNote,
  note,
}: Props & {
  busy: string | null;
  setBusy: (v: string | null) => void;
  setNote: (v: { scope: string; text: string } | null) => void;
  note: { scope: string; text: string } | null;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);

  async function remove() {
    setBusy("delete");
    const res = await clientApi("DELETE", `/v1/projects/${projectId}/agents/${agent.id}`);
    setBusy(null);
    if (!res.ok) {
      setArmed(false);
      return setNote({ scope: "delete", text: res.message });
    }
    router.push(`/projects/${projectId}/agents`);
    router.refresh();
  }

  return (
    <section className="flex flex-wrap items-center gap-3">
      <span className="text-[11px] font-medium text-(--dim)">remove agent</span>
      <span className="text-[12px] text-(--dim)">
        sessions and receipts stay; the definition and its schedule go
      </span>
      <span className="ml-auto flex items-center gap-2">
        <SectionNote note={note} scope="delete" />
        {armed ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setArmed(false)}>
              keep it
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === "delete" ? "removing…" : "confirm remove"}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setArmed(true)}
          >
            remove…
          </Button>
        )}
      </span>
    </section>
  );
}
