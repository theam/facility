import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/lib/api";
import {
  type EventPageFetcher,
  fetchRunEventPages,
  RUN_EVENT_PAGE_LIMIT,
} from "@/lib/run-event-pages";

function event(seq: number): RunEvent {
  return {
    orgId: "org_test",
    runId: "run_test",
    seq,
    ts: "2026-08-08T00:00:00.000Z",
    type: "engine",
    data: { seq },
  };
}

describe("run event pagination", () => {
  it("loads every page instead of stopping before a completed run's terminal events", async () => {
    const firstPage = Array.from({ length: RUN_EVENT_PAGE_LIMIT }, (_, index) => event(index + 1));
    const secondPage = [event(RUN_EVENT_PAGE_LIMIT + 1)];
    const pages = [firstPage, secondPage];
    const requests: string[] = [];
    const fetcher: EventPageFetcher = async (input) => {
      requests.push(input);
      return { ok: true, json: async () => pages.shift() ?? [] };
    };

    const events = await fetchRunEventPages("run_test", 0, fetcher);

    expect(events).toHaveLength(RUN_EVENT_PAGE_LIMIT + 1);
    expect(events.at(-1)?.seq).toBe(RUN_EVENT_PAGE_LIMIT + 1);
    expect(requests).toEqual([
      `/api/v1/runs/run_test/events?afterSeq=0&limit=${RUN_EVENT_PAGE_LIMIT}`,
      `/api/v1/runs/run_test/events?afterSeq=${RUN_EVENT_PAGE_LIMIT}&limit=${RUN_EVENT_PAGE_LIMIT}`,
    ]);
  });

  it("stops safely if a malformed page does not advance the cursor", async () => {
    const fetcher: EventPageFetcher = async () => ({
      ok: true,
      json: async () => [event(7)],
    });

    await expect(fetchRunEventPages("run_test", 7, fetcher)).resolves.toEqual([]);
  });
});
