import type { z } from "zod";

/** A bounded read of one top-level fenced block; the original is never rewritten. */
export function readDecisionBlock<T>(
  markdown: string,
  language: string,
  schema: z.ZodType<T>,
  maxPayload = 16_000,
):
  | { status: "available"; value: T }
  | { status: "absent" }
  | {
      status: "invalid";
      reason: "too_large" | "duplicate" | "malformed" | "unsupported_version" | "invalid_fields";
    } {
  if (markdown.length > 100_000) return { status: "invalid", reason: "too_large" };
  let fence: { char: string; length: number; brief: boolean } | undefined;
  let count = 0;
  let body: string[] = [];
  let complete = false;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1]?.[0] === fence.char && closing[1].length >= fence.length) {
        if (fence.brief) complete = true;
        fence = undefined;
      } else if (fence.brief) body.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if (!opening?.[1]) continue;
    const brief = opening[2]?.trim() === language;
    fence = { char: opening[1][0] ?? "`", length: opening[1].length, brief };
    if (brief) {
      count++;
      if (count > 1) return { status: "invalid", reason: "duplicate" };
      body = [];
    }
  }
  if (!count) return { status: "absent" };
  if (!complete) return { status: "invalid", reason: "malformed" };
  const json = body.join("\n");
  if (json.length > maxPayload) return { status: "invalid", reason: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
  if (value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion !== 1)
    return { status: "invalid", reason: "unsupported_version" };
  const result = schema.safeParse(value);
  return result.success
    ? { status: "available", value: result.data }
    : { status: "invalid", reason: "invalid_fields" };
}
