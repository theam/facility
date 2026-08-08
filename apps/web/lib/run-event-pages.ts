import type { RunEvent } from "@/lib/api";

export const RUN_EVENT_PAGE_LIMIT = 500;

type EventPageResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type EventPageFetcher = (
  input: string,
  init: { cache: "no-store" },
) => Promise<EventPageResponse>;

/**
 * Drain every durable event after a cursor. The API deliberately bounds each
 * response, while a completed run can contain many pages of engine output.
 */
export async function fetchRunEventPages(
  runId: string,
  afterSeq: number,
  fetcher: EventPageFetcher = fetch,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let cursor = afterSeq;

  while (true) {
    const response = await fetcher(
      `/api/v1/runs/${runId}/events?afterSeq=${cursor}&limit=${RUN_EVENT_PAGE_LIMIT}`,
      { cache: "no-store" },
    );
    if (!response.ok) return events;

    const page = (await response.json()) as RunEvent[];
    if (!Array.isArray(page) || page.length === 0) return events;

    const nextCursor = page.at(-1)?.seq;
    if (typeof nextCursor !== "number" || nextCursor <= cursor) return events;

    events.push(...page);
    cursor = nextCursor;
    if (page.length < RUN_EVENT_PAGE_LIMIT) return events;
  }
}
