import type { FastifyReply } from "fastify";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
    /**
     * Opt-in for operational 5xx responses whose code/message are part of the
     * external contract (for example, an intentionally unconfigured optional
     * integration). Unknown and internal failures remain masked by default.
     */
    public expose = statusCode < 500,
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, error: ApiError) {
  // Unknown/internal 5xx detail stays private. Deliberate operational states
  // may opt into a stable public machine code and remediation-safe message.
  if (error.statusCode >= 500 && !error.expose) {
    reply.log.error({ err: error }, "server error");
    return reply
      .status(error.statusCode)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  }
  return reply.status(error.statusCode).send({
    error: { code: error.code, message: error.message, details: error.details },
  });
}

export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
