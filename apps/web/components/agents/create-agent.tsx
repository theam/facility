"use client";

import { Button, Eyebrow, Field, Select, TextArea, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { engineIdentity, modelIdentity, providerIdentity } from "@/lib/ai-identity";
import type { Catalog, RegistryItem, RegistryItemWithVersions } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { PermissionMatrix } from "./permission-matrix";
import { ScheduleBuilder } from "./schedule-builder";

function contractTemplate(name: string): string {
  return `# ${name} operating contract

## Mission
One paragraph: what this agent owns and the outcome it drives.

## Inputs
- The task/issue context provided at dispatch.
- KB charter + active focus (mounted read-only).

## How to work
1. Read before acting; cite evidence for every claim.
2. Keep changes atomic; leave the workspace consistent.
3. Record what was done and why in the session output.

## Never
- Push to protected branches — merges stay human-gated.
- Claim done without evidence (checks output, PR link).
`;
}

type Props = {
  projectId: string;
  catalog: Catalog;
  myPermissions: string[];
};

/**
 * One screen from intent to agent: the contract item + first version +
 * publish + agent definition happen behind a single create.
 */
export function CreateAgent({ projectId, catalog, myPermissions }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [engine, setEngine] = useState(catalog.engines[0]?.id ?? "claude_code");
  const [modelChoice, setModelChoice] = useState("__default");
  const [customModel, setCustomModel] = useState("");
  const [schedule, setSchedule] = useState<{ cron: string } | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [promptTouched, setPromptTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  function nameChanged(next: string) {
    setName(next);
    if (!promptTouched) setPrompt(contractTemplate(next.trim() || "agent"));
  }

  async function create() {
    if (!slug) return setError("give the agent a name");
    setBusy(true);
    setError(null);

    const contractName = `${slug}-contract`;
    let item: RegistryItemWithVersions | null = null;
    const created = await clientApi<RegistryItemWithVersions>("POST", "/v1/registry/items", {
      scope: "project",
      projectId,
      kind: "agent_contract",
      name: contractName,
      description: description.trim() || undefined,
      content: prompt,
    });
    if (created.ok) {
      item = created.data;
    } else {
      // Name collision from a previous half-finished create: reuse that item.
      const existing = await clientApi<RegistryItem[]>(
        "GET",
        `/v1/registry/items?kind=agent_contract&projectId=${projectId}`,
      );
      const match = existing.ok ? existing.data.find((i) => i.name === contractName) : undefined;
      if (!match) {
        setBusy(false);
        return setError(created.message);
      }
      const full = await clientApi<RegistryItemWithVersions>(
        "GET",
        `/v1/registry/items/${match.id}`,
      );
      if (!full.ok) {
        setBusy(false);
        return setError(full.message);
      }
      item = full.data;
    }

    const draft = [...item.versions].sort((a, b) => b.version - a.version)[0];
    if (draft && draft.status !== "active") {
      const published = await clientApi("POST", `/v1/registry/versions/${draft.id}/publish`);
      if (!published.ok) {
        setBusy(false);
        return setError(`contract saved but not published: ${published.message}`);
      }
    }

    const model: Record<string, unknown> = {};
    const chosenModel =
      modelChoice === "__default"
        ? null
        : modelChoice === "__custom"
          ? customModel.trim()
          : modelChoice;
    if (chosenModel) model.model = chosenModel;

    const agent = await clientApi<{ id: string }>("POST", `/v1/projects/${projectId}/agents`, {
      name: slug,
      engine,
      model,
      contractItemId: item.id,
      triggers: schedule ? [{ type: "schedule", config: { cron: schedule.cron } }] : [],
      permissions,
      enabled: true,
    });
    setBusy(false);
    if (!agent.ok) {
      return setError(`contract ready, but the agent wasn't created: ${agent.message}`);
    }
    router.push(`/projects/${projectId}/agents/${agent.data.id}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="name" hint={slug && slug !== name.trim() ? `runs as ${slug}` : undefined}>
          <TextInput
            value={name}
            onChange={(e) => nameChanged(e.target.value)}
            placeholder="feedback-triage"
            autoFocus
          />
        </Field>
        <Field label="purpose — one line people will read">
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Validates incoming feedback in a sandbox and files assessed issues."
          />
        </Field>
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
            <TextInput value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
          </Field>
        ) : null}
      </div>

      <section className="flex flex-col gap-3">
        <Eyebrow>schedule — optional</Eyebrow>
        <ScheduleBuilder value={null} onChange={setSchedule} />
      </section>

      <section className="flex flex-col gap-3">
        <Eyebrow>access</Eyebrow>
        <PermissionMatrix
          value={permissions}
          onChange={setPermissions}
          grantable={myPermissions}
          resources={catalog.permissions.resources}
          special={catalog.permissions.special}
        />
      </section>

      <section className="flex flex-col gap-3">
        <Eyebrow>the contract — its prompt, versioned in the harness</Eyebrow>
        <TextArea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setPromptTouched(true);
          }}
          rows={16}
          className="min-h-[280px] font-mono text-[12.5px] leading-relaxed"
        />
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="primary"
          tone="agent"
          disabled={busy || !slug || prompt.trim().length === 0}
          onClick={() => void create()}
        >
          {busy ? "creating…" : "create agent"}
        </Button>
        <Link
          href={`/projects/${projectId}/agents`}
          className="text-[12px] font-medium text-(--mut) hover:text-(--ink)"
        >
          cancel
        </Link>
        {error ? <span className="font-mono text-[11.5px] text-(--bad)">{error}</span> : null}
      </div>
    </div>
  );
}
