"use client";

import { Button, Eyebrow, Field, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  LocalKickstart,
  LocalRepositoryRegistration,
  LocalRepositoryStatus,
  Project,
} from "@/lib/api";
import { clientApi } from "@/lib/client-api";

/**
 * A project backed by a Git repository on the machine running Facility. No
 * GitHub App, installation, or hosted remote is involved: Facility imports the
 * committed history into its own workspaces, and starter configuration comes
 * back as a patch the user reviews and commits themselves.
 */
export default function LocalProjectPage() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalRepositoryStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [repository, setRepository] = useState<LocalRepositoryRegistration | null>(null);
  const [kickstart, setKickstart] = useState<LocalKickstart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void clientApi<LocalRepositoryStatus>("GET", "/v1/local-repositories/status").then((result) => {
      if (result.ok) setStatus(result.data);
      else setStatusError(result.message);
    });
  }, []);

  const slug = useMemo(
    () =>
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60),
    [name],
  );

  async function register() {
    setBusy(true);
    setError("");
    const created =
      project ??
      (await clientApi<Project>("POST", "/v1/projects", {
        name: name.trim(),
        slug,
      }).then((result) => {
        if (!result.ok) {
          setError(result.message);
          return null;
        }
        setProject(result.data);
        return result.data;
      }));
    if (!created) {
      setBusy(false);
      return;
    }
    const registered = await clientApi<LocalRepositoryRegistration>(
      "POST",
      `/v1/projects/${encodeURIComponent(created.id)}/repos/local`,
      { path: path.trim(), ...(alias.trim() ? { alias: alias.trim() } : {}) },
    );
    if (!registered.ok) {
      setError(registered.message);
      setBusy(false);
      return;
    }
    setRepository(registered.data);
    const starter = await clientApi<LocalKickstart>(
      "POST",
      `/v1/projects/${encodeURIComponent(created.id)}/repos/${encodeURIComponent(registered.data.id)}/local-kickstart`,
      { answers: startCommand.trim() ? { startCmd: startCommand.trim() } : {} },
    );
    if (starter.ok) setKickstart(starter.data);
    else setError(`Registered, but the starter configuration failed: ${starter.message}`);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>local repository</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
          Start a project from a repository on this machine
        </h1>
        <p className="text-[12.5px] text-(--mut)">
          Agents work on Facility-managed copies in local Docker workspaces. You review, request
          revisions, and import approved commits back into your repository. Model calls still go to
          your configured AI provider.{" "}
          <Link className="text-(--info) underline" href="/projects/new">
            Use GitHub instead
          </Link>
        </p>
      </div>

      {statusError ? (
        <p className="text-sm text-(--bad)">
          Couldn't check local repository support — {statusError}
        </p>
      ) : status && !status.enabled ? (
        <div className="border border-(--line) bg-(--bg-subtle) p-5 text-sm leading-relaxed text-(--mut)">
          Local repositories are disabled on this Facility instance. An operator enables them by
          setting <code>FACILITY_LOCAL_REPOSITORY_ROOTS</code> to the directories Facility may read,
          then restarting the API and worker.
        </div>
      ) : null}

      {error ? (
        <div className="border border-(--bad) bg-(--bg-subtle) p-4 text-sm text-(--bad)">
          {error}
        </div>
      ) : null}

      {status?.enabled && !repository ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <Field label="Project name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field
            label="Repository path on the Facility host"
            hint={`Must be inside: ${status.roots.join(", ")}`}
          >
            <TextInput
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={`${status.roots[0] ?? "/path/to/code"}/my-app`}
              required
            />
          </Field>
          <Field
            label="Alias (optional)"
            hint="Used as local:<alias> in .facility.yml. Defaults to the folder name."
          >
            <TextInput value={alias} onChange={(event) => setAlias(event.target.value)} />
          </Field>
          <Field
            label="Development start command (optional)"
            hint="Used in the proposed .facility.yml."
          >
            <TextInput
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder="pnpm dev"
            />
          </Field>
          <p className="border border-(--line) p-4 text-[12.5px] leading-relaxed text-(--mut)">
            Facility imports <strong>committed history</strong> from the default branch only.
            Uncommitted and untracked files in your checkout are never copied, and Facility never
            writes to your repository.
          </p>
          <div>
            <Button type="submit" disabled={busy || !slug || !path.trim()}>
              {busy ? "Registering…" : "Register repository"}
            </Button>
          </div>
        </form>
      ) : null}

      {repository ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Registered {repository.manifestName}</h2>
          <p className="text-sm text-(--mut)">
            {repository.sourcePath} · {repository.defaultBranch} at{" "}
            <span className="font-mono">{repository.headSha.slice(0, 12)}</span>
          </p>
          {repository.warnings.map((warning) => (
            <p key={warning} className="text-sm text-(--human)">
              {warning}
            </p>
          ))}
          {kickstart ? (
            kickstart.files.length === 0 ? (
              <p className="text-sm text-(--mut)">
                The repository already has .facility.yml and its agents. Start a story when you're
                ready.
              </p>
            ) : (
              <>
                <p className="text-sm text-(--mut)">
                  Review this starter configuration, save it as{" "}
                  <code>facility-kickstart.patch</code> in your repository, then apply and commit
                  it:
                </p>
                <pre className="overflow-auto bg-(--bg-subtle) p-3 text-[11.5px]">
                  {kickstart.instructions.join("\n")}
                </pre>
                <textarea
                  readOnly
                  aria-label="Starter configuration patch"
                  className="h-72 w-full border border-(--line) bg-(--bg-subtle) p-3 font-mono text-[11.5px]"
                  value={kickstart.patch}
                />
              </>
            )
          ) : null}
          {project ? (
            <div>
              <Link
                className="text-(--info) underline"
                href={`/projects/${encodeURIComponent(project.id)}`}
              >
                Open the project →
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
