/** Stored JSON is untrusted until it identifies one actor and the current scope revision. */
export function previewExecutionAuthorizer(
  revision: number,
  value: unknown,
): { type: "user" | "key"; id: string } | null {
  if (!value || typeof value !== "object") return null;
  const grant = value as { revision?: unknown; actor?: unknown };
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    grant.revision !== revision ||
    !grant.actor ||
    typeof grant.actor !== "object"
  )
    return null;
  const actor = grant.actor as { type?: unknown; id?: unknown };
  if (
    (actor.type !== "user" && actor.type !== "key") ||
    typeof actor.id !== "string" ||
    !actor.id.trim() ||
    actor.id.length > 240
  )
    return null;
  return { type: actor.type, id: actor.id };
}
