// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BoardStage, StoriesBoard } from "@/components/story/stories-board";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const stages: BoardStage[] = [
  { key: "backlog", label: "Backlog", sub: "", kind: "human" as const, stories: [] },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("StoriesBoard number jump — out-of-order responses", () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a stale response when a newer submission resolves first", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StoriesBoard
        projectId="proj_1"
        stages={stages}
        canTrigger={false}
        builderPlanRequired={false}
      />,
    );

    const input = screen.getByPlaceholderText(/Filter by title/i);
    const form = input.closest("form");
    if (!form) throw new Error("form not found");

    // Submit "5" — request #1 goes out, left pending.
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.submit(form);

    // Before it resolves, submit "12" — request #2 goes out.
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.submit(form);

    // Resolve the NEWER request first, then the STALE one — the classic race.
    await act(async () => {
      second.resolve(
        jsonResponse(200, {
          number: 12,
          repoId: "repo_a",
          repoOwner: "theam",
          repoName: "facility",
          storyType: "issue",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve(
        jsonResponse(200, {
          number: 5,
          repoId: "repo_a",
          repoOwner: "theam",
          repoName: "facility",
          storyType: "issue",
        }),
      );
      await Promise.resolve();
    });

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.stringContaining("/stories/12"));
  });
});
