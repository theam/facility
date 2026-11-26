type GithubObject = Record<string, unknown>;

/** The most event context one agent prompt carries. */
export const GITHUB_EVENT_CONTEXT_LIMIT = 16_000;

const EVENT_OBJECTS = [
  "issue",
  "comment",
  "pull_request",
  "review",
  "check_suite",
  "workflow_run",
] as const;

type EventObject = (typeof EVENT_OBJECTS)[number];

// The object that started the event leads, so trimming never removes the request itself:
// a comment on a long issue keeps the comment.
const TRIGGERING_OBJECT: Record<string, EventObject> = {
  issues: "issue",
  issue_comment: "comment",
  pull_request: "pull_request",
  pull_request_review: "review",
  check_suite: "check_suite",
  workflow_run: "workflow_run",
};

const TEXT_FIELDS = new Set(["title", "body"]);
const OTHER_TEXT_CAPS = [Number.POSITIVE_INFINITY, 4_000, 1_000, 200, 0];

export type GithubEventContext = {
  delivery: string;
  repository: string;
  event: string;
  action: string | null;
} & Record<EventObject, GithubObject | null>;

/** Serializes event context within the limit. Text is shortened field by field, so the
 * result is always complete JSON; other objects' text gives way before the triggering one. */
export function githubEventContextJson(
  context: GithubEventContext,
  limit = GITHUB_EVENT_CONTEXT_LIMIT,
) {
  const triggering = TRIGGERING_OBJECT[context.event];
  const render = (triggeringCap: number, otherCap: number) => {
    const { delivery, repository, event, action } = context;
    const ordered: Record<string, unknown> = { delivery, repository, event, action };
    const names = triggering
      ? [triggering, ...EVENT_OBJECTS.filter((name) => name !== triggering)]
      : EVENT_OBJECTS;
    for (const name of names)
      ordered[name] = shorten(context[name], name === triggering ? triggeringCap : otherCap);
    return JSON.stringify(ordered);
  };
  for (const otherCap of OTHER_TEXT_CAPS) {
    const json = render(Number.POSITIVE_INFINITY, otherCap);
    if (json.length <= limit) return json;
  }
  for (
    let triggeringCap = limit;
    triggeringCap > 0;
    triggeringCap = Math.floor(triggeringCap / 2)
  ) {
    const json = render(triggeringCap, 0);
    if (json.length <= limit) return json;
  }
  return render(0, 0);
}

function shorten(value: GithubObject | null, cap: number) {
  if (!value || cap === Number.POSITIVE_INFINITY) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      TEXT_FIELDS.has(key) && typeof field === "string" && field.length > cap
        ? `${field.slice(0, cap)}… [${field.length - cap} characters omitted]`
        : field,
    ]),
  );
}
