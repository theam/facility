"use client";

import {
  Button,
  Cell,
  Divider,
  Eyebrow,
  Field,
  HairlineGrid,
  PillTag,
  StatusDot,
  TextInput,
} from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Project, ProjectRepo } from "@/lib/api";

/**
 * Kickstart, one screen: pick a repository the GitHub App can already see (or
 * name a new one), preview the generated assets, open the PR. No
 * greenfield/existing question, no typed slugs — the installation knows the
 * repos (REDESIGN §4a).
 */

type Installation = {
  id: string;
  installationId: number;
  accountLogin: string;
  targetType: string;
  suspendedAt?: string | null;
};

type PickableRepo = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl?: string;
};

type KickstartPreview = {
  detection?: {
    defaultBranch?: string;
    packageManager?: string;
    checks?: string[];
    provision?: string;
    suggestedModules?: string[];
  };
  files: Array<{ path: string; size: number; sha256: string; action?: string }>;
  skipped?: string[];
};

type KickstartResult = {
  branch?: string;
  commitSha?: string;
  pr?: { number?: number; url?: string; html_url?: string };
};

type Source =
  | { kind: "existing"; repo: PickableRepo }
  | { kind: "new"; owner: string; name: string }
  | { kind: "manual"; owner: string; name: string };

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const error =
      payload?.error && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : null;
    const message =
      typeof error?.message === "string"
        ? error.message
        : typeof payload?.message === "string"
          ? payload.message
          : null;
    throw new Error(message ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function KickstartPage() {
  const router = useRouter();

  // Repo discovery
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [installationsError, setInstallationsError] = useState<string | null>(null);
  const [activeInstallation, setActiveInstallation] = useState<Installation | null>(null);
  const [repos, setRepos] = useState<PickableRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"pick" | "new" | "manual">("pick");

  // Selection + project details
  const [source, setSource] = useState<Source | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [manualRepo, setManualRepo] = useState("");

  // Flow state
  const [phase, setPhase] = useState<"pick" | "previewing" | "preview" | "opening" | "done">(
    "pick",
  );
  const [project, setProject] = useState<Project | null>(null);
  const [repoRow, setRepoRow] = useState<ProjectRepo | null>(null);
  const [preview, setPreview] = useState<KickstartPreview | null>(null);
  const [result, setResult] = useState<KickstartResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiJson<Installation[]>("/v1/github/installations");
        if (cancelled) return;
        setInstallations(list);
        setActiveInstallation(list[0] ?? null);
      } catch (err) {
        if (cancelled) return;
        setInstallations([]);
        setInstallationsError(err instanceof Error ? err.message : "installations unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeInstallation) return;
    let cancelled = false;
    setReposLoading(true);
    setRepos(null);
    (async () => {
      try {
        const list = await apiJson<{ items: PickableRepo[]; truncated?: boolean }>(
          `/v1/github/installations/${activeInstallation.installationId}/repos`,
        );
        if (cancelled) return;
        setRepos(list.items ?? []);
      } catch {
        if (!cancelled) setRepos([]);
      } finally {
        if (!cancelled) setReposLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeInstallation]);

  const filteredRepos = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  const effectiveSlug = useMemo(() => slugify(name), [name]);

  function pickExisting(repo: PickableRepo) {
    setSource({ kind: "existing", repo });
    if (!name) setName(repo.name);
    setError(null);
  }

  function sourceLabel(s: Source) {
    if (s.kind === "existing") return s.repo.fullName;
    return `${s.owner}/${s.name}`;
  }

  async function loadPreview() {
    const s = source;
    if (!s || !name.trim() || !effectiveSlug) return;
    setPhase("previewing");
    setError(null);
    try {
      const created =
        project ??
        (await apiJson<Project>("/v1/projects", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            slug: effectiveSlug,
            description: description.trim() || undefined,
            settings: { check_cmds: [] },
          }),
        }));
      setProject(created);

      const owner = s.kind === "existing" ? s.repo.owner : s.owner;
      const repoName = s.kind === "existing" ? s.repo.name : s.name;
      const defaultBranch = s.kind === "existing" ? s.repo.defaultBranch : "main";
      const existing = await apiJson<ProjectRepo[]>(`/v1/projects/${created.id}/repos`);
      const match = existing.find(
        (item) =>
          `${item.owner}/${item.name}`.toLowerCase() === `${owner}/${repoName}`.toLowerCase(),
      );
      const connected =
        match ??
        (await apiJson<ProjectRepo>(`/v1/projects/${created.id}/repos`, {
          method: "POST",
          body: JSON.stringify({
            owner,
            name: repoName,
            defaultBranch,
            ...(s.kind === "new"
              ? {
                  mode: "create",
                  create: true,
                  private: true,
                  description: description.trim() || undefined,
                }
              : {}),
          }),
        }));
      setRepoRow(connected);

      const nextPreview = await apiJson<KickstartPreview>(
        `/v1/projects/${created.id}/kickstart/preview?repoId=${encodeURIComponent(connected.id)}`,
      );
      setPreview(nextPreview);
      setPhase("preview");
    } catch (err) {
      setPhase("pick");
      setError(err instanceof Error ? err.message : "preview failed");
    }
  }

  async function openPr() {
    if (!project || !repoRow || !preview) return;
    setPhase("opening");
    setError(null);
    try {
      const answers = {
        defaultBranch: preview.detection?.defaultBranch ?? repoRow.defaultBranch,
        provisionCmd: preview.detection?.provision || undefined,
        checkCmds: preview.detection?.checks?.length ? preview.detection.checks : undefined,
        modules: preview.detection?.suggestedModules?.length
          ? preview.detection.suggestedModules
          : undefined,
        modelTier: "tam-50",
        execution_lane: { architect: "platform", builder: "platform" },
      };
      const kickstart = await apiJson<KickstartResult>(`/v1/projects/${project.id}/kickstart`, {
        method: "POST",
        body: JSON.stringify({ repoId: repoRow.id, answers, mode: "pr" }),
      });
      setResult(kickstart);
      setPhase("done");
      router.refresh();
    } catch (err) {
      setPhase("preview");
      setError(err instanceof Error ? err.message : "could not open the kickstart PR");
    }
  }

  const prUrl = result?.pr?.url ?? result?.pr?.html_url;
  const busy = phase === "previewing" || phase === "opening";

  // Preview needs real project/repo rows, so they exist before the final
  // confirm — discarding deletes the draft project instead of orphaning it.
  async function discardDraft() {
    if (!project) {
      setPhase("pick");
      return;
    }
    setError(null);
    try {
      await apiJson(`/v1/projects/${project.id}`, { method: "DELETE" });
    } catch (err) {
      setError(
        err instanceof Error
          ? `couldn't discard the draft project — ${err.message}`
          : "couldn't discard the draft project",
      );
      return;
    }
    setProject(null);
    setRepoRow(null);
    setPreview(null);
    setPhase("pick");
    router.refresh();
  }

  return (
    <div className="flex max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>kickstart</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">
          Kickstart a project
        </h1>
        <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
          pick a repository → preview the assets → open the PR
        </p>
      </div>

      {error ? (
        <div className="border border-(--bad) bg-(--bg-subtle) p-4 text-sm leading-relaxed text-(--bad)">
          {error}
        </div>
      ) : null}

      {phase === "pick" || phase === "previewing" ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setTab("pick")}>
                <PillTag active={tab === "pick"}>from the github app</PillTag>
              </button>
              <button type="button" onClick={() => setTab("new")}>
                <PillTag active={tab === "new"}>new repository</PillTag>
              </button>
              <button type="button" onClick={() => setTab("manual")}>
                <PillTag active={tab === "manual"}>type owner/name</PillTag>
              </button>
            </div>

            {tab === "pick" ? (
              <div className="flex flex-col gap-3">
                {installations === null ? (
                  <p className="text-sm text-(--dim)">Loading installations…</p>
                ) : installations.length === 0 ? (
                  <div className="border border-(--line) bg-(--bg-subtle) p-5 text-sm leading-relaxed text-(--mut)">
                    {installationsError
                      ? `Repo discovery isn't available (${installationsError}). Use "type owner/name".`
                      : 'No GitHub App installation is visible yet. Install the Facility GitHub App on your org, then reload — or use "type owner/name".'}
                  </div>
                ) : (
                  <>
                    {installations.length > 1 ? (
                      <div className="flex flex-wrap gap-2">
                        {installations.map((inst) => (
                          <button
                            key={inst.id}
                            type="button"
                            onClick={() => setActiveInstallation(inst)}
                          >
                            <PillTag active={inst.id === activeInstallation?.id}>
                              {inst.accountLogin}
                            </PillTag>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <TextInput
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="find repository…"
                      aria-label="Find repository"
                    />
                    <div className="flex max-h-[340px] flex-col overflow-y-auto border border-(--line)">
                      {reposLoading ? (
                        <p className="px-5 py-4 text-sm text-(--dim)">Reading repositories…</p>
                      ) : filteredRepos.length === 0 ? (
                        <p className="px-5 py-4 text-sm text-(--dim)">
                          No repository matches. The App only lists repos it was granted.
                        </p>
                      ) : (
                        filteredRepos.map((repo) => {
                          const selected =
                            source?.kind === "existing" && source.repo.fullName === repo.fullName;
                          return (
                            <button
                              key={repo.fullName}
                              type="button"
                              onClick={() => pickExisting(repo)}
                              className={`flex items-center gap-3 border-b border-(--line) px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-(--card) ${selected ? "bg-(--card)" : ""}`}
                            >
                              <StatusDot tone={selected ? "agent" : "machine"} />
                              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-(--ink)">
                                {repo.fullName}
                              </span>
                              {repo.private ? <PillTag>private</PillTag> : null}
                              <span className="font-mono text-[10.5px] text-(--dim)">
                                {repo.defaultBranch}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {tab === "new" ? (
              <div className="flex flex-col gap-4">
                <Field
                  label="repository name"
                  hint={`Created privately under ${activeInstallation?.accountLogin ?? "your org"} through the App installation.`}
                >
                  <TextInput
                    value={newRepoName}
                    onChange={(e) => {
                      const next = slugify(e.target.value);
                      setNewRepoName(next);
                      if (activeInstallation && next) {
                        setSource({
                          kind: "new",
                          owner: activeInstallation.accountLogin,
                          name: next,
                        });
                        if (!name) setName(next);
                      }
                    }}
                    placeholder="my-service"
                  />
                </Field>
                {!activeInstallation ? (
                  <p className="text-sm text-(--dim)">
                    Creating a repository needs a GitHub App installation.
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === "manual" ? (
              <Field
                label="repository"
                hint="owner/name or a github.com URL — for repos the App can't list yet."
              >
                <TextInput
                  value={manualRepo}
                  onChange={(e) => {
                    setManualRepo(e.target.value);
                    const cleaned = e.target.value
                      .trim()
                      .replace(/^https:\/\/github\.com\//, "")
                      .replace(/\.git$/, "");
                    const [owner, repoName] = cleaned.split("/");
                    if (owner && repoName) {
                      setSource({ kind: "manual", owner, name: repoName });
                      if (!name) setName(repoName);
                    }
                  }}
                  placeholder="theam/tam-os"
                />
              </Field>
            ) : null}

            <Divider />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="project name">
                <TextInput
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={source && source.kind === "existing" ? source.repo.name : "project"}
                />
              </Field>
              <Field label="description">
                <TextInput
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this project is, for humans and agents."
                />
              </Field>
            </div>

            <div className="flex items-center gap-4">
              <Button
                type="button"
                variant="primary"
                tone="agent"
                size="lg"
                disabled={!source || !name.trim() || busy}
                onClick={() => void loadPreview()}
              >
                {phase === "previewing" ? "reading repository…" : "preview kickstart"}
              </Button>
              {source ? (
                <span className="font-mono text-[11.5px] text-(--mut)">{sourceLabel(source)}</span>
              ) : (
                <span className="font-mono text-[11.5px] text-(--dim)">
                  pick a repository first
                </span>
              )}
            </div>
          </div>

          <aside className="flex h-fit flex-col gap-4 border border-(--line) bg-(--bg-subtle) p-5">
            <Eyebrow>what kickstart does</Eyebrow>
            <p className="text-sm leading-relaxed text-(--mut)">
              Facility reads the repository, detects its shape (package manager, checks, workflows),
              and opens one PR adding the factory assets: workflows, agent prompts, guards, skills,
              and the standard. Nothing lands on the default branch without your merge.
            </p>
            <Divider />
            <p className="font-mono text-[11px] leading-relaxed text-(--dim)">
              project slug · {effectiveSlug || "—"}
            </p>
          </aside>
        </div>
      ) : null}

      {phase === "preview" || phase === "opening" ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-col gap-3 border border-(--line) bg-(--bg-subtle) p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <Eyebrow>preview</Eyebrow>
                <p className="mt-2 break-all font-mono text-[15px] text-(--ink)">
                  {source ? sourceLabel(source) : ""}
                </p>
              </div>
              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={() => setPhase("pick")}>
                  back
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void discardDraft()}
                  title="Deletes the draft project created for this preview"
                >
                  discard draft
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  tone="agent"
                  disabled={busy || !preview?.files.length}
                  onClick={() => void openPr()}
                >
                  {phase === "opening" ? "opening PR…" : "open kickstart PR"}
                </Button>
              </div>
            </div>

            {preview ? (
              <>
                <HairlineGrid cols="grid-cols-2 lg:grid-cols-4">
                  <Cell className="p-4">
                    <KeyValue
                      label="branch"
                      value={preview.detection?.defaultBranch ?? repoRow?.defaultBranch ?? "main"}
                    />
                  </Cell>
                  <Cell className="p-4">
                    <KeyValue label="package" value={preview.detection?.packageManager ?? "none"} />
                  </Cell>
                  <Cell className="p-4">
                    <KeyValue
                      label="checks"
                      value={String(preview.detection?.checks?.length ?? 0)}
                    />
                  </Cell>
                  <Cell className="p-4">
                    <KeyValue label="files" value={String(preview.files.length)} />
                  </Cell>
                </HairlineGrid>

                <div className="flex max-h-[420px] flex-col overflow-y-auto border border-(--line)">
                  {preview.files.map((file) => (
                    <div
                      key={`${file.path}:${file.sha256}`}
                      className="flex items-center gap-3 border-b border-(--line) px-4 py-2.5 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 break-all font-mono text-[12px] text-(--ink)">
                        {file.path}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-(--dim)">
                        {file.action ?? "write"}
                      </span>
                      <span className="font-mono text-[10.5px] text-(--mut)">
                        {formatBytes(file.size)}
                      </span>
                    </div>
                  ))}
                </div>
                {preview.skipped?.length ? (
                  <p className="text-[12.5px] leading-relaxed text-(--mut)">
                    Skipped existing managed sections: {preview.skipped.join(", ")}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <aside className="flex h-fit flex-col gap-4 border border-(--line) bg-(--bg-subtle) p-5">
            <Eyebrow>detected</Eyebrow>
            <KeyValue label="provision" value={preview?.detection?.provision || "none"} />
            <KeyValue label="checks" value={preview?.detection?.checks?.join(" / ") || "none"} />
            <KeyValue
              label="modules"
              value={preview?.detection?.suggestedModules?.join(", ") || "base"}
            />
            <KeyValue label="lane" value="platform — sessions run in Facility sandboxes" />
          </aside>
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="flex max-w-2xl flex-col gap-5">
          <div className="flex flex-col gap-4 border border-(--ok) bg-(--bg-subtle) p-6">
            <div className="flex items-center gap-3">
              <StatusDot tone="ok" />
              <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-(--ok)">
                kickstart PR opened
              </span>
            </div>
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all font-mono text-[13px] text-(--ink) underline underline-offset-4"
              >
                {prUrl}
              </a>
            ) : (
              <KeyValue label="branch" value={result?.branch ?? "facility/kickstart"} />
            )}
          </div>
          <div className="flex flex-col gap-3 border border-(--line) p-6">
            <Eyebrow>next</Eyebrow>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-(--mut)">
              <li>Review and merge the kickstart PR — that installs the factory.</li>
              <li>
                Check the{" "}
                {project ? (
                  <Link
                    href={`/projects/${project.id}`}
                    className="text-(--ink) underline underline-offset-4"
                  >
                    project overview
                  </Link>
                ) : (
                  "project overview"
                )}{" "}
                — health and fingerprints verify after the merge lands.
              </li>
              <li>
                Trigger the first session from{" "}
                {project ? (
                  <Link
                    href={`/projects/${project.id}/issues`}
                    className="text-(--ink) underline underline-offset-4"
                  >
                    issues
                  </Link>
                ) : (
                  "issues"
                )}
                .
              </li>
            </ol>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-(--dim)">
        {label}
      </span>
      <span className="break-words font-mono text-[12px] leading-relaxed text-(--code)">
        {value}
      </span>
    </div>
  );
}
