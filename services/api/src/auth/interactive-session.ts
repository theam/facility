/** Use only after the auth hook has authenticated the request and verified membership. */
export function interactiveSessionCookie(request: {
  principal?: { type: "user" | "key" };
  headers: { authorization?: string };
  cookies: Record<string, string | undefined>;
}): string | undefined {
  if (request.principal?.type !== "user" || request.headers.authorization !== undefined)
    return undefined;
  return request.cookies.facility_session || undefined;
}
