import { can } from "@facility/core";
import { ApiError } from "../errors.js";
export function requirePermissions(
  actor: { permissions: readonly string[] },
  required: readonly string[],
) {
  if (!required.every((permission) => can(actor.permissions, permission)))
    throw new ApiError(403, "forbidden", `Requires ${required.join(" and ")}`);
}
