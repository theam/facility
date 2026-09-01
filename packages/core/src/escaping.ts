// Escape user-controlled init inputs before they land in generated YAML, JSON, or regex.

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** YAML list item scalar — JSON.stringify yields a safe double-quoted string. */
export function yamlQuotedScalar(value: string): string {
  return JSON.stringify(value);
}
