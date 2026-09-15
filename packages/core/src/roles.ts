import { ALL_PERMISSIONS } from "./permissions.js";

export type BundledRoleName = "owner" | "maintainer" | "viewer";

export type BundledRole = {
  name: BundledRoleName;
  description: string;
  permissions: string[];
};

const allReads = ALL_PERMISSIONS.filter((permission) => permission.endsWith(":read"));

export const BUNDLED_ROLES = [
  {
    name: "owner",
    description: "Full organization control.",
    permissions: ["*"],
  },
  {
    name: "maintainer",
    description: "Full access to repositories, workspaces, and Facility configuration.",
    permissions: ["*"],
  },
  {
    name: "viewer",
    description: "Read-only access.",
    permissions: allReads,
  },
] satisfies BundledRole[];
