import { describe, expect, it } from "vitest";
import {
  attentionHref,
  isFiltered,
  parseAttentionSearch,
  toAttentionQuery,
  toggleKind,
} from "../lib/attention-presentation";

describe("attention search", () => {
  it("defaults to the first page of open notices and ignores values it does not understand", () => {
    const search = parseAttentionSearch({ status: "pending", page: "-3" });
    expect(search).toEqual({ status: "open", kind: [], q: "", page: 1 });
    expect(isFiltered(search)).toBe(false);
    expect(toAttentionQuery(search)).toEqual({ status: "open", limit: 25, offset: 0 });
  });

  it("reads repeated and comma-separated kinds once each, and bounds the search text", () => {
    const search = parseAttentionSearch({
      status: "resolved",
      kind: ["turn_error,agent_waiting", "turn_error", " "],
      q: `  ${"x".repeat(300)}  `,
      page: "3",
    });
    expect(search.status).toBe("resolved");
    expect(search.kind).toEqual(["turn_error", "agent_waiting"]);
    expect(search.q).toHaveLength(200);
    expect(isFiltered(search)).toBe(true);
    expect(toAttentionQuery(search)).toMatchObject({
      status: "resolved",
      kind: ["turn_error", "agent_waiting"],
      offset: 50,
    });
  });

  it("round-trips every filter through the URL and drops defaults", () => {
    const search = parseAttentionSearch({ kind: "turn_error", q: "timed out", page: "2" });
    const href = attentionHref("proj one", search);
    expect(href).toBe("/projects/proj%20one/attention?kind=turn_error&q=timed+out&page=2");
    const params = Object.fromEntries(new URL(href, "http://localhost").searchParams);
    expect(parseAttentionSearch(params)).toEqual(search);
    expect(attentionHref("p1", search, { kind: [], q: "", page: 1 })).toBe(
      "/projects/p1/attention",
    );
    expect(attentionHref("p1", search, { status: "resolved", page: 1 })).toBe(
      "/projects/p1/attention?status=resolved&kind=turn_error&q=timed+out",
    );
  });

  it("toggles a kind in and out of the selection", () => {
    const search = parseAttentionSearch({ kind: "turn_error" });
    expect(toggleKind(search, "agent_waiting")).toEqual(["turn_error", "agent_waiting"]);
    expect(toggleKind(search, "turn_error")).toEqual([]);
  });
});
