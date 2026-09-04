import { createHash } from "node:crypto";

export type GithubIssueRevisionComment = {
  id: number;
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
  url: string;
};

type GithubIssueLike = {
  title?: unknown;
  body?: unknown;
  state?: unknown;
  user?: { login?: unknown } | null;
  labels?: unknown;
  html_url?: unknown;
};

const FACILITY_COMMENT_MARKERS = ["<!-- facility-run-progress", "<!-- facility:architect-plan:"];
const FACILITY_QUEUED_RUN =
  /^<!-- facility-run-queued run=(run_[a-z0-9]+) -->\r?\nFacility queued (.+?) run \1 \(triggered (?:from the control plane|through an approved MCP proposal)\)\.\s*$/is;
// Keep old issues usable after upgrading, but match only the exact historical
// acknowledgement. The Bot-author check below prevents user lookalikes from
// disappearing from the issue revision.
const LEGACY_FACILITY_QUEUED_RUN =
  /^Facility queued (.+?) run run_[a-z0-9]+ \(triggered (?:from the control plane|through an approved MCP proposal)\)\.\s*$/is;
const BUILDER_APPROVAL_ONLY = /^\s*\/(?:codex-)?builder\s*[.!?]?\s*$/i;

/**
 * Produce the repository-owned issue snapshot that Architect actually plans
 * against. Volatile GitHub timestamps and Facility's own progress/publication
 * comments are deliberately excluded, as is the exact `/builder` approval
 * command: those artifacts are consequences of the plan, not changes to its
 * scope. Any substantive text alongside `/builder` remains material.
 */
export function githubIssueRevisionContext(
  issue: GithubIssueLike | null | undefined,
  comments: GithubIssueRevisionComment[] = [],
) {
  const state = issue?.state === "open" || issue?.state === "closed" ? issue.state : null;
  return {
    version: "facility/github-issue-revision/v1",
    title: normalizedText(issue?.title),
    body: normalizedText(issue?.body),
    state,
    author: normalizedText(issue?.user?.login),
    url: normalizedText(issue?.html_url),
    labels: issueLabels(issue?.labels),
    comments: comments
      .filter(materialIssueComment)
      .map((comment) => ({
        id: comment.id,
        author: normalizedText(comment.author),
        authorType: normalizedText(comment.authorType),
        body: normalizedText(comment.body),
        createdAt: normalizedText(comment.createdAt),
        url: normalizedText(comment.url),
      }))
      .sort((left, right) => left.id - right.id),
  };
}

export function githubIssueRevisionSha256(value: unknown): string | null {
  const request = objectValue(value);
  const comments = Array.isArray(request.comments)
    ? request.comments.flatMap((entry) => {
        const comment = objectValue(entry);
        return typeof comment.id === "number" && Number.isInteger(comment.id)
          ? [
              {
                id: comment.id,
                author: stringValue(comment.author),
                authorType: stringValue(comment.authorType),
                body: stringValue(comment.body),
                createdAt: stringValue(comment.createdAt),
                url: stringValue(comment.url),
              },
            ]
          : [];
      })
    : [];
  const context = githubIssueRevisionContext(
    {
      title: request.title,
      body: request.body,
      state: request.state,
      user: { login: request.author },
      labels: request.labels,
      html_url: request.url,
    },
    comments,
  );
  if (!context.title || !context.url) return null;
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

function materialIssueComment(comment: GithubIssueRevisionComment) {
  if (BUILDER_APPROVAL_ONLY.test(comment.body)) return false;
  return !(
    comment.authorType.toLowerCase() === "bot" &&
    (FACILITY_COMMENT_MARKERS.some((marker) => comment.body.includes(marker)) ||
      FACILITY_QUEUED_RUN.test(comment.body) ||
      LEGACY_FACILITY_QUEUED_RUN.test(comment.body))
  );
}

function issueLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((label) => {
        const name = typeof label === "string" ? label : objectValue(label).name;
        const normalized = normalizedText(name);
        return normalized ? [normalized] : [];
      }),
    ),
  ].sort();
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
