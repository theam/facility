import { describe, expect, it } from "vitest";
import { mergePersons, searchMatches } from "../src/stories/backlog.js";
import {
  derivePhase,
  pickPullRequest,
  provisionalTitle,
  resolveDefaultAgent,
  reviewDecision,
} from "../src/stories/phase.js";
import { sanitizeGeneratedTitle, titleCredentials } from "../src/stories/titles.js";

const openPull = {
  number: 7,
  title: "Add search",
  url: "https://github.com/acme/app/pull/7",
  repository: "acme/app",
  state: "open" as const,
  draft: false,
  ciState: null,
  ciFailureNames: [],
  reviewState: null,
  headRef: "feature/search",
  updatedAt: new Date("2026-09-10T10:00:00Z"),
};
const startedStory = { status: "working", deletedAt: null, hasTurns: true };

describe("work phase derivation", () => {
  it("lists an open issue without a story as not started", () => {
    expect(
      derivePhase({ story: null, issue: { state: "open" }, pullRequest: null, openAttention: [] }),
    ).toEqual({ phase: "not_started", reason: "issue_open" });
  });

  it("treats a live turn as work in progress and distinguishes queued from running", () => {
    expect(
      derivePhase({ story: startedStory, activeTurn: { state: "running" }, openAttention: [] }),
    ).toEqual({ phase: "in_progress", reason: "running" });
    expect(
      derivePhase({ story: startedStory, activeTurn: { state: "queued" }, openAttention: [] }),
    ).toEqual({ phase: "in_progress", reason: "queued" });
  });

  it("does not infer execution from an open story or a retained workspace", () => {
    expect(derivePhase({ story: startedStory, openAttention: [] })).toEqual({
      phase: "in_progress",
      reason: "started",
    });
    expect(
      derivePhase({
        story: { status: "ready", deletedAt: null, hasTurns: false },
        openAttention: [],
      }),
    ).toEqual({ phase: "not_started", reason: "ready" });
  });

  it("keeps a reviewable pull request in review regardless of the workspace", () => {
    expect(derivePhase({ story: startedStory, pullRequest: openPull, openAttention: [] })).toEqual({
      phase: "review",
      reason: "awaiting_review",
    });
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, reviewState: "approved" },
        openAttention: [],
      }),
    ).toEqual({ phase: "review", reason: "approved" });
  });

  it("does not treat a draft or a closed, unmerged pull request as review or delivery", () => {
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, draft: true },
        openAttention: [],
      }),
    ).toEqual({ phase: "in_progress", reason: "draft_pull_request" });
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, state: "closed" },
        openAttention: [],
      }),
    ).toEqual({ phase: "in_progress", reason: "pull_request_closed" });
  });

  it("surfaces blockers ahead of review and progress, but not after they are resolved", () => {
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: openPull,
        openAttention: [{ kind: "turn_error" }],
      }),
    ).toEqual({ phase: "attention", reason: "attention" });
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, ciState: "failure" },
        openAttention: [],
      }),
    ).toEqual({ phase: "attention", reason: "checks_failing" });
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, reviewState: "changes_requested" },
        openAttention: [],
      }),
    ).toEqual({ phase: "attention", reason: "changes_requested" });
    expect(
      derivePhase({ story: { ...startedStory, status: "attention" }, openAttention: [] }),
    ).toEqual({ phase: "attention", reason: "attention" });
    // A dismissed notice is not passed as open attention, so nothing is pending.
    expect(derivePhase({ story: startedStory, openAttention: [] }).phase).toBe("in_progress");
  });

  it("marks merged, completed, closed, archived, and deleted work as finished", () => {
    expect(
      derivePhase({
        story: startedStory,
        pullRequest: { ...openPull, state: "merged" },
        openAttention: [],
      }),
    ).toEqual({ phase: "done", reason: "merged" });
    expect(derivePhase({ story: { ...startedStory, status: "done" }, openAttention: [] })).toEqual({
      phase: "done",
      reason: "completed",
    });
    expect(
      derivePhase({
        story: null,
        issue: { state: "closed" },
        pullRequest: null,
        openAttention: [],
      }),
    ).toEqual({ phase: "done", reason: "issue_closed" });
    expect(
      derivePhase({ story: { ...startedStory, status: "archived" }, openAttention: [] }),
    ).toEqual({ phase: "archived", reason: "archived" });
    expect(
      derivePhase({ story: { ...startedStory, deletedAt: new Date() }, openAttention: [] }),
    ).toEqual({ phase: "archived", reason: "deleted" });
  });

  it("prefers the open pull request, then merged, then closed history", () => {
    const merged = { ...openPull, number: 2, state: "merged" as const };
    const closed = { ...openPull, number: 3, state: "closed" as const };
    const draft = { ...openPull, number: 4, draft: true };
    expect(pickPullRequest([closed, merged, draft, openPull])?.number).toBe(7);
    expect(pickPullRequest([closed, merged, draft])?.number).toBe(4);
    expect(pickPullRequest([closed, merged])?.number).toBe(2);
    expect(pickPullRequest([])).toBeNull();
  });
});

