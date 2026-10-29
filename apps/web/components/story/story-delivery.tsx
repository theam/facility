"use client";

import { Button, Eyebrow, Field, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { StoryDelivery } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { formatTime, safeExternalUrl } from "@/lib/story-presentation";

type Pull = StoryDelivery["pullRequests"][number];
type Selection = Pick<Pull, "repository" | "number" | "required" | "primary">;
const identity = (pull: Pick<Pull, "repository" | "number">) =>
  `${pull.repository.toLowerCase()}#${pull.number}`;
function newerSnapshot(previous: StoryDelivery | undefined, next: StoryDelivery) {
  return !previous ||
    next.scope.revision > previous.scope.revision ||
    (next.scope.revision === previous.scope.revision && next.generatedAt >= previous.generatedAt)
    ? next
    : previous;
}

export function StoryDeliveryPanel({
  projectId,
  storyId,
  initial,
  canWrite,
  canExecute = false,
}: {
  projectId: string;
  storyId: string;
  initial?: StoryDelivery;
  canWrite: boolean;
  canExecute?: boolean;
}) {
  const router = useRouter();
  const radioName = useId();
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Selection[]>([]);
  const [baseRevision, setBaseRevision] = useState(0);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const [query, setQuery] = useState("");
  const [available, setAvailable] = useState<NonNullable<StoryDelivery["available"]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const searchedQuery = useRef("");
  const readSequence = useRef(0);
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/delivery`;

  useEffect(() => {
    if (initial) setCurrent((previous) => newerSnapshot(previous, initial));
  }, [initial]);
  useEffect(
    () => () => {
      searchSequence.current++;
      readSequence.current++;
    },
    [],
  );

  function edit(snapshot: StoryDelivery) {
    setDraft(
      snapshot.pullRequests.map(({ repository, number, required, primary }) => ({
        repository,
        number,
        required,
        primary,
      })),
    );
    setBaseRevision(snapshot.scope.revision);
    setComplete(snapshot.scope.declaredComplete);
    setError(null);
    retry.current = null;
  }
  async function search(offset = 0, term?: string) {
    const sequence = ++searchSequence.current;
    setLoading(true);
    setSearchError(null);
    if (offset === 0) searchedQuery.current = term ?? query;
    const params = new URLSearchParams({
      include_available: "true",
      limit: "10",
      offset: String(offset),
      q: searchedQuery.current,
    });
    const result = await clientApi<StoryDelivery>("GET", `${path}?${params}`);
    if (sequence !== searchSequence.current) return;
    setLoading(false);
    if (!result.ok) {
      setSearchError(result.message);
      return;
    }
    const page = result.data.available;
    setAvailable((previous) =>
      page && offset > 0 && previous
        ? {
            ...page,
            items: [
              ...previous.items,
              ...page.items.filter(
                (pull) => !previous.items.some((old) => identity(old) === identity(pull)),
              ),
            ],
          }
        : page,
    );
  }
  async function reload(discardEdits = false) {
    if (savingRef.current) return;
    const sequence = ++readSequence.current;
    setError(null);
    const result = await clientApi<StoryDelivery>("GET", path);
    if (sequence !== readSequence.current) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCurrent((previous) => newerSnapshot(previous, result.data));
    if (discardEdits) edit(result.data);
  }
  async function save() {
    if (savingRef.current || !canWrite) return;
    const payload = {
      expected_revision: baseRevision,
      declared_complete: complete,
      pull_requests: draft,
    };
    const signature = JSON.stringify(payload);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    savingRef.current = true;
    readSequence.current++;
    setSaving(true);
    setError(null);
    const result = await clientApi<StoryDelivery>("POST", path, {
      ...payload,
      idempotency_key: retry.current.key,
    });
    savingRef.current = false;
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCurrent((previous) => newerSnapshot(previous, result.data));
    setEditing(false);
    retry.current = null;
    searchSequence.current++;
    router.refresh();
  }
  function change(next: Selection[]) {
    setDraft(next);
    setComplete(false);
    setError(null);
  }

  return (
    <section
      id="story-delivery"
      aria-label="Delivery pull requests"
      className="min-w-0 border border-(--line) p-5 lg:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>delivery</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold">Pull requests for this story</h2>
        </div>
        {current && canWrite && !editing ? (
          <Button
            size="sm"
            onClick={() => {
              edit(current);
              setEditing(true);
              setQuery("");
              setAvailable(null);
              void search(0, "");
            }}
          >
            Edit PR set
          </Button>
        ) : null}
      </div>
      {!current ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-(--mut)">
          <p>The delivery register is unavailable.</p>
          <Button size="sm" onClick={() => void reload()}>
            Load delivery
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-(--mut)">
            {current.candidate.state !== "scope_incomplete"
              ? `${current.candidate.mergedCount} of ${current.candidate.requiredCount} required PRs observed merged.`
              : "The complete set of required PRs has not been declared."}
          </p>
          {current.candidate.state === "stale" ? (
            <p className="mt-2 text-sm text-(--bad)">
              GitHub observations are stale. Refresh GitHub before evaluating this delivery.
            </p>
          ) : null}
          {current.candidate.state === "unobserved" ? (
            <p className="mt-2 text-sm text-(--bad)">
              A required PR has no observed head. Its current revision is unknown.
            </p>
          ) : null}
          {current.pullRequests.length === 0 ? (
            <p className="mt-4 text-sm text-(--dim)">No pull requests linked yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-(--line)">
              {current.pullRequests.map((pull) => (
                <li key={identity(pull)} className="min-w-0 py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {safeExternalUrl(pull.url) ? (
                      <a
                        className="min-w-0 break-all font-medium underline decoration-(--line-strong) underline-offset-4"
                        href={safeExternalUrl(pull.url) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {pull.repository} #{pull.number}
                      </a>
                    ) : (
                      <span className="break-all font-medium">
                        {pull.repository} #{pull.number}
                      </span>
                    )}
                    <span className="text-xs text-(--mut)">
                      {pull.primary ? "Primary · " : ""}
                      {pull.required ? "Required" : "Related"} · {pull.state}
                      {pull.draft ? " · draft" : ""}
                    </span>
                  </div>
                  {pull.title ? <p className="mt-2 break-words text-sm">{pull.title}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-(--mut)">
                    <span title={pull.headSha ?? undefined}>
                      Head: {pull.headSha?.slice(0, 12) ?? "not observed"}
                    </span>
                    <span>
                      {pull.checks.state === "unobserved"
                        ? "CI not observed"
                        : `CI ${pull.checks.state} · ${pull.checks.current ? "current head" : pull.checks.headSha && pull.headSha ? "older commit" : "head not verified"}`}
                    </span>
                    <span>
                      {pull.stale ? "Stale observation" : `Observed ${formatTime(pull.observedAt)}`}
                    </span>
                  </div>
                  {pull.origin === "legacy" ? (
                    <p className="mt-2 text-xs text-(--dim)">
                      Source PR association. Confirm all required PRs before treating this as a
                      complete set.
                    </p>
                  ) : null}
                  <details className="mt-3 text-xs text-(--mut)">
                    <summary className="cursor-pointer">
                      {pull.reviews.state === "unobserved"
                        ? "Reviews not observed"
                        : `Observed reviews · ${pull.reviews.currentHeadCount} on current head${pull.reviews.unverifiedHeadCount ? ` · ${pull.reviews.unverifiedHeadCount} not verified on current head` : ""}`}
                      {pull.reviews.truncated ? " · partial sample" : ""}
                    </summary>
                    {pull.reviews.latest.length ? (
                      <ul className="mt-2 space-y-2">
                        {pull.reviews.latest.map((review) => (
                          <li key={review.reviewId} className="break-words">
                            {review.author ?? "Unknown reviewer"}:{" "}
                            {review.state.replaceAll("_", " ").toLowerCase()} ·{" "}
                            {review.current
                              ? "current head"
                              : !review.commitSha
                                ? "commit unknown"
                                : !pull.headSha
                                  ? "current head unknown"
                                  : "other commit"}
                            {safeExternalUrl(review.url) ? (
                              <>
                                {" "}
                                ·{" "}
                                <a
                                  href={safeExternalUrl(review.url) ?? undefined}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline"
                                >
                                  View review
                                </a>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2">No reviews observed.</p>
                    )}
                    <p className="mt-2 text-(--dim)">
                      GitHub remains the source for required checks and branch protection.
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {current.candidate.revision ? (
            <details className="mt-2 text-xs text-(--dim)">
              <summary className="cursor-pointer">Observed revision</summary>
              <p className="mt-2 break-all font-mono">{current.candidate.revision}</p>
              <p className="mt-1">Identifies the declared scope and required PR heads.</p>
            </details>
          ) : null}
        </>
      )}

      {editing && canWrite ? (
        <div className="mt-5 border-t border-(--line) pt-5">
          <h3 className="font-medium">Required delivery scope</h3>
          <p className="mt-2 text-sm text-(--mut)">
            Choose PRs already observed in this project. Select one required primary.
          </p>
          {current && current.scope.revision !== baseRevision ? (
            <p role="status" className="mt-3 text-sm text-(--bad)">
              The saved set changed while you were editing. Your edits are retained; reload the
              saved set before saving.
            </p>
          ) : null}
          <fieldset disabled={saving} className="mt-4 min-w-0 space-y-4">
            <legend className="sr-only">Edit delivery pull requests</legend>
            {draft.map((pull) => (
              <div key={identity(pull)} className="min-w-0 border border-(--line) p-3">
                <p className="break-all text-sm font-medium">
                  {pull.repository} #{pull.number}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      aria-label={`Primary for ${pull.repository} #${pull.number}`}
                      name={radioName}
                      checked={pull.primary}
                      onChange={() =>
                        change(
                          draft.map((item) => ({
                            ...item,
                            primary: identity(item) === identity(pull),
                            required: identity(item) === identity(pull) || item.required,
                          })),
                        )
                      }
                    />
                    Primary
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`Required for ${pull.repository} #${pull.number}`}
                      checked={pull.required}
                      disabled={pull.primary}
                      onChange={(event) =>
                        change(
                          draft.map((item) =>
                            identity(item) === identity(pull)
                              ? { ...item, required: event.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    Required
                  </label>
                  <Button
                    size="sm"
                    aria-label={`Remove ${pull.repository} #${pull.number}`}
                    onClick={() => {
                      const next = draft.filter((item) => identity(item) !== identity(pull));
                      if (pull.primary && next[0])
                        next[0] = { ...next[0], primary: true, required: true };
                      change(next);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Find a project PR" className="min-w-0 flex-1">
                <TextInput
                  value={query}
                  maxLength={200}
                  placeholder="Repository, title or PR number"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void search();
                    }
                  }}
                />
              </Field>
              <Button disabled={loading} onClick={() => void search()}>
                Search PRs
              </Button>
            </div>
            {loading ? (
              <p role="status" className="text-sm text-(--mut)">
                Loading project PRs…
              </p>
            ) : null}
            {searchError ? (
              <p role="alert" className="break-words text-sm text-(--bad)">
                {searchError}
              </p>
            ) : null}
            {available ? (
              <>
                {available.items.length === 0 && !loading ? (
                  <p className="text-sm text-(--dim)">No matching PRs in the project mirror.</p>
                ) : null}
                <ul className="space-y-2">
                  {available.items.map((pull) => (
                    <li
                      key={identity(pull)}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-(--line) p-3"
                    >
                      <div className="min-w-0 flex-1 basis-36 text-sm">
                        <p className="break-all font-medium">
                          {pull.repository} #{pull.number}
                        </p>
                        <p className="mt-1 break-words text-(--mut)">
                          {pull.title}
                          {pull.stale ? " · stale observation" : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={
                          draft.length >= 50 ||
                          draft.some((item) => identity(item) === identity(pull))
                        }
                        aria-label={`Add ${pull.repository} #${pull.number}`}
                        onClick={() =>
                          change([
                            ...draft,
                            {
                              repository: pull.repository,
                              number: pull.number,
                              required: true,
                              primary: draft.length === 0,
                            },
                          ])
                        }
                      >
                        {draft.some((item) => identity(item) === identity(pull)) ? "Added" : "Add"}
                      </Button>
                    </li>
                  ))}
                </ul>
                {available.hasMore && available.nextOffset !== null ? (
                  <Button
                    size="sm"
                    disabled={loading}
                    onClick={() => {
                      if (available.nextOffset !== null) void search(available.nextOffset);
                    }}
                  >
                    More PRs
                  </Button>
                ) : null}
              </>
            ) : null}
            <label className="flex items-start gap-3 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={complete}
                disabled={!draft.length}
                onChange={(event) => setComplete(event.target.checked)}
              />
              <span>These are all the PRs required to deliver this story.</span>
            </label>
            <p className="text-xs text-(--dim)">
              This declares the PR scope. Acceptance and merges are recorded separately. Changes are
              limited to 50 PRs per story.
            </p>
            <div className="flex flex-wrap gap-3">
              <p className="basis-full text-sm text-(--mut)">
                {canExecute
                  ? "Saving also authorizes automatic preview updates for this PR set. Facility may fetch commits, update managed workspace code and rebuild or restart the app. Your data is retained. This does not start an AI agent."
                  : "Saving records the PR set. Updating the preview requires workspace execution permission."}
              </p>
              <Button variant="primary" onClick={() => void save()}>
                {saving ? "Saving…" : canExecute ? "Save PR set and update preview" : "Save PR set"}
              </Button>
              <Button
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  searchSequence.current++;
                }}
              >
                Cancel edits
              </Button>
              {error || (current && current.scope.revision !== baseRevision) ? (
                <Button
                  className="h-auto min-h-10 max-w-full whitespace-normal py-2"
                  onClick={() => void reload(true)}
                >
                  Reload saved set (discard edits)
                </Button>
              ) : null}
            </div>
          </fieldset>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
    </section>
  );
}
