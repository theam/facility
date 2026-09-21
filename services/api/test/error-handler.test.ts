import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { appErrorHandler, mapDatabaseError } from "../src/error-handler.js";
import { ApiError } from "../src/errors.js";

function fakeReply() {
  const captured: {
    status?: number;
    body?: {
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
  } = {};

  const reply = {
    log: { error: vi.fn() },
    status(code: number) {
      captured.status = code;
      return reply;
    },
    send(body: unknown) {
      captured.body = body as typeof captured.body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, captured };
}

function fakeRequest() {
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return {
    log,
    id: "req-test-1",
  } as unknown as FastifyRequest;
}

describe("mapDatabaseError", () => {
  it("maps 23505 unique violation to 409 conflict", () => {
    const error = { code: "23505" };
    const mapped = mapDatabaseError(error);
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.statusCode).toBe(409);
    expect(mapped?.code).toBe("conflict");
    expect(mapped?.message).toBe("A resource with these values already exists");
  });

  it("maps 23505 on cause.code to 409 conflict", () => {
    const error = new Error("DB Error") as Error & { cause: { code: string } };
    error.cause = { code: "23505" };
    const mapped = mapDatabaseError(error);
    expect(mapped?.statusCode).toBe(409);
    expect(mapped?.code).toBe("conflict");
  });

  it("maps 23503 foreign key violation to 400 invalid_reference", () => {
    const error = { code: "23503" };
    const mapped = mapDatabaseError(error);
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe("invalid_reference");
    expect(mapped?.message).toBe("A referenced resource does not exist");
  });

  it.each([
    "23514",
    "22P02",
    "22007",
    "22008",
  ])("maps %s syntax and check violations to 400 bad_request", (code) => {
    const mapped = mapDatabaseError({ code });
    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe("bad_request");
    expect(mapped?.message).toBe("Request values are invalid");
  });

  it("returns undefined for unknown error codes or non-objects", () => {
    expect(mapDatabaseError({ code: "42P01" })).toBeUndefined();
    expect(mapDatabaseError(null)).toBeUndefined();
    expect(mapDatabaseError("string error")).toBeUndefined();
    expect(mapDatabaseError(123)).toBeUndefined();
  });
});

describe("appErrorHandler", () => {
  it("handles ApiError instances directly via sendError", () => {
    const { reply, captured } = fakeReply();
    const request = fakeRequest();
    const apiError = new ApiError(404, "story_not_found", "Story does not exist");

    appErrorHandler(apiError, request, reply);

    expect(captured.status).toBe(404);
    expect(captured.body?.error.code).toBe("story_not_found");
    expect(captured.body?.error.message).toBe("Story does not exist");
  });

  it("maps database errors and returns formatted client response", () => {
    const { reply, captured } = fakeReply();
    const request = fakeRequest();
    const dbError = Object.assign(new Error("duplicate key"), { code: "23505" });

    appErrorHandler(dbError, request, reply);

    expect(captured.status).toBe(409);
    expect(captured.body?.error.code).toBe("conflict");
    expect(captured.body?.error.message).toBe("A resource with these values already exists");
  });

  it("masks unhandled 5xx server errors without leaking internals", () => {
    const { reply, captured } = fakeReply();
    const request = fakeRequest();
    const serverError = new Error("Database connection password leaked in stack trace");

    appErrorHandler(serverError, request, reply);

    expect(captured.status).toBe(500);
    expect(captured.body?.error).toEqual({
      code: "internal_error",
      message: "Internal server error",
    });
    expect(request.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: serverError }),
      "unhandled server error",
    );
  });

  it("formats validation errors with details context and issues", () => {
    const { reply, captured } = fakeReply();
    const request = fakeRequest();
    const validationError = Object.assign(new Error("body must have required property 'title'"), {
      statusCode: 400,
      validation: [{ message: "must have required property 'title'" }],
      validationContext: "body",
    }) as unknown as FastifyError;

    appErrorHandler(validationError, request, reply);

    expect(captured.status).toBe(400);
    expect(captured.body?.error).toEqual({
      code: "validation_error",
      message: "body must have required property 'title'",
      details: {
        context: "body",
        issues: [{ message: "must have required property 'title'" }],
      },
    });
  });

  it("formats generic client errors without validation details", () => {
    const { reply, captured } = fakeReply();
    const request = fakeRequest();
    const clientError = Object.assign(new Error("Unsupported media type"), {
      statusCode: 415,
    }) as unknown as FastifyError;

    appErrorHandler(clientError, request, reply);

    expect(captured.status).toBe(415);
    expect(captured.body?.error).toEqual({
      code: "error",
      message: "Unsupported media type",
    });
  });
});
