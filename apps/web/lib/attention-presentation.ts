import type { AttentionQuery } from "./api";

// URL state for the attention page. Every filter round-trips through search
// params so a view can be shared, reloaded and read back by the server.

export type AttentionSearch = {
  status: "open" | "resolved";
  kind: string[];
  q: string;
  page: number;
};

export const ATTENTION_PAGE_SIZE = 25;

export function parseAttentionSearch(
  params: Record<string, string | string[] | undefined>,
): AttentionSearch {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const kinds = (Array.isArray(params.kind) ? params.kind : params.kind ? [params.kind] : [])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 80);
  const page = Number(first(params.page));
  return {
    status: first(params.status) === "resolved" ? "resolved" : "open",
    kind: [...new Set(kinds)].slice(0, 20),
    q: first(params.q)?.trim().slice(0, 200) ?? "",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function toAttentionQuery(search: AttentionSearch): AttentionQuery {
  return {
    status: search.status,
    ...(search.kind.length > 0 ? { kind: search.kind } : {}),
    ...(search.q ? { q: search.q } : {}),
    limit: ATTENTION_PAGE_SIZE,
    offset: (search.page - 1) * ATTENTION_PAGE_SIZE,
  };
}

export function attentionHref(
  projectId: string,
  search: AttentionSearch,
  changes: Partial<AttentionSearch> = {},
) {
  const next = { ...search, ...changes };
  const params = new URLSearchParams();
  if (next.status !== "open") params.set("status", next.status);
  for (const kind of next.kind) params.append("kind", kind);
  if (next.q) params.set("q", next.q);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return `/projects/${encodeURIComponent(projectId)}/attention${query ? `?${query}` : ""}`;
}

/** Choosing a kind adds it to the selection; choosing it again removes it. */
export function toggleKind(search: AttentionSearch, kind: string) {
  return search.kind.includes(kind)
    ? search.kind.filter((selected) => selected !== kind)
    : [...search.kind, kind];
}

export function isFiltered(search: AttentionSearch) {
  return search.q.length > 0 || search.kind.length > 0;
}
