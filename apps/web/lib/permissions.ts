/**
 * Client-side mirror of @facility/core `can` — used only to disable matrix
 * checkboxes the caller couldn't grant; the API re-checks on save
 * (assertPermissionsGrantable), so this is UX, never enforcement.
 */
export function can(grants: readonly string[], needed: string): boolean {
  if (grants.includes("*")) return true;
  if (grants.includes(needed)) return true;
  const [resource] = needed.split(":");
  return Boolean(resource && grants.includes(`${resource}:*`));
}
