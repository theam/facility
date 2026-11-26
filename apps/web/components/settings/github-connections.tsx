"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { clientApi } from "@/lib/client-api";

type Connection = {
  id: string;
  name: string;
  appId: number;
  slug: string;
  disabledAt: string | null;
  webhookUrl: string;
};
const inputClass = "w-full rounded-md border border-(--line) bg-(--bg-subtle) px-3 py-2 text-sm";

export function GithubConnections({ canManage }: { canManage: boolean }) {
  const id = useId();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [disableId, setDisableId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await clientApi<Connection[]>("GET", "/v1/github/connections");
    if (result.ok) setConnections(result.data);
    else setError(result.message);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(form: HTMLFormElement) {
    const fields = new FormData(form);
    setPending(true);
    setError("");
    setMessage("");
    const secrets = {
      privateKey: String(fields.get("privateKey")),
      webhookSecret: String(fields.get("webhookSecret")),
    };
    const result = editing
      ? await clientApi("PATCH", `/v1/github/connections/${editing.id}`, { secrets })
      : await clientApi("POST", "/v1/github/connections", {
          name: fields.get("name"),
          appId: Number(fields.get("appId")),
          installationId: Number(fields.get("installationId")),
          ...secrets,
        });
    // Clear credentials even on failure. They are never persisted in browser storage.
    form.reset();
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setShowForm(false);
    setEditing(null);
    setMessage(
      editing
        ? "Credentials updated. Update the webhook secret in GitHub too."
        : "Connection verified. Set its webhook URL in the GitHub App, then select it in project settings.",
    );
    await load();
  }
  async function toggle(connection: Connection) {
    setPending(true);
    setError("");
    const result = await clientApi("PATCH", `/v1/github/connections/${connection.id}`, {
      disabled: !connection.disabledAt,
    });
    setPending(false);
    if (!result.ok) setError(result.message);
    else {
      setDisableId(null);
      await load();
    }
  }
  async function addInstallation(connection: Connection, form: HTMLFormElement) {
    setPending(true);
    setError("");
    const result = await clientApi(
      "POST",
      `/v1/github/connections/${connection.id}/installations`,
      { installationId: Number(new FormData(form).get("installationId")) },
    );
    setPending(false);
    if (!result.ok) setError(result.message);
    else {
      form.reset();
      setMessage("Installation verified and available to projects.");
    }
  }
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-heading`}>
      <Eyebrow>
        <span id={`${id}-heading`}>GitHub connections</span>
      </Eyebrow>
      <p className="text-sm text-(--mut)">
        Register private GitHub Apps here and choose a connection for each project repository. The
        instance default remains configured on the server. These connections do not change sign-in.
      </p>
      {loading && <p role="status">Loading connections…</p>}
      {!loading && !connections.length && (
        <p className="text-sm text-(--mut)">
          No additional connections. Existing projects keep the instance default.
        </p>
      )}
      {connections.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-col gap-3 rounded-md border border-(--line) p-4"
        >
          <p>
            <strong>{connection.name}</strong> · {connection.slug} ·{" "}
            {connection.disabledAt ? "Disabled" : "Enabled"}
          </p>
          <p className="break-all text-sm text-(--mut)">
            Webhook URL: <code>{connection.webhookUrl}</code>
          </p>
          {canManage && (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setEditing(connection);
                    setShowForm(true);
                  }}
                >
                  Rotate credentials
                </Button>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    connection.disabledAt ? void toggle(connection) : setDisableId(connection.id)
                  }
                >
                  {connection.disabledAt ? "Enable connection" : "Disable connection"}
                </Button>
              </div>
              {disableId === connection.id && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    Disable {connection.name}? Every project using it will lose new GitHub access
                    until it is enabled again.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={pending} onClick={() => void toggle(connection)}>
                      Confirm disable
                    </Button>
                    <Button size="sm" disabled={pending} onClick={() => setDisableId(null)}>
                      Keep enabled
                    </Button>
                  </div>
                </div>
              )}
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addInstallation(connection, event.currentTarget);
                }}
              >
                <label className="text-sm">
                  Additional installation ID
                  <input
                    className={inputClass}
                    name="installationId"
                    type="number"
                    min="1"
                    required
                    disabled={pending || !!connection.disabledAt}
                  />
                </label>
                <Button type="submit" size="sm" disabled={pending || !!connection.disabledAt}>
                  Add installation
                </Button>
              </form>
            </>
          )}
        </div>
      ))}
      {canManage && !showForm && (
        <div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            Add GitHub connection
          </Button>
        </div>
      )}
      {canManage && showForm && (
        <form
          key={editing?.id ?? "new"}
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void save(event.currentTarget);
          }}
        >
          <p className="text-sm">
            {editing
              ? `Rotate credentials for ${editing.name}`
              : "Create and install the GitHub App first. Keep it private and grant access only to the repositories you need."}
          </p>
          {!editing && (
            <>
              <label className="text-sm">
                Connection name
                <input
                  className={inputClass}
                  name="name"
                  required
                  maxLength={100}
                  disabled={pending}
                />
              </label>
              <label className="text-sm">
                App ID
                <input
                  className={inputClass}
                  name="appId"
                  type="number"
                  min="1"
                  required
                  disabled={pending}
                />
              </label>
              <label className="text-sm">
                Installation ID
                <input
                  className={inputClass}
                  name="installationId"
                  type="number"
                  min="1"
                  required
                  disabled={pending}
                />
              </label>
            </>
          )}
          <label className="text-sm">
            Private key (PEM)
            <textarea
              className={inputClass}
              name="privateKey"
              rows={4}
              required
              maxLength={20000}
              spellCheck={false}
              disabled={pending}
            />
          </label>
          <label className="text-sm">
            Webhook secret
            <input
              className={inputClass}
              name="webhookSecret"
              type="password"
              minLength={32}
              maxLength={256}
              required
              autoComplete="new-password"
              disabled={pending}
            />
          </label>
          <p className="text-sm text-(--mut)">
            Secrets are encrypted on the server and cannot be read back. Disabling a connection
            stops new GitHub access; already issued tokens may remain valid until they expire.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Verifying…" : "Verify and save"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
