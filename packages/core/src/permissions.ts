import { z } from "zod";

export const PERMISSION_RESOURCES = [
  "org",
  "members",
  "roles",
  "projects",
  "repos",
  "agents",
  "stories",
  "workspaces",
  "previews",
  "keys",
  "settings",
] as const;

const basePermissions = PERMISSION_RESOURCES.flatMap(
  (resource) => [`${resource}:read`, `${resource}:write`] as const,
);

export const SPECIAL_PERMISSIONS = [
  "workspaces:execute",
  "keys:issue",
  "projects:kickstart",
] as const;

export const ALL_PERMISSIONS = [...new Set([...basePermissions, ...SPECIAL_PERMISSIONS])].sort();

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const PermissionSchema = z
  .string()
  .refine(
    (value) =>
      (ALL_PERMISSIONS as readonly string[]).includes(value) ||
      value === "*" ||
      /^[a-z]+:\*$/.test(value),
    "unknown permission",
  );

export function can(grants: readonly string[], needed: string): boolean {
  if (grants.includes("*")) {
    return true;
  }
  if (grants.includes(needed)) {
    return true;
  }
  const [resource] = needed.split(":");
  return Boolean(resource && grants.includes(`${resource}:*`));
}