describe("review decision", () => {
  const at = (iso: string) => new Date(iso);
  it("counts only the latest review per reviewer and ignores the author", () => {
    expect(
      reviewDecision(
        [
          { author: "ana", state: "CHANGES_REQUESTED", submittedAt: at("2026-09-01T00:00:00Z") },
          { author: "ana", state: "APPROVED", submittedAt: at("2026-09-02T00:00:00Z") },
          { author: "author", state: "COMMENTED", submittedAt: at("2026-09-03T00:00:00Z") },
        ],
        "author",
      ),
    ).toBe("approved");
    expect(
      reviewDecision(
        [
          { author: "ana", state: "APPROVED", submittedAt: at("2026-09-01T00:00:00Z") },
          { author: "ben", state: "CHANGES_REQUESTED", submittedAt: at("2026-09-02T00:00:00Z") },
        ],
        null,
      ),
    ).toBe("changes_requested");
    expect(reviewDecision([{ author: "ana", state: "COMMENTED", submittedAt: null }], null)).toBe(
      "commented",
    );
    expect(reviewDecision([], null)).toBeNull();
  });
  it("does not let a later comment cancel an approval", () => {
    expect(
      reviewDecision(
        [
          { author: "ana", state: "APPROVED", submittedAt: at("2026-09-01T00:00:00Z") },
          { author: "ana", state: "COMMENTED", submittedAt: at("2026-09-02T00:00:00Z") },
        ],
        null,
      ),
    ).toBe("approved");
  });
});

describe("titles", () => {
  it("derives a provisional title from the first meaningful line without altering the request", () => {
    expect(provisionalTitle("# Fix the login redirect\n\nUsers land on /404 after SSO.")).toBe(
      "Fix the login redirect",
    );
    expect(provisionalTitle("\n\n- add **retry** to the `sync` job")).toBe(
      "add retry to the sync job",
    );
    expect(provisionalTitle("   ")).toBe("Untitled request");
    const long = provisionalTitle(`${"word ".repeat(40)}end`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("sanitizes generated titles and rejects empty output", () => {
    expect(sanitizeGeneratedTitle('Title: "Add retry to the sync job."\n')).toBe(
      "Add retry to the sync job",
    );
    expect(sanitizeGeneratedTitle("**Fix login redirect**")).toBe("Fix login redirect");
    expect(sanitizeGeneratedTitle("\n  \n")).toBeNull();
    expect(sanitizeGeneratedTitle("x".repeat(200))?.length).toBeLessThanOrEqual(120);
  });

  it("reads provider credentials from managed variables before the operator environment", () => {
    expect(
      titleCredentials(
        "proj_1",
        { OPENAI_API_KEY: "managed" },
        {
          FACILITY_PROJECT_PROJ_1_OPENAI_API_KEY: "operator",
          FACILITY_PROJECT_PROJ_1_ANTHROPIC_API_KEY: "operator-anthropic",
        },
      ),
    ).toEqual({ openai: "managed", anthropic: "operator-anthropic" });
    expect(titleCredentials("proj_1", {}, {})).toEqual({});
    expect(titleCredentials("proj_1", { ANTHROPIC_API_KEY: "  " }, {})).toEqual({});
  });
});

describe("default agent", () => {
  const agent = (name: string, enabled: boolean, ...types: string[]) => ({
    name,
    enabled,
    triggers: types.map((type) => ({ type })) as Array<{ type: "ui" | "mcp" | "manual" }>,
  });
  it("prefers builder, then the first enabled agent that accepts the surface", () => {
    expect(
      resolveDefaultAgent([agent("zeta", true, "ui"), agent("builder", true, "ui")], "ui")?.name,
    ).toBe("builder");
    expect(
      resolveDefaultAgent([agent("zeta", true, "ui"), agent("alpha", true, "ui")], "ui")?.name,
    ).toBe("alpha");
    expect(
      resolveDefaultAgent([agent("builder", false, "ui"), agent("alpha", true, "mcp")], "ui"),
    ).toBeNull();
  });
});

describe("backlog search and people", () => {
  const directory = {
    byLogin: new Map([
      [
        "ana",
        { key: "user:u1", login: "ana", name: "Ana", avatarUrl: null, sources: [] as never[] },
      ],
    ]),
    byUserId: new Map([
      [
        "u1",
        { key: "user:u1", login: "ana", name: "Ana", avatarUrl: null, sources: [] as never[] },
      ],
    ]),
  };
  it("merges a GitHub assignee and a Facility participant into one person", () => {
    expect(mergePersons(["Ana"], [{ kind: "user", subject: "u1" }], directory)).toEqual([
      {
        key: "user:u1",
        login: "ana",
        name: "Ana",
        avatarUrl: null,
        sources: ["github", "facility"],
      },
    ]);
    expect(mergePersons(["ben"], [{ kind: "user", subject: "u2" }], directory)).toEqual([
      { key: "github:ben", login: "ben", name: null, avatarUrl: null, sources: ["github"] },
      { key: "user:u2", login: null, name: null, avatarUrl: null, sources: ["facility"] },
    ]);
  });
  it("matches ticket numbers, ids, and words", () => {
    const item = {
      title: "Add retry to the sync job",
      story: { id: "story_1", externalId: "issue:42", branch: "feature/retry" },
      issue: { number: 42, repository: "acme/app" },
      pullRequest: null,
      labels: ["bug"],
      assignees: [{ login: "ana", name: "Ana" }],
    } as unknown as Parameters<typeof searchMatches>[0];
    expect(searchMatches(item, "#42")).toBe(true);
    expect(searchMatches(item, "42")).toBe(true);
    expect(searchMatches(item, "retry sync")).toBe(true);
    expect(searchMatches(item, "story_1")).toBe(true);
    expect(searchMatches(item, "bug ana")).toBe(true);
    expect(searchMatches(item, "unrelated")).toBe(false);
    expect(searchMatches(item, "")).toBe(true);
  });
});
