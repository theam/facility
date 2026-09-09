"use client";

import { Button, Field, TextArea, TextInput } from "@facility/ui";
import { useState } from "react";
import { clientApi } from "@/lib/client-api";

type Variables = {
  revision: string;
  variables: Array<{ name: string; configured: boolean }>;
  updated_at: string | null;
};

export function WorkspaceVariables({
  projectId,
  storyId,
  canExecute,
}: {
  projectId: string;
  storyId: string;
  canExecute: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<Variables | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [dotenv, setDotenv] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/environment/variables`;

  async function load() {
    setOpened(true);
    setPending(true);
    setError("");
    const result = await clientApi<Variables>("GET", path);
    setPending(false);
    if (result.ok) setState(result.data);
    else setError(result.message);
  }

  async function save(change: { variables: Record<string, string | null> } | { dotenv: string }) {
    if (!state) return;
    setPending(true);
    setError("");
    setNotice("");
    const result = await clientApi<Variables>("PATCH", path, {
      revision: state.revision,
      ...change,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setState(result.data);
    setName("");
    setValue("");
    setDotenv("");
    setNotice(
      "Saved. New agent runs and app starts use these values. Already-running processes keep their current environment until restarted.",
    );
  }

  if (!opened)
    return (
      <Button size="sm" onClick={load}>
        environment variables
      </Button>
    );
  return (
    <section
      aria-label="Workspace environment variables"
      className="grid gap-4 border border-(--line) bg-(--bg-subtle) p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Environment variables</h3>
        <div className="flex gap-2">
          <Button size="sm" onClick={load} disabled={pending}>
            reload
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpened(false);
              setValue("");
              setDotenv("");
            }}
            disabled={pending}
          >
            close
          </Button>
        </div>
      </div>
      <p className="text-sm">
        Values are encrypted and cannot be read back. Changes belong to this workspace and are
        shared by its agents and app services.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {state ? (
        <ul className="grid max-h-64 gap-2 overflow-auto">
          {state.variables.map(({ name }) => (
            <li key={name} className="flex flex-wrap items-center justify-between gap-2">
              <code className="break-all text-sm">{name}</code>
              <span>configured</span>
              {canExecute ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setName(name);
                      setValue("");
                    }}
                  >
                    replace
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => save({ variables: { [name]: null } })}
                  >
                    remove override
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
          {!state.variables.length ? <li>No workspace overrides configured.</li> : null}
        </ul>
      ) : null}
      {canExecute && state ? (
        <>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ variables: { [name]: value } });
            }}
          >
            <Field label="Variable name">
              <TextInput
                required
                pattern="[A-Z_][A-Z0-9_]*"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="WORKOS_CLIENT_ID"
              />
            </Field>
            <Field label="New value">
              <TextInput
                type="password"
                autoComplete="new-password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || !name} variant="primary" tone="agent">
              {pending ? "saving…" : "save variable"}
            </Button>
          </form>
          <details>
            <summary>Import a .env file</summary>
            <form
              className="mt-3 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({ dotenv });
              }}
            >
              <Field label="Paste .env contents">
                <TextArea
                  required
                  autoComplete="off"
                  spellCheck={false}
                  rows={5}
                  value={dotenv}
                  onChange={(event) => setDotenv(event.target.value)}
                />
              </Field>
              <p className="text-sm">
                Replaces the names provided and keeps other overrides. Use this workspace’s database
                and service addresses.
              </p>
              <Button type="submit" disabled={pending || !dotenv.trim()}>
                import variables
              </Button>
            </form>
          </details>
          <p className="text-sm">
            Removing an override restores the project or application default for new processes.
            Saving never runs setup or resets workspace data.
          </p>
        </>
      ) : null}
    </section>
  );
}
