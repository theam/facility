import { newId, verifyKey } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  kbEntries,
  kbEntryVersions,
  kbLinks,
  kbSpaceDocVersions,
  kbSpaces,
  poTasks,
  projects,
  proposalEvents,
  proposals,
  repos,
  runEvents,
  runs,
} from "@facility/db";
import { artifactIdFor, validate } from "@facility/harness";
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withBuilderPlanPreflight } from "../../builder-plan-policy.js";
import { ApiError, notFound } from "../../errors.js";
import {
  ensureActive,
  ensureLinks,
  loadKbGraph,
  normalizeKbDraft,
  toHarnessEntry,
  toHarnessSpace,
  validateProjectKb,
} from "../../harness.js";
import { readSandbox } from "../../sandbox/state.js";
import type { Principal } from "../../types.js";
import {
  AnyObject,
  assertBareRowProjectScope,
  assertProjectScope,
  bearer,
  definedFields,
  IdParams,
  KbDecisionSchema,
  KbEntryDraftSchema,
  KbEntrySchema,
  KbEntryVersionSchema,
  KbNeighborSchema,
  KbSpaceDocVersionSchema,
  KbSpaceSchema,
  Ok,
  objectOrEmpty,
  PageQuery,
  type PageQueryValue,
  ProposalSchema,
  principal,
  proposalOpener,
  TaskSchema,
  type V1RouteContext,
  ValidationReportSchema,
} from "./shared.js";

/**
 * Autosave-friendly history: repeated saves by the same actor within this
 * window coalesce into the version captured when the editing session started,
 * instead of one version per debounce tick.
 */
const VERSION_COALESCE_MS = 10 * 60_000;

function coalescesWith(
  latest: { createdAt: Date; savedBy: unknown } | undefined,
  p: Principal,
): boolean {
  if (!latest) return false;
  if (Date.now() - latest.createdAt.getTime() > VERSION_COALESCE_MS) return false;
  const by = latest.savedBy as { type?: string; id?: string } | null;
  return by?.type === p.type && by?.id === p.id;
}

/** Artifact ids a body cites — bare codes (they match inside [[wikilinks]] too). */
const BODY_REF_RE = /\b([A-Z]{1,2}\d{3})\b/g;

function citedArtifactIds(md: string): Set<string> {
  const refs = new Set<string>();
  for (const match of md.matchAll(BODY_REF_RE)) {
    const id = match[1];
    if (id) refs.add(id);
  }
  return refs;
}

