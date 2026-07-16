import { ALL_PERMISSIONS, PERMISSION_RESOURCES } from "./permissions.js";

export type BundledRoleName =
  | "owner"
  | "admin"
  | "maintainer"
  | "engineer"
  | "viewer"
  | "operator"
  | "agent"
  | "finance";

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
    name: "admin",
    description: "Administration across all platform resources.",
    permissions: PERMISSION_RESOURCES.map((resource) => `${resource}:*`),
  },
  {
    name: "maintainer",
    description: "Project maintainer with write access to execution resources.",
    permissions: [
      ...allReads,
      "projects:*",
      "repos:*",
      "registry:*",
      "registry:publish",
      "agents:*",
      "sandboxes:*",
      "runs:*",
      "runs:trigger",
      "runs:steer",
      "sessions:read",
      "keys:issue",
      "budgets:*",
      "hitl:*",
      "hitl:decide",
      "kb:*",
      "tasks:*",
      "issues:*",
      "projects:kickstart",
    ],
  },
  {
    name: "engineer",
    description: "Daily engineering access for runs, HITL, KB, and tasks.",
    permissions: [
      ...allReads,
      "runs:trigger",
      "runs:steer",
      "hitl:decide",
      "kb:write",
      "tasks:write",
    ],
  },
  {
    name: "viewer",
    description: "Read-only access.",
    permissions: allReads,
  },
  {
    name: "operator",
    description:
      "MCP operator that can propose governed changes but cannot approve its own proposals.",
    permissions: [
      ...allReads,
      "projects:write",
      "projects:kickstart",
      "repos:write",
      "registry:write",
      "registry:publish",
      "agents:write",
      "runs:write",
      "runs:trigger",
      "runs:steer",
      "budgets:write",
      "kb:write",
      "tasks:write",
      "issues:write",
    ],
  },
  {
    name: "agent",
    description: "Machine role with no base grants; attach explicit per-agent permissions.",
    permissions: [],
  },
  {
    name: "finance",
    description: "Finance and audit visibility.",
    permissions: ["analytics:read", "spend:read", "budgets:read", "audit:read"],
  },
] satisfies BundledRole[];
