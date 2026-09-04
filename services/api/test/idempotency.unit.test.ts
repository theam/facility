import type { FacilityDb } from "@facility/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { beginIdempotentRequest, completeIdempotentRequest } from "../src/idempotency.js";

type MockStoredRow = {
  id: string;
  orgId: string;
  principalId: string;
  method: string;
  path: string;
  keyHash: string;
  requestHash: string;
  state: string;
  statusCode?: number | null;
  responseBody?: unknown;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

describe("Idempotency Unit Tests (Issue #187)", () => {
  function createMockDb(initialRows: MockStoredRow[] = []) {
    const store = new Map<string, MockStoredRow>(initialRows.map((r) => [r.id, { ...r }]));
    const db = {
      insert: () => ({
        values: (data: Omit<MockStoredRow, "createdAt" | "updatedAt">) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (store.has(data.id)) return [];
              store.set(data.id, {
                ...data,
                state: "pending",
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              return [{ id: data.id }];
            },
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Array.from(store.values()),
          }),
        }),
      }),
      update: () => ({
        set: (data: Partial<MockStoredRow>) => ({
          where: () => {
            for (const [id, row] of store.entries()) {
              store.set(id, { ...row, ...data });
            }
          },
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => [],
        }),
      }),
      _store: store,
    };
    return db as unknown as FacilityDb & { _store: Map<string, MockStoredRow> };
  }

  function createMockRequestReply(options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
    permission?: string;
    orgId?: string;
  }) {
    const headers = options.headers ?? {};
    const replyHeaders: Record<string, string> = {};
    let sentStatus: number | undefined;
    let sentPayload: unknown;

    const request = {
      method: options.method ?? "POST",
      url: options.url ?? "/v1/projects/proj-1/kb/entries",
      headers,
      query: options.query,
      body: options.body ?? {},
      routeOptions: {
        config: {
          permission: options.permission ?? "kb:write",
        },
      },
      principal: {
        orgId: options.orgId ?? "org_test",
        type: "user",
        id: "usr_test",
      },
      log: { error: vi.fn() },
      idempotencyId: undefined as string | undefined,
      idempotencyReplayed: undefined as boolean | undefined,
    } as unknown as FastifyRequest;

    const reply = {
      header: (name: string, value: string) => {
        replyHeaders[name.toLowerCase()] = value;
        return reply;
      },
      status: (code: number) => {
        sentStatus = code;
        return reply;
      },
      type: () => reply,
      serializer: () => reply,
      send: (payload: unknown) => {
        sentPayload = payload;
        return reply;
      },
      statusCode: 200,
    } as unknown as FastifyReply;

    return {
      request,
      reply,
      replyHeaders,
      getSentStatus: () => sentStatus,
      getSentPayload: () => sentPayload,
    };
  }

  it("creates a new idempotency claim on first request with query params", async () => {
    const db = createMockDb();
    const { request, reply, replyHeaders } = createMockRequestReply({
      url: "/v1/projects/proj-1/kb/entries?dry=1",
      headers: { "idempotency-key": "test-key-12345" },
      query: { dry: 1 },
      body: { slug: "my-entry" },
    });

    await beginIdempotentRequest(db, request, reply);
    expect(replyHeaders["idempotency-status"]).toBe("created");
    expect(request.idempotencyId).toBeDefined();

    reply.statusCode = 200;
    await completeIdempotentRequest(db, request, reply, { ok: true, dry: true });
    const stored = request.idempotencyId ? db._store.get(request.idempotencyId) : undefined;
    expect(stored?.state).toBe("completed");
  });

  it("replays the request when same key, body, and query (even with permuted params) are used", async () => {
    const db = createMockDb();
    const key = "test-key-replay-123";

    // First call with ?a=1&b=2
    const first = createMockRequestReply({
      url: "/v1/projects/proj-1/items?a=1&b=2",
      headers: { "idempotency-key": key },
      query: { a: "1", b: "2" },
      body: { title: "Item" },
    });
    await beginIdempotentRequest(db, first.request, first.reply);
    expect(first.replyHeaders["idempotency-status"]).toBe("created");
    first.reply.statusCode = 200;
    await completeIdempotentRequest(db, first.request, first.reply, { id: "item_1" });

    // Second call with ?b=2&a=1 (permuted query)
    const second = createMockRequestReply({
      url: "/v1/projects/proj-1/items?b=2&a=1",
      headers: { "idempotency-key": key },
      query: { b: "2", a: "1" },
      body: { title: "Item" },
    });
    await beginIdempotentRequest(db, second.request, second.reply);
    expect(second.replyHeaders["idempotency-status"]).toBe("replayed");
    expect(second.getSentStatus()).toBe(200);
    expect(second.getSentPayload()).toEqual({ id: "item_1" });
  });

  it("rejects key reuse when query parameters differ (e.g. ?dry=1 vs persistent create)", async () => {
    const db = createMockDb();
    const key = "test-key-dry-repro-123";
    const body = { slug: "idempotency-repro", bodyMd: "test" };

    // 1. Dry run
    const dryReq = createMockRequestReply({
      url: "/v1/projects/proj-1/kb/entries?dry=1",
      headers: { "idempotency-key": key },
      query: { dry: 1 },
      body,
    });
    await beginIdempotentRequest(db, dryReq.request, dryReq.reply);
    expect(dryReq.replyHeaders["idempotency-status"]).toBe("created");
    dryReq.reply.statusCode = 200;
    await completeIdempotentRequest(db, dryReq.request, dryReq.reply, {
      ok: true,
      validationOnly: true,
    });

    // 2. Persistent create attempting to reuse key without ?dry=1
    const liveReq = createMockRequestReply({
      url: "/v1/projects/proj-1/kb/entries",
      headers: { "idempotency-key": key },
      query: undefined,
      body,
    });

    await expect(beginIdempotentRequest(db, liveReq.request, liveReq.reply)).rejects.toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "idempotency_key_reused",
      }),
    );
  });

  it("fails closed for legacy dry-run records when queryless live request is sent (preventing silent replay of dry responses)", async () => {
    const { createHash } = await import("node:crypto");
    const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
    const stableJson = (v: unknown): string => {
      if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
      if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
      const object = v as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
        .join(",")}}`;
    };

    const key = "test-key-legacy-dry-repro";
    const body = { slug: "idempotency-repro", bodyMd: "test content" };
    const legacyBodyOnlyHash = sha256(stableJson(body));
    const path = "/v1/projects/proj-1/kb/entries";
    const principalOrgId = "org_test";
    const keyHash = sha256(key);
    const id = `idem_${sha256(`${principalOrgId}:user:usr_test:POST:${path}:${keyHash}`)}`;

    // Seed an unversioned legacy record storing a dry-run response (e.g. from an old instance with ?dry=1)
    const legacyDryRow: MockStoredRow = {
      id,
      orgId: principalOrgId,
      principalId: "user:usr_test",
      method: "POST",
      path,
      keyHash,
      requestHash: legacyBodyOnlyHash,
      state: "completed",
      statusCode: 200,
      responseBody: { ok: true, validationOnly: true },
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    };

    const db = createMockDb([legacyDryRow]);

    // Send a live queryless request with the same key and body.
    // MUST fail closed and reject with 409 rather than replaying the dry-run response.
    const liveQuerylessReq = createMockRequestReply({
      url: path,
      headers: { "idempotency-key": key },
      query: undefined,
      body,
    });

    await expect(
      beginIdempotentRequest(db, liveQuerylessReq.request, liveQuerylessReq.reply),
    ).rejects.toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "idempotency_key_reused",
      }),
    );
  });

  it("fails closed for unversioned legacy fingerprints on any request", async () => {
    const { createHash } = await import("node:crypto");
    const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
    const stableJson = (v: unknown): string => {
      if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
      if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
      const object = v as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
        .join(",")}}`;
    };

    const key = "test-key-legacy-unversioned";
    const body = { name: "Legacy Project", slug: "legacy-proj" };
    const legacyBodyOnlyHash = sha256(stableJson(body));
    const path = "/v1/projects";
    const principalOrgId = "org_test";
    const keyHash = sha256(key);
    const id = `idem_${sha256(`${principalOrgId}:user:usr_test:POST:${path}:${keyHash}`)}`;

    // Seed an existing legacy record with the pre-deployment body-only hash
    const legacyRow: MockStoredRow = {
      id,
      orgId: principalOrgId,
      principalId: "user:usr_test",
      method: "POST",
      path,
      keyHash,
      requestHash: legacyBodyOnlyHash,
      state: "completed",
      statusCode: 200,
      responseBody: { id: "proj_legacy_123", slug: "legacy-proj" },
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    };

    const db = createMockDb([legacyRow]);

    // 1. Request with query parameters (e.g. ?dry=1) against legacy record is rejected with 409
    const queryReq = createMockRequestReply({
      url: `${path}?dry=1`,
      headers: { "idempotency-key": key },
      query: { dry: 1 },
      body,
    });

    await expect(beginIdempotentRequest(db, queryReq.request, queryReq.reply)).rejects.toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "idempotency_key_reused",
      }),
    );

    // 2. Queryless request against unversioned legacy record is also rejected with 409 (fails closed)
    const querylessReq = createMockRequestReply({
      url: path,
      headers: { "idempotency-key": key },
      query: undefined,
      body,
    });

    await expect(
      beginIdempotentRequest(db, querylessReq.request, querylessReq.reply),
    ).rejects.toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "idempotency_key_reused",
      }),
    );
  });
});
