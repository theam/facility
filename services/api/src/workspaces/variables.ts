import { randomUUID } from "node:crypto";
import { open, seal } from "@facility/core";
import { type FacilityDb, workspaces } from "@facility/db";
import { parse as parseDotenv } from "dotenv";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../errors.js";

const reserved = /^(?:FACILITY_|GIT_|GITHUB_|CODEX_|CLAUDE_CODE_|LD_|DYLD_)/;
const reservedNames = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_AUTH_TOKEN",
  "BASH_ENV",
  "ENV",
]);
export const WorkspaceVariableName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine(
    (name) => !reserved.test(name) && !reservedNames.has(name),
    "This name is reserved for the workspace runtime",
  );
export const WorkspaceVariablesPatch = z
  .object({
    revision: z.string().max(64),
    variables: z.record(
      WorkspaceVariableName,
      z
        .string()
        .max(32768)
        .refine((v) => !v.includes("\0"), "NUL is not supported")
        .nullable(),
    ),
  })
  .strict()
  .refine(
    (body) => Object.keys(body.variables).length > 0 && Object.keys(body.variables).length <= 200,
    "Provide between 1 and 200 variable changes",
  );
export const WorkspaceVariablesInput = z.union([
  WorkspaceVariablesPatch,
  z.object({ revision: z.string().max(64), dotenv: z.string().min(1).max(131072) }).strict(),
]);
export const WorkspaceVariablesMetadata = z.object({
  revision: z.string(),
  updated_at: z.string().nullable(),
  variables: z.array(z.object({ name: z.string(), configured: z.literal(true) })),
  applies_to: z.literal("new_processes"),
});
export function parseWorkspaceVariables(input: z.infer<typeof WorkspaceVariablesInput>) {
  const result = WorkspaceVariablesPatch.safeParse(
    "dotenv" in input ? { revision: input.revision, variables: parseDotenv(input.dotenv) } : input,
  );
  if (!result.success)
    throw new ApiError(
      400,
      "invalid_workspace_variables",
      "Provide valid variable names and values; runtime names are reserved",
    );
  return result.data;
}
type Scope = { orgId: string; projectId: string; workspaceId: string };
type Stored = { revision: string; sealed: string; updatedAt: string };
const Payload = z
  .object({
    orgId: z.string(),
    projectId: z.string(),
    workspaceId: z.string(),
    values: z.record(WorkspaceVariableName, z.string()),
  })
  .strict();

/** Values are write-only at the API boundary and bound to their tenant and workspace. */
export class WorkspaceVariablesService {
  constructor(
    private readonly db: FacilityDb,
    private readonly masterKey: string,
  ) {}

  async values(scope: Scope): Promise<Record<string, string>> {
    const row = (await this.db.select().from(workspaces).where(scopeWhere(scope)).limit(1))[0];
    if (!row || row.state === "destroyed" || row.state === "deleting")
      throw new ApiError(404, "not_found", "Workspace not found");
    return this.decode(scope, stored(row.environment));
  }

  async metadata(scope: Scope) {
    const row = (await this.db.select().from(workspaces).where(scopeWhere(scope)).limit(1))[0];
    if (!row || row.state === "destroyed" || row.state === "deleting")
      throw new ApiError(404, "not_found", "Workspace not found");
    const record = stored(row.environment);
    const values = await this.decode(scope, record);
    return metadata(record, values);
  }

  async update(scope: Scope, input: z.infer<typeof WorkspaceVariablesPatch>) {
    const patch = WorkspaceVariablesPatch.parse(input);
    return this.db.transaction(async (tx) => {
      const row = (await tx.select().from(workspaces).where(scopeWhere(scope)).for("update"))[0];
      if (!row || row.state === "destroyed" || row.state === "deleting")
        throw new ApiError(404, "not_found", "Workspace not found");
      const previous = stored(row.environment);
      if ((previous?.revision ?? "") !== patch.revision)
        throw new ApiError(
          409,
          "environment_revision_conflict",
          "Variables changed. Reload before saving your changes.",
        );
      const values = await this.decode(scope, previous);
      for (const [name, value] of Object.entries(patch.variables)) {
        if (value === null) delete values[name];
        else values[name] = value;
      }
      if (Object.keys(values).length > 200 || Buffer.byteLength(JSON.stringify(values)) > 131072)
        throw new ApiError(
          400,
          "environment_too_large",
          "Workspace variables exceed the size limit",
        );
      const record = {
        revision: randomUUID(),
        updatedAt: new Date().toISOString(),
        sealed: await seal(JSON.stringify({ ...scope, values }), this.masterKey),
      };
      await tx
        .update(workspaces)
        .set({
          environment: {
            ...(row.environment as Record<string, unknown>),
            managedVariables: record,
          },
          updatedAt: new Date(),
        })
        .where(scopeWhere(scope));
      return metadata(record, values);
    });
  }

  private async decode(scope: Scope, record: Stored | undefined): Promise<Record<string, string>> {
    if (!record) return {};
    try {
      const decoded = Payload.parse(JSON.parse(await open(record.sealed, this.masterKey)));
      if (
        decoded.orgId !== scope.orgId ||
        decoded.projectId !== scope.projectId ||
        decoded.workspaceId !== scope.workspaceId
      )
        throw new Error("scope mismatch");
      return decoded.values;
    } catch {
      throw new ApiError(
        409,
        "environment_unavailable",
        "Stored workspace variables could not be read",
      );
    }
  }
}

function scopeWhere(scope: Scope) {
  return and(
    eq(workspaces.orgId, scope.orgId),
    eq(workspaces.projectId, scope.projectId),
    eq(workspaces.id, scope.workspaceId),
  );
}
function stored(environment: unknown): Stored | undefined {
  return (environment as { managedVariables?: Stored }).managedVariables;
}
function metadata(record: Stored | undefined, values: Record<string, string>) {
  return {
    revision: record?.revision ?? "",
    updated_at: record?.updatedAt ?? null,
    variables: Object.keys(values)
      .sort()
      .map((name) => ({ name, configured: true })),
    applies_to: "new_processes" as const,
  };
}
