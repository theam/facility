import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, sendError } from "./errors.js";

interface DatabaseErrorLike {
  code?: string;
  cause?: { code?: string };
}

/**
 * Maps known PostgreSQL constraint and data format errors into standard ApiError instances.
 */
export function mapDatabaseError(error: unknown): ApiError | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const err = error as DatabaseErrorLike;
  const databaseCode = err.code ?? err.cause?.code;

  if (databaseCode === "23505") {
    return new ApiError(409, "conflict", "A resource with these values already exists");
  }
  if (databaseCode === "23503") {
    return new ApiError(400, "invalid_reference", "A referenced resource does not exist");
  }
  if (["23514", "22P02", "22007", "22008"].includes(databaseCode ?? "")) {
    return new ApiError(400, "bad_request", "Request values are invalid");
  }
  return undefined;
}

/**
 * Global Fastify error handler for the Facility API.
 * Ensures consistent error shapes and prevents leakage of internal server errors.
 */
export function appErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ApiError) {
    return sendError(reply, error);
  }

  const mappedDbError = mapDatabaseError(error);
  if (mappedDbError) {
    return sendError(reply, mappedDbError);
  }

  const err = error as FastifyError & {
    validation?: unknown;
    validationContext?: string;
  };
  const status = typeof err.statusCode === "number" ? err.statusCode : 500;

  // Never leak internal error detail on 5xx — log it, return a generic message.
  if (status >= 500) {
    request.log.error({ err }, "unhandled server error");
    return reply
      .status(status)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  }

  return reply.status(status).send({
    error: {
      code: status === 400 ? (err.validation ? "validation_error" : "bad_request") : "error",
      message: err.message,
      ...(err.validation
        ? {
            details: {
              context: err.validationContext,
              issues: err.validation,
            },
          }
        : {}),
    },
  });
}