export async function registerKbTasksRoutes(app: FastifyInstance, context: V1RouteContext) {
  const { db } = context;
  app.get(
    "/v1/projects/:projectId/kb/space",
    {
      config: { permission: "kb:read" },
      schema: { params: IdParams, response: { 200: KbSpaceSchema.nullable() } },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const space = (
        await db
          .select()
          .from(kbSpaces)
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.projectId, projectId)))
          .limit(1)
      )[0];
      // Absence is represented explicitly. The OpenAPI/SDK contract is
      // nullable, so callers can distinguish "not created" from an empty but
      // persisted KB space without receiving an object that violates the
      // declared response schema.
      return space ?? null;
    },
  );

  app.put(
    "/v1/projects/:projectId/kb/space",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        // Partial by design: omitted fields keep their stored value, so saving
        // the charter can never clobber the active doc or the chain config.
        body: z.object({
          charterMd: z.string().optional(),
          activeMd: z.string().optional(),
          config: AnyObject.optional(),
        }),
        response: { 200: KbSpaceSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        charterMd?: string;
        activeMd?: string;
        config?: Record<string, unknown>;
      };
      const current = await spaceFor(p.orgId, projectId);
      if (!current) {
        const row = (
          await db
            .insert(kbSpaces)
            .values({
              id: newId("kb"),
              orgId: p.orgId,
              projectId,
              charterMd: body.charterMd ?? "",
              activeMd: body.activeMd ?? "",
              config: body.config ?? {},
              charterUpdatedAt: body.charterMd !== undefined ? new Date() : null,
              activeUpdatedAt: body.activeMd !== undefined ? new Date() : null,
            })
            .returning()
        )[0];
        if (!row) throw new ApiError(500, "insert_failed", "Could not create KB space");
        return row;
      }
      const row = await db.transaction(async (tx) => {
        const patch: Partial<typeof kbSpaces.$inferInsert> = { updatedAt: new Date() };
        if (body.config !== undefined) patch.config = body.config;
        const docs = [
          { doc: "charter" as const, next: body.charterMd, prior: current.charterMd },
          { doc: "active" as const, next: body.activeMd, prior: current.activeMd },
        ];
        for (const { doc, next, prior } of docs) {
          if (next === undefined || next === prior) continue;
          if (doc === "charter") {
            patch.charterMd = next;
            patch.charterUpdatedAt = new Date();
          } else {
            patch.activeMd = next;
            patch.activeUpdatedAt = new Date();
          }
          const latest = (
            await tx
              .select()
              .from(kbSpaceDocVersions)
              .where(
                and(eq(kbSpaceDocVersions.spaceId, current.id), eq(kbSpaceDocVersions.doc, doc)),
              )
              .orderBy(desc(kbSpaceDocVersions.version))
              .limit(1)
          )[0];
          if (coalescesWith(latest, p)) continue;
          await tx.insert(kbSpaceDocVersions).values({
            id: newId("ver"),
            orgId: p.orgId,
            spaceId: current.id,
            doc,
            version: (latest?.version ?? 0) + 1,
            bodyMd: prior,
            savedBy: { type: p.type, id: p.id },
          });
        }
        return (
          await tx
            .update(kbSpaces)
            .set(patch)
            .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, current.id)))
            .returning()
        )[0];
      });
      if (!row) throw new ApiError(500, "insert_failed", "Could not update KB space");
      return row;
    },
  );

  app.get(
    "/v1/projects/:projectId/kb/space/versions",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        querystring: z.object({ doc: z.enum(["charter", "active"]) }),
        response: { 200: z.array(KbSpaceDocVersionSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const space = await spaceFor(p.orgId, projectId);
      if (!space) return [];
      const { doc } = request.query as { doc: "charter" | "active" };
      return db
        .select()
        .from(kbSpaceDocVersions)
        .where(
          and(
            eq(kbSpaceDocVersions.orgId, p.orgId),
            eq(kbSpaceDocVersions.spaceId, space.id),
            eq(kbSpaceDocVersions.doc, doc),
          ),
        )
        .orderBy(desc(kbSpaceDocVersions.version));
    },
  );

  app.get(
    "/v1/projects/:projectId/kb/entries",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        querystring: PageQuery.extend({ type: z.string().optional() }),
        response: { 200: z.array(KbEntrySchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const projectId = (request.params as { projectId: string }).projectId;
      assertProjectScope(p, projectId);
      const space = await spaceFor(p.orgId, projectId);
      if (!space) return [];
      const query = request.query as PageQueryValue & { type?: string };
      const type = query.type;
      return db
        .select()
        .from(kbEntries)
        .where(
          type
            ? and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, type),
              )
            : and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, space.id)),
        )
        .orderBy(asc(kbEntries.type), asc(kbEntries.number), asc(kbEntries.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );

  app.get(
    "/v1/kb/entries/:entryId",
    {
      config: { permission: "kb:read" },
      schema: { params: IdParams, response: { 200: KbEntrySchema } },
    },
    async (request) => {
      const p = principal(request);
      const entry = await loadKbEntryForPrincipal(
        p,
        (request.params as { entryId: string }).entryId,
      );
      return entry;
    },
  );

  // The Product Owner's decision record: every decision with its supersedence
  // resolved. `active=1` narrows to decisions that still govern — not
  // superseded by a newer one and not marked superseded themselves.
  app.get(
    "/v1/projects/:projectId/kb/decisions",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        querystring: z.object({ active: z.coerce.number().optional() }),
        response: { 200: z.array(KbDecisionSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const space = await spaceFor(p.orgId, projectId);
      if (!space) return [];
      const decisions = await db
        .select()
        .from(kbEntries)
        .where(
          and(
            eq(kbEntries.orgId, p.orgId),
            eq(kbEntries.spaceId, space.id),
            eq(kbEntries.type, "D"),
          ),
        )
        .orderBy(desc(kbEntries.number));
      const supersededBy = new Map<string, string>();
      for (const entry of decisions) {
        const target = entry.supersedes;
        if (target) supersededBy.set(target, artifactIdFor(toHarnessEntry(entry)));
      }
      const rows = decisions.map((entry) => {
        const artifactId = artifactIdFor(toHarnessEntry(entry));
        const successor = supersededBy.get(artifactId) ?? null;
        return {
          ...entry,
          artifactId,
          supersededBy: successor,
          active: successor === null && entry.status !== "superseded",
        };
      });
      const activeOnly = (request.query as { active?: number }).active === 1;
      return activeOnly ? rows.filter((row) => row.active) : rows;
    },
  );

  // Plain-text KB search for the PO's tools: substring over slug and body,
  // optionally narrowed by type. Recall over precision; no embeddings.
  app.get(
    "/v1/projects/:projectId/kb/search",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        querystring: z.object({
          q: z.string().min(1),
          type: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: z.array(KbEntrySchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const space = await spaceFor(p.orgId, projectId);
      if (!space) return [];
      const query = request.query as { q: string; type?: string; limit: number };
      const needle = `%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const match = or(ilike(kbEntries.slug, needle), ilike(kbEntries.bodyMd, needle));
      return db
        .select()
        .from(kbEntries)
        .where(
          query.type
            ? and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, query.type),
                match,
              )
            : and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, space.id), match),
        )
        .orderBy(desc(kbEntries.updatedAt))
        .limit(query.limit);
    },
  );

  // An entry plus its link neighborhood — what it derives from, what derives
  // from it, and what supersedes what. The PO reads little but connected.
  app.get(
    "/v1/kb/entries/:entryId/neighborhood",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        response: {
          200: z.object({
            entry: KbEntrySchema,
            artifactId: z.string(),
            linked: z.array(KbNeighborSchema),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const entry = await loadKbEntryForPrincipal(
        p,
        (request.params as { entryId: string }).entryId,
      );
      const links = await db
        .select()
        .from(kbLinks)
        .where(and(eq(kbLinks.orgId, p.orgId), eq(kbLinks.spaceId, entry.spaceId)));
      const neighborIds = new Set<string>();
      for (const link of links) {
        if (link.fromEntry === entry.id) neighborIds.add(link.toEntry);
        if (link.toEntry === entry.id) neighborIds.add(link.fromEntry);
      }
      const neighbors = neighborIds.size
        ? await db
            .select()
            .from(kbEntries)
            .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, entry.spaceId)))
        : [];
      const entryArtifactId = artifactIdFor(toHarnessEntry(entry));
      const linked = neighbors
        .filter((neighbor) => neighborIds.has(neighbor.id))
        .map((neighbor) => {
          const neighborArtifactId = artifactIdFor(toHarnessEntry(neighbor));
          return {
            id: neighbor.id,
            artifactId: neighborArtifactId,
            type: neighbor.type,
            number: neighbor.number,
            slug: neighbor.slug,
            status: neighbor.status,
            relation:
              entry.supersedes === neighborArtifactId
                ? ("supersedes" as const)
                : neighbor.supersedes === entryArtifactId
                  ? ("superseded-by" as const)
                  : ("linked" as const),
          };
        });
      return { entry, artifactId: entryArtifactId, linked };
    },
  );

  // Decisions are immutable once made: the only way to change one is to make a
  // new one that supersedes it. This creates the successor and retires the
  // predecessor in one transaction, keeping the chain navigable.
  app.post(
    "/v1/kb/entries/:entryId/supersede",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          slug: z.string().optional(),
          frontmatter: AnyObject.default({}),
          bodyMd: z.string(),
          status: z.string().optional(),
        }),
        response: { 200: KbEntrySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { entryId } = request.params as { entryId: string };
      const body = request.body as {
        slug?: string;
        frontmatter: Record<string, unknown>;
        bodyMd: string;
        status?: string;
      };
      const predecessor = await loadKbEntryForPrincipal(p, entryId);
      if (predecessor.status === "superseded") {
        throw new ApiError(
          409,
          "kb_entry_already_superseded",
          "This entry was already superseded — supersede its successor instead",
        );
      }
      const space = (
        await db
          .select()
          .from(kbSpaces)
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, predecessor.spaceId)))
          .limit(1)
      )[0];
      if (!space) throw notFound("KB space not found");
      const graph = await loadKbGraph(db, p.orgId, space.projectId);
      if (!graph) throw notFound("KB space not found");
      const predecessorArtifactId = artifactIdFor(toHarnessEntry(predecessor));
      const max =
        (
          await db
            .select()
            .from(kbEntries)
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, predecessor.type),
              ),
            )
            .orderBy(desc(kbEntries.number))
            .limit(1)
        )[0]?.number ?? 0;
      const parentEntries = graph.entries.filter((candidate) => candidate.id === predecessor.id);
      const normalized = normalizeKbDraft({
        type: predecessor.type,
        number: max + 1,
        slug: body.slug ?? predecessor.slug,
        frontmatter: { ...body.frontmatter, supersedes: predecessorArtifactId },
        bodyMd: body.bodyMd,
        parentEntries,
      });
      const status = body.status ?? (predecessor.type === "D" ? "decided" : predecessor.status);
      const draft = {
        id: "__draft__",
        type: predecessor.type,
        number: max + 1,
        slug: body.slug ?? predecessor.slug,
        frontmatter: normalized.frontmatter,
        bodyMd: normalized.bodyMd,
        status,
        supersedes: predecessorArtifactId,
      };
      const report = validate({
        space: toHarnessSpace(space),
        entries: [...graph.entries, draft],
        links: [
          ...graph.links,
          { fromEntry: "__draft__", toEntry: predecessor.id },
          { fromEntry: predecessor.id, toEntry: "__draft__" },
        ],
        entryId: "__draft__",
        validateSpecials: false,
      });
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "KB entry failed validation", report);
      }
      return db.transaction(async (tx) => {
        const inserted = (
          await tx
            .insert(kbEntries)
            .values({
              id: newId("kb"),
              orgId: p.orgId,
              spaceId: space.id,
              type: predecessor.type,
              number: max + 1,
              slug: body.slug ?? predecessor.slug,
              frontmatter: normalized.frontmatter,
              bodyMd: normalized.bodyMd,
              status,
              supersedes: predecessorArtifactId,
            })
            .returning()
        )[0];
        if (!inserted) throw new ApiError(500, "insert_failed", "Could not supersede KB entry");
        await tx
          .insert(kbLinks)
          .values([
            { orgId: p.orgId, spaceId: space.id, fromEntry: inserted.id, toEntry: predecessor.id },
            { orgId: p.orgId, spaceId: space.id, fromEntry: predecessor.id, toEntry: inserted.id },
          ])
          .onConflictDoNothing();
        await tx
          .update(kbEntries)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, predecessor.id)));
        return inserted;
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/kb/entries",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        querystring: z.object({ dry: z.coerce.number().optional() }),
        body: z.object({
          type: z.string(),
          slug: z.string(),
          frontmatter: AnyObject.default({}),
          bodyMd: z.string(),
          status: z.string().optional(),
          links: z.array(z.string()).default([]),
        }),
        response: {
          200: z.union([
            KbEntrySchema,
            z.object({
              ok: z.literal(true),
              entry: KbEntryDraftSchema,
              report: ValidationReportSchema,
            }),
          ]),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        type: string;
        slug: string;
        frontmatter: Record<string, unknown>;
        bodyMd: string;
        status?: string;
        links: string[];
      };
      const dry = (request.query as { dry?: number }).dry === 1;
      const space = await spaceFor(p.orgId, projectId);
      if (!space) throw notFound("KB space not found");
      const graph = await loadKbGraph(db, p.orgId, projectId);
      if (!graph) throw notFound("KB space not found");
      const max =
        (
          await db
            .select()
            .from(kbEntries)
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, body.type),
              ),
            )
            .orderBy(desc(kbEntries.number))
            .limit(1)
        )[0]?.number ?? 0;
      const parentEntries = graph.entries.filter((entry) => body.links.includes(entry.id));
      if (parentEntries.length !== body.links.length) {
        throw new ApiError(400, "link_target_missing", "One or more parent links do not exist");
      }
      const normalized = normalizeKbDraft({
        type: body.type,
        number: max + 1,
        slug: body.slug,
        frontmatter: body.frontmatter,
        bodyMd: body.bodyMd,
        parentEntries,
      });
      const draft = {
        id: "__draft__",
        type: body.type,
        number: max + 1,
        slug: body.slug,
        frontmatter: normalized.frontmatter,
        bodyMd: normalized.bodyMd,
        status: body.status,
        supersedes: null,
      };
      const report = validate({
        space: toHarnessSpace(space),
        entries: [...graph.entries, draft],
        links: [
          ...graph.links,
          ...parentEntries.flatMap((parent) => [
            { fromEntry: "__draft__", toEntry: parent.id },
            { fromEntry: parent.id, toEntry: "__draft__" },
          ]),
        ],
        entryId: "__draft__",
        validateSpecials: false,
      });
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "KB entry failed validation", report);
      }
      if (dry) {
        return { ok: true, entry: draft, report };
      }
      const entry = await db.transaction(async (tx) => {
        const inserted = (
          await tx
            .insert(kbEntries)
            .values({
              id: newId("kb"),
              orgId: p.orgId,
              spaceId: space.id,
              type: body.type,
              number: max + 1,
              slug: body.slug,
              frontmatter: normalized.frontmatter,
              bodyMd: normalized.bodyMd,
              status: body.status,
            })
            .returning()
        )[0];
        if (!inserted) throw new ApiError(500, "insert_failed", "Could not create KB entry");
        const childArtifactId = artifactIdFor(toHarnessEntry(inserted));
        for (const link of body.links) {
          await tx
            .insert(kbLinks)
            .values([
              { orgId: p.orgId, spaceId: space.id, fromEntry: inserted.id, toEntry: link },
              { orgId: p.orgId, spaceId: space.id, fromEntry: link, toEntry: inserted.id },
            ])
            .onConflictDoNothing();
          const parent = parentEntries.find((candidate) => candidate.id === link);
          if (parent) {
            await tx
              .update(kbEntries)
              .set({
                bodyMd: ensureLinks(parent.bodyMd, [childArtifactId]),
                updatedAt: new Date(),
              })
              .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, parent.id)));
          }
        }
        await tx
          .update(kbSpaces)
          .set({ activeMd: ensureActive(space.activeMd, [childArtifactId]), updatedAt: new Date() })
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, space.id)));
        return inserted;
      });
      return entry;
    },
  );

  app.patch(
    "/v1/kb/entries/:entryId",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          type: z.string().optional(),
          number: z.number().int().optional(),
          slug: z.string().optional(),
          frontmatter: AnyObject.optional(),
          bodyMd: z.string().optional(),
          status: z.string().optional(),
          supersedes: z.string().nullable().optional(),
        }),
        response: { 200: KbEntrySchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { entryId } = request.params as { entryId: string };
      const body = request.body as {
        type?: string;
        number?: number;
        slug?: string;
        frontmatter?: Record<string, unknown>;
        bodyMd?: string;
        status?: string;
        supersedes?: string | null;
      };
      const current = await loadKbEntryForPrincipal(p, entryId);
      // Every page is freely editable — history, not immutability, is the
      // safety net: the prior content is captured as a version in the same
      // transaction as the update below.
      const space = (
        await db
          .select()
          .from(kbSpaces)
          .where(and(eq(kbSpaces.orgId, p.orgId), eq(kbSpaces.id, current.spaceId)))
          .limit(1)
      )[0];
      if (!space) throw notFound("KB space not found");
      const entries = await db
        .select()
        .from(kbEntries)
        .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.spaceId, current.spaceId)));
      const links = await db
        .select()
        .from(kbLinks)
        .where(and(eq(kbLinks.orgId, p.orgId), eq(kbLinks.spaceId, current.spaceId)));
      const patch = definedFields({
        type: body.type,
        number: body.number,
        slug: body.slug,
        frontmatter: body.frontmatter,
        bodyMd: body.bodyMd,
        status: body.status,
        supersedes: body.supersedes,
        updatedAt: new Date(),
      });
      // Citing another artifact IS linking it: the body is the source of
      // truth for the graph. Cites found in a saved body are normalized into
      // the ## Links section and added to kb_links; partners no longer cited
      // are unlinked — but only when validation proves the graph stays sound
      // without them, so structural chain links (required parents, the
      // supersede chain) survive uncited.
      const entryArtifactId = artifactIdFor(toHarnessEntry({ ...current, ...patch }));
      const citedTargets: typeof entries = [];
      const removedTargets: typeof entries = [];
      let linkSet = links.map((link) => ({ fromEntry: link.fromEntry, toEntry: link.toEntry }));
      if (typeof patch.bodyMd === "string") {
        const refs = citedArtifactIds(patch.bodyMd);
        refs.delete(entryArtifactId);
        for (const target of entries) {
          if (target.id !== entryId && refs.has(artifactIdFor(toHarnessEntry(target)))) {
            citedTargets.push(target);
          }
        }
        // Normalize even with zero cites — the validator wants the section.
        patch.bodyMd = ensureLinks(
          patch.bodyMd,
          citedTargets.map((target) => artifactIdFor(toHarnessEntry(target))),
        );
        linkSet = [
          ...linkSet,
          ...citedTargets.flatMap((target) => [
            { fromEntry: entryId, toEntry: target.id },
            { fromEntry: target.id, toEntry: entryId },
          ]),
        ];
      }
      const patched = { ...current, ...patch };
      const validationEntries = entries.map((entry) =>
        toHarnessEntry(entry.id === entryId ? patched : entry),
      );
      const validateWith = (candidateLinks: typeof linkSet, targetEntryId: string) =>
        validate({
          space: toHarnessSpace(space),
          entries: validationEntries,
          links: candidateLinks,
          entryId: targetEntryId,
          validateSpecials: false,
        });
      if (typeof patch.bodyMd === "string") {
        const citedIds = new Set(citedTargets.map((t) => artifactIdFor(toHarnessEntry(t))));
        const partnerIds = new Set<string>();
        for (const link of links) {
          if (link.fromEntry === entryId) partnerIds.add(link.toEntry);
          if (link.toEntry === entryId) partnerIds.add(link.fromEntry);
        }
        for (const partner of entries) {
          if (!partnerIds.has(partner.id)) continue;
          const partnerArtifactId = artifactIdFor(toHarnessEntry(partner));
          if (citedIds.has(partnerArtifactId)) continue;
          if (current.supersedes === partnerArtifactId) continue;
          if (partner.supersedes === entryArtifactId) continue;
          const without = linkSet.filter(
            (link) =>
              !(
                (link.fromEntry === entryId && link.toEntry === partner.id) ||
                (link.fromEntry === partner.id && link.toEntry === entryId)
              ),
          );
          if (validateWith(without, entryId).ok && validateWith(without, partner.id).ok) {
            linkSet = without;
            removedTargets.push(partner);
          }
        }
      }
      const report = validateWith(linkSet, entryId);
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "KB entry failed validation", report);
      }
      const row = await db.transaction(async (tx) => {
        const latest = (
          await tx
            .select()
            .from(kbEntryVersions)
            .where(eq(kbEntryVersions.entryId, entryId))
            .orderBy(desc(kbEntryVersions.version))
            .limit(1)
        )[0];
        if (!coalescesWith(latest, p)) {
          await tx.insert(kbEntryVersions).values({
            id: newId("ver"),
            orgId: p.orgId,
            entryId,
            version: (latest?.version ?? 0) + 1,
            slug: current.slug,
            frontmatter: current.frontmatter ?? {},
            bodyMd: current.bodyMd,
            status: current.status,
            savedBy: { type: p.type, id: p.id },
          });
        }
        for (const target of citedTargets) {
          await tx
            .insert(kbLinks)
            .values([
              {
                orgId: p.orgId,
                spaceId: current.spaceId,
                fromEntry: entryId,
                toEntry: target.id,
              },
              {
                orgId: p.orgId,
                spaceId: current.spaceId,
                fromEntry: target.id,
                toEntry: entryId,
              },
            ])
            .onConflictDoNothing();
        }
        for (const target of removedTargets) {
          await tx
            .delete(kbLinks)
            .where(
              and(
                eq(kbLinks.orgId, p.orgId),
                eq(kbLinks.spaceId, current.spaceId),
                or(
                  and(eq(kbLinks.fromEntry, entryId), eq(kbLinks.toEntry, target.id)),
                  and(eq(kbLinks.fromEntry, target.id), eq(kbLinks.toEntry, entryId)),
                ),
              ),
            );
        }
        return (
          await tx
            .update(kbEntries)
            .set(patch)
            .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, entryId)))
            .returning()
        )[0];
      });
      if (!row) throw notFound("KB entry not found");
      return row;
    },
  );

  app.get(
    "/v1/kb/entries/:entryId/versions",
    {
      config: { permission: "kb:read" },
      schema: {
        params: IdParams,
        response: { 200: z.array(KbEntryVersionSchema) },
      },
    },
    async (request) => {
      const p = principal(request);
      const { entryId } = request.params as { entryId: string };
      await loadKbEntryForPrincipal(p, entryId);
      return db
        .select()
        .from(kbEntryVersions)
        .where(and(eq(kbEntryVersions.orgId, p.orgId), eq(kbEntryVersions.entryId, entryId)))
        .orderBy(desc(kbEntryVersions.version));
    },
  );

  app.post(
    "/v1/projects/:projectId/kb/validate",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        response: { 200: ValidationReportSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      return validateProjectKb(db, p.orgId, projectId);
    },
  );

  app.post(
    "/v1/runs/:runId/kb-checkpoint",
    {
      config: { public: true },
      schema: { params: IdParams, response: { 200: ValidationReportSchema } },
    },
    async (request) => {
      const { runId } = request.params as { runId: string };
      const token = bearer(request.headers.authorization);
      if (!token) throw new ApiError(401, "unauthorized", "Runner token required");
      const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0];
      if (!run) throw notFound("Run not found");
      const sandbox = readSandbox(run.sandbox);
      if (!sandbox.runnerTokenHash || !(await verifyKey(token, sandbox.runnerTokenHash))) {
        throw new ApiError(401, "unauthorized", "Invalid runner token");
      }
      return validateProjectKb(db, run.orgId, run.projectId);
    },
  );

  async function spaceFor(orgId: string, projectId: string) {
    return (
      await db
        .select()
        .from(kbSpaces)
        .where(and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.projectId, projectId)))
        .limit(1)
    )[0];
  }

  async function loadKbEntryForPrincipal(p: Principal, entryId: string) {
    const row = (
      await db
        .select({ entry: kbEntries, space: kbSpaces })
        .from(kbEntries)
        .innerJoin(kbSpaces, eq(kbEntries.spaceId, kbSpaces.id))
        .where(and(eq(kbEntries.orgId, p.orgId), eq(kbEntries.id, entryId)))
        .limit(1)
    )[0];
    if (!row) throw notFound("KB entry not found");
    assertBareRowProjectScope(p, row.space.projectId, "KB entry not found");
    return row.entry;
  }

  // Transcript / note intake: store the raw capture as a Signal (the log type
  // with provenance) and hand it to the Product Owner for a backlog review.
  // The review run compares the capture against the pipeline and active
  // decisions and emits its proposed changes as individual HITL proposals.
  app.post(
    "/v1/projects/:projectId/kb/intake",
    {
      config: { permission: "kb:write", auditAction: "kb.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          title: z.string().min(3),
          source: z.string().min(2),
          bodyMd: z.string().min(10),
          dispatch: z.boolean().default(true),
        }),
        response: {
          200: z.object({
            entry: KbEntrySchema,
            artifactId: z.string(),
            runId: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        title: string;
        source: string;
        bodyMd: string;
        dispatch: boolean;
      };
      const space = await spaceFor(p.orgId, projectId);
      if (!space) throw notFound("KB space not found");
      const graph = await loadKbGraph(db, p.orgId, projectId);
      if (!graph) throw notFound("KB space not found");
      const slug = body.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      if (!slug) throw new ApiError(400, "intake_title_invalid", "Title yields an empty slug");
      const max =
        (
          await db
            .select()
            .from(kbEntries)
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.spaceId, space.id),
                eq(kbEntries.type, "S"),
              ),
            )
            .orderBy(desc(kbEntries.number))
            .limit(1)
        )[0]?.number ?? 0;
      const normalized = normalizeKbDraft({
        type: "S",
        number: max + 1,
        slug,
        frontmatter: {
          source: body.source,
          provenance: {
            receivedAt: new Date().toISOString(),
            by: { type: p.type, id: p.id },
          },
        },
        bodyMd: body.bodyMd,
        parentEntries: [],
      });
      const draft = {
        id: "__draft__",
        type: "S",
        number: max + 1,
        slug,
        frontmatter: normalized.frontmatter,
        bodyMd: normalized.bodyMd,
        status: null,
        supersedes: null,
      };
      const report = validate({
        space: toHarnessSpace(space),
        entries: [...graph.entries, draft],
        links: graph.links,
        entryId: "__draft__",
        validateSpecials: false,
      });
      if (!report.ok) {
        throw new ApiError(400, "kb_validation_failed", "Intake entry failed validation", report);
      }
      const entry = (
        await db
          .insert(kbEntries)
          .values({
            id: newId("kb"),
            orgId: p.orgId,
            spaceId: space.id,
            type: "S",
            number: max + 1,
            slug,
            frontmatter: normalized.frontmatter,
            bodyMd: normalized.bodyMd,
          })
          .returning()
      )[0];
      if (!entry) throw new ApiError(500, "insert_failed", "Could not store intake entry");
      const artifactId = artifactIdFor(toHarnessEntry(entry));
      let runId: string | null = null;
      if (body.dispatch) {
        const owner = (
          await db
            .select()
            .from(agentDefs)
            .where(
              and(
                eq(agentDefs.orgId, p.orgId),
                eq(agentDefs.projectId, projectId),
                eq(agentDefs.name, "project-owner"),
                eq(agentDefs.enabled, true),
              ),
            )
            .limit(1)
        )[0];
        if (!owner) {
          throw new ApiError(400, "no_owner_agent", "Project has no enabled project-owner agent");
        }
        const trigger = {
          type: "kb_intake",
          entryId: entry.id,
          artifactId,
          source: body.source,
          title: body.title,
          instruction:
            "A new capture landed in the KB. Read it, read the pipeline and the active decisions, then propose the backlog and decision changes it implies — one proposal per change, citing " +
            artifactId +
            " as evidence.",
        };
        const run = (
          await withBuilderPlanPreflight(
            db,
            {
              orgId: p.orgId,
              projectId,
              mode: owner.name,
              agentDefId: owner.id,
              trigger,
              actor: { type: p.type, id: p.id },
              source: "kb_intake_dispatch",
            },
            (tx, admission) =>
              tx
                // builder-plan-preflight: kb_intake_dispatch
                .insert(runs)
                .values({
                  id: newId("run"),
                  orgId: p.orgId,
                  projectId,
                  agentDefId: owner.id,
                  mode: admission.mode,
                  engine: owner.engine,
                  trigger,
                  gh: {},
                  createdBy: { type: p.type, id: p.id },
                })
                .returning(),
          )
        )[0];
        if (!run) throw new ApiError(500, "insert_failed", "Could not dispatch the review run");
        await db.insert(runEvents).values({
          orgId: p.orgId,
          runId: run.id,
          seq: 1,
          type: "queued",
          data: { queue: "runs.dispatch" },
        });
        await app.enqueue("runs.dispatch", { runId: run.id, orgId: p.orgId });
        runId = run.id;
      }
      return { entry, artifactId, runId };
    },
  );

  app.get(
    "/v1/projects/:projectId/tasks",
    {
      config: { permission: "tasks:read" },
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: z.array(TaskSchema) },
      },
    },
    async (request) => {
      const query = request.query as PageQueryValue;
      return db
        .select()
        .from(poTasks)
        .where(
          and(
            eq(poTasks.orgId, principal(request).orgId),
            eq(poTasks.projectId, (request.params as { projectId: string }).projectId),
          ),
        )
        .orderBy(desc(poTasks.createdAt), desc(poTasks.id))
        .limit(query.limit)
        .offset(query.offset);
    },
  );
  app.post(
    "/v1/projects/:projectId/tasks",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: IdParams,
        body: z.object({
          title: z.string(),
          bodyMd: z.string(),
          status: z.string().default("draft"),
          kbEntryId: z.string().optional(),
          wsjf: AnyObject.default({}),
        }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const body = request.body as {
        title: string;
        bodyMd: string;
        status: string;
        kbEntryId?: string;
        wsjf: Record<string, unknown>;
      };
      if (body.kbEntryId) {
        const entry = (
          await db
            .select({ id: kbEntries.id })
            .from(kbEntries)
            .innerJoin(kbSpaces, eq(kbSpaces.id, kbEntries.spaceId))
            .where(
              and(
                eq(kbEntries.orgId, p.orgId),
                eq(kbEntries.id, body.kbEntryId),
                eq(kbSpaces.orgId, p.orgId),
                eq(kbSpaces.projectId, projectId),
              ),
            )
            .limit(1)
        )[0];
        if (!entry) throw notFound("KB entry not found");
      }
      const row = (
        await db
          .insert(poTasks)
          .values({
            id: newId("task"),
            orgId: p.orgId,
            projectId,
            title: body.title,
            bodyMd: body.bodyMd,
            status: body.status,
            kbEntryId: body.kbEntryId,
            wsjf: body.wsjf,
          })
          .returning()
      )[0];
      if (!row) throw new ApiError(500, "insert_failed", "Could not create task");
      return row;
    },
  );
  app.patch(
    "/v1/projects/:projectId/tasks/:taskId",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: z.object({ projectId: z.string(), taskId: z.string() }),
        body: z.object({
          title: z.string().optional(),
          bodyMd: z.string().optional(),
          status: z.string().optional(),
          kbEntryId: z.string().optional(),
          wsjf: AnyObject.optional(),
          gh: AnyObject.optional(),
        }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, taskId } = request.params as { projectId: string; taskId: string };
      const body = request.body as {
        title?: string;
        bodyMd?: string;
        status?: string;
        kbEntryId?: string;
        wsjf?: Record<string, unknown>;
        gh?: Record<string, unknown>;
      };
      assertProjectScope(p, projectId);
      const row = (
        await db
          .update(poTasks)
          .set(
            definedFields({
              title: body.title,
              bodyMd: body.bodyMd,
              status: body.status,
              kbEntryId: body.kbEntryId,
              wsjf: body.wsjf,
              gh: body.gh,
              updatedAt: new Date(),
            }),
          )
          .where(
            and(
              eq(poTasks.orgId, p.orgId),
              eq(poTasks.projectId, projectId),
              eq(poTasks.id, taskId),
            ),
          )
          .returning()
      )[0];
      if (!row) throw notFound("Task not found");
      return row;
    },
  );
  app.delete(
    "/v1/projects/:projectId/tasks/:taskId",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: z.object({ projectId: z.string(), taskId: z.string() }),
        response: { 200: Ok },
      },
    },
    async (request) => {
      const p = principal(request);
      const { projectId, taskId } = request.params as { projectId: string; taskId: string };
      assertProjectScope(p, projectId);
      await db
        .delete(poTasks)
        .where(
          and(eq(poTasks.orgId, p.orgId), eq(poTasks.projectId, projectId), eq(poTasks.id, taskId)),
        );
      return { ok: true };
    },
  );
  app.post(
    "/v1/tasks/:taskId/transition",
    {
      config: { permission: "tasks:write", auditAction: "task.updated" },
      schema: {
        params: IdParams,
        body: z.object({ status: z.string() }),
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const p = principal(request);
      const { taskId } = request.params as { taskId: string };
      const task = (
        await db
          .select()
          .from(poTasks)
          .where(and(eq(poTasks.orgId, p.orgId), eq(poTasks.id, taskId)))
          .limit(1)
      )[0];
      if (!task) throw notFound("Task not found");
      assertBareRowProjectScope(p, task.projectId, "Task not found");
      const transitioned = (
        await db
          .update(poTasks)
          .set({ status: (request.body as { status: string }).status, updatedAt: new Date() })
          .where(
            and(
              eq(poTasks.orgId, p.orgId),
              eq(poTasks.projectId, task.projectId),
              eq(poTasks.id, taskId),
            ),
          )
          .returning()
      )[0];
      if (!transitioned) throw notFound("Task not found");
      return transitioned;
    },
  );

  app.post(
    "/v1/tasks/:taskId/propose",
    {
      config: { permission: "tasks:write", auditAction: "task.proposed" },
      schema: { params: IdParams, response: { 200: ProposalSchema } },
    },
    async (request) => {
      const p = principal(request);
      const { taskId } = request.params as { taskId: string };
      const task = (
        await db
          .select()
          .from(poTasks)
          .where(and(eq(poTasks.orgId, p.orgId), eq(poTasks.id, taskId)))
          .limit(1)
      )[0];
      if (!task) throw notFound("Task not found");
      assertBareRowProjectScope(p, task.projectId, "Task not found");
      const opener = await proposalOpener(db, request, p);
      const actionType = await actionTypeByName(p.orgId, "task_creation");
      if (!actionType) throw notFound("Action type not found");
      const repo = (
        await db
          .select()
          .from(repos)
          .where(and(eq(repos.orgId, p.orgId), eq(repos.projectId, task.projectId)))
          .limit(1)
      )[0];
      const project = (
        await db
          .select()
          .from(projects)
          .where(and(eq(projects.orgId, p.orgId), eq(projects.id, task.projectId)))
          .limit(1)
      )[0];
      const board = objectOrEmpty(project?.settings).board;
      const proposal = (
        await db
          .insert(proposals)
          .values({
            id: newId("prop"),
            orgId: p.orgId,
            projectId: task.projectId,
            actionTypeId: actionType.id,
            payload: {
              taskId: task.id,
              title: task.title,
              bodyMd: task.bodyMd,
              wsjf: task.wsjf,
              target: {
                repo: repo ? { owner: repo.owner, name: repo.name } : null,
                board,
              },
            },
            contextMd: `Task creation proposal for ${task.title}`,
            expiresAt: new Date(Date.now() + actionType.defaultTtlHours * 3600_000),
          })
          .returning()
      )[0];
      if (!proposal) throw new ApiError(500, "insert_failed", "Could not create proposal");
      await db.insert(proposalEvents).values({
        orgId: p.orgId,
        proposalId: proposal.id,
        seq: 1,
        type: "open",
        actor: opener.actor,
        data: opener.data,
      });
      await db
        .update(poTasks)
        .set({ status: "proposed", updatedAt: new Date() })
        .where(
          and(
            eq(poTasks.orgId, p.orgId),
            eq(poTasks.projectId, task.projectId),
            eq(poTasks.id, task.id),
          ),
        );
      return { ...proposal, actionType: actionType.name };
    },
  );

  async function actionTypeByName(orgId: string, name: string) {
    return (
      await db
        .select()
        .from(actionTypes)
        .where(and(eq(actionTypes.orgId, orgId), eq(actionTypes.name, name)))
        .limit(1)
    )[0];
  }
}
