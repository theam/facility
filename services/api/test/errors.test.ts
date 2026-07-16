import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError, sendError } from "../src/errors.js";

function fakeReply() {
  const captured: { status?: number; body?: { error: { code: string; message: string } } } = {};
  const reply = {
    log: { error() {} },
    status(code: number) {
      captured.status = code;
      return reply;
    },
    send(body: unknown) {
      captured.body = body as { error: { code: string; message: string } };
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, captured };
}

describe("sendError", () => {
  it("returns a generic body for 5xx ApiErrors without leaking internal detail", () => {
    const { reply, captured } = fakeReply();
    sendError(reply, new ApiError(500, "boom", "secret internal detail", { stack: "trace" }));
    expect(captured.status).toBe(500);
    expect(captured.body?.error).toEqual({
      code: "internal_error",
      message: "Internal server error",
    });
    expect(JSON.stringify(captured.body)).not.toContain("secret");
    expect(JSON.stringify(captured.body)).not.toContain("trace");
  });

  it("surfaces 4xx client-error detail", () => {
    const { reply, captured } = fakeReply();
    sendError(reply, new ApiError(404, "not_found", "Project not found"));
    expect(captured.status).toBe(404);
    expect(captured.body?.error.code).toBe("not_found");
    expect(captured.body?.error.message).toBe("Project not found");
  });

  it("surfaces explicitly public operational 5xx codes without weakening the default mask", () => {
    const { reply, captured } = fakeReply();
    sendError(
      reply,
      new ApiError(501, "workos_unconfigured", "WorkOS login is not configured", undefined, true),
    );
    expect(captured.status).toBe(501);
    expect(captured.body?.error).toEqual({
      code: "workos_unconfigured",
      message: "WorkOS login is not configured",
    });
  });
});
