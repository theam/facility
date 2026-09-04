type OpenApiOperation = Record<string, unknown> & {
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
};

export type OpenApiDocument = Record<string, unknown> & {
  tags?: Array<{ name: string; description: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: Record<string, unknown> & {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

export type OpenApiRouteRecord = {
  method: string;
  url: string;
  permission?: string | string[];
  public?: boolean;
  idempotent?: boolean;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const standardErrors = Object.fromEntries(
  [
    ["400", "The request is invalid."],
    ["401", "Authentication is required or invalid."],
    ["403", "The authenticated principal lacks the required permission."],
    ["404", "The resource was not found or is outside the principal scope."],
    ["409", "The request conflicts with current resource state."],
    ["429", "The request rate limit was exceeded."],
    ["500", "An unexpected server error occurred."],
    ["503", "A required service is unavailable."],
  ].map(([status, description]) => [
    status,
    {
      description,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
      },
    },
  ]),
);

export function enrichOpenApi(document: OpenApiDocument, routes: OpenApiRouteRecord[]) {
  const paths = document.paths ?? {};
  delete paths["/__test/session"];
  delete paths["/auth/default-org"];
  const operationIdCounts = new Map<string, number>();
  for (const pathItem of Object.values(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || typeof operation.operationId !== "string") continue;
      operationIdCounts.set(
        operation.operationId,
        (operationIdCounts.get(operation.operationId) ?? 0) + 1,
      );
    }
  }
  const routeMap = new Map(
    routes.map((route) => [`${route.method.toUpperCase()} ${toOpenApiPath(route.url)}`, route]),
  );

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const route = routeMap.get(`${method.toUpperCase()} ${path}`);
      if (
        typeof operation.operationId !== "string" ||
        (operationIdCounts.get(operation.operationId) ?? 0) > 1
      ) {
        operation.operationId = operationId(method, path);
      }
      operation.summary ??= operationSummary(method, path);
      operation.tags ??= [operationTag(path)];
      if (route?.permission) {
        operation.security ??= [{ bearerAuth: [] }, { sessionCookie: [] }];
        operation["x-facility-permission"] = route.permission;
      } else if (path === "/webhooks/github") {
        operation.security ??= [{ githubSignature: [] }];
      } else {
        operation.security ??= [];
      }
      if (route?.idempotent) addIdempotencyHeader(operation);
      if (method === "post" && path === "/webhooks/github") {
        addHeaders(operation, [
          ["X-Hub-Signature-256", "HMAC-SHA256 over the exact request body."],
          ["X-GitHub-Delivery", "Sender-unique GitHub delivery id."],
          ["X-GitHub-Event", "GitHub webhook event name."],
        ]);
      }
      operation.responses = { ...standardErrors, ...(operation.responses ?? {}) };
    }
  }

  if (!document.components) document.components = {};
  const components = document.components;
  components.schemas = {
    ...(components.schemas ?? {}),
    ErrorResponse: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: {
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {},
          },
        },
      },
    },
  };
  components.securitySchemes = {
    ...(components.securitySchemes ?? {}),
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      description: "Facility API key or OAuth access token.",
    },
    sessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "facility_session",
      description: "Facility browser session.",
    },
    githubSignature: {
      type: "apiKey",
      in: "header",
      name: "X-Hub-Signature-256",
      description: "GitHub App webhook signature.",
    },
  };
  const names = new Set<string>();
  for (const pathItem of Object.values(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) for (const tag of operation.tags ?? []) names.add(tag);
    }
  }
  document.tags = [...names].sort().map((name) => ({
    name,
    description:
      {
        Authentication: "Browser identity and Facility MCP authorization.",
        GitHub: "GitHub App installations, repositories, kickstart, and webhooks.",
        Organization: "Members, roles, API keys, and organization settings.",
        Projects: "Projects and their connected repositories.",
        Stories: "Persistent story workspaces and shared conversations.",
        Previews: "Authenticated access to services running inside story workspaces.",
        Operations: "Service health and readiness.",
      }[name] ?? "Facility operations.",
  }));
  document.paths = paths;
  return document;
}

function addIdempotencyHeader(operation: OpenApiOperation) {
  const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
  parameters.push({
    name: "Idempotency-Key",
    in: "header",
    required: false,
    description: "Replays the first response for the same principal, route, key, and body.",
    schema: { type: "string", minLength: 8, maxLength: 200 },
  });
  operation.parameters = parameters;
}

function addHeaders(
  operation: OpenApiOperation,
  headers: Array<[name: string, description: string]>,
) {
  const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
  for (const [name, description] of headers) {
    parameters.push({
      name,
      in: "header",
      required: true,
      description,
      schema: { type: "string" },
    });
  }
  operation.parameters = parameters;
}

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(method: string, path: string) {
  const words = path
    .replace(/^\/v1\//, "")
    .split("/")
    .filter(Boolean)
    .map((part) => (part === "*" ? "path" : part.replace(/[{}]/g, "")))
    .flatMap((part) => part.split(/[-_]/))
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`);
  return `${method.toLowerCase()}${words.join("")}`;
}

function operationSummary(method: string, path: string) {
  const custom: Record<string, string> = {
    "get /health": "Check API and database health",
    "get /readyz": "Check API readiness",
    "post /webhooks/github": "Receive a GitHub App webhook",
    "post /v1/projects/{projectId}/workspace-stories": "Start a persistent story workspace",
  };
  if (custom[`${method} ${path}`]) return custom[`${method} ${path}`];
  const verb =
    { get: "Get", post: "Create", patch: "Update", put: "Replace", delete: "Delete" }[method] ??
    method.toUpperCase();
  return `${verb} ${path.split("/").filter(Boolean).at(-1)?.replace(/[{}-]/g, " ") ?? "resource"}`;
}

function operationTag(path: string) {
  if (/^\/(?:health|readyz)$/.test(path)) return "Operations";
  if (path.startsWith("/auth/") || path.startsWith("/oauth/")) return "Authentication";
  if (path.startsWith("/webhooks/") || path.includes("/github/") || path.includes("/kickstart")) {
    return "GitHub";
  }
  if (path.includes("/workspace-preview") || path.includes("/preview/")) return "Previews";
  if (path.includes("/workspace-stories")) return "Stories";
  if (path.includes("/projects")) return "Projects";
  if (/\/v1\/(?:me|org|members|roles|keys)/.test(path)) return "Organization";
  return "Facility";
}
