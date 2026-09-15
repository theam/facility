import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import { PREVIEW_TOKEN_PATTERN } from "../../workspaces/native-preview.js";

const Params = z.object({
  workspaceId: z.string().regex(/^ws_[a-z0-9]{16,64}$/),
  service: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
const Token = z.string().regex(PREVIEW_TOKEN_PATTERN);
const Session = z.string().regex(/^psess_[a-z0-9]{16,64}$/);

export async function registerNativeWorkspacePreviewRoutes(
  app: FastifyInstance,
  config: AppConfig,
) {
  const previews = app.storyDomain.previews;
  app.get(
    "/workspace-preview-login/:workspaceId/:service",
    {
      config: { public: true },
      schema: {
        params: Params,
        querystring: z.object({ challenge: Token }),
        operationId: "loginNativeWorkspacePreview",
      },
    },
    async (request, reply) => {
      if (!config.nativePreviews)
        throw new ApiError(404, "not_found", "Native previews are disabled");
      const { workspaceId, service } = request.params as z.infer<typeof Params>;
      const { challenge } = request.query as { challenge: string };
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      if (!request.principal) {
        const login = new URL("/api/auth/login", config.webUrl ?? config.publicUrl);
        login.searchParams.set(
          "returnTo",
          `/api/workspace-preview-login/${workspaceId}/${service}?challenge=${encodeURIComponent(challenge)}`,
        );
        return reply.redirect(login.toString());
      }
      const result = await previews.nativeLogin(request.principal, workspaceId, service, challenge);
      return reply.redirect(result.url);
    },
  );
  app.post(
    "/workspace-preview-native/:workspaceId/:service/exchange",
    {
      config: { public: true },
      schema: {
        params: Params,
        body: z.object({ sessionId: Session, code: Token, verifier: Token }).strict(),
        operationId: "exchangeNativeWorkspacePreview",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return previews.nativeExchange(
        {
          ...(request.params as z.infer<typeof Params>),
          ...(request.body as { sessionId: string; code: string; verifier: string }),
        },
        request.headers["x-facility-preview-token"] ?? "",
      );
    },
  );
  app.post(
    "/workspace-preview-native/:workspaceId/:service/authorize",
    {
      // A page load authorizes every asset and app request. Keep a bounded,
      // independent per-IP budget for this route, not the general API's 200/min.
      // Do not trust caller-supplied IP/session headers to create fresh buckets.
      config: { public: true, rateLimit: { max: 6_000, timeWindow: "1 minute" } },
      schema: {
        params: Params,
        body: z.object({ sessionId: Session, token: Token }).strict(),
        operationId: "authorizeNativeWorkspacePreview",
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return previews.nativeAuthorize(
        {
          ...(request.params as z.infer<typeof Params>),
          ...(request.body as { sessionId: string; token: string }),
        },
        request.headers["x-facility-preview-token"] ?? "",
      );
    },
  );
}
