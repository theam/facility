type OpenApiOperation = Record<string, unknown> & {
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
};

export type OpenApiDocument = Record<string, unknown> & {
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

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" },
    },
  },
});

const standardErrors: Record<string, unknown> = {
  "400": errorResponse("The request is invalid."),
  "401": errorResponse("Authentication is required or invalid."),
  "403": errorResponse("The authenticated principal lacks the required permission."),
  "404": errorResponse("The requested resource was not found or is outside the principal scope."),
  "409": errorResponse("The request conflicts with current resource state."),
  "429": errorResponse("The request rate limit was exceeded."),
  "500": errorResponse("An unexpected server error occurred."),
  "503": errorResponse("A required service is unavailable."),
};

export function enrichOpenApi(
  document: OpenApiDocument,
  routes: OpenApiRouteRecord[],
): OpenApiDocument {
  const paths = document.paths ?? {};
  for (const path of Object.keys(paths)) {
    if (path.startsWith("/internal/")) delete paths[path];
  }
  delete paths["/auth/dev-login"];
  delete paths["/auth/default-org"];

  const routeMap = new Map(
    routes.map((route) => [`${route.method.toUpperCase()} ${toOpenApiPath(route.url)}`, route]),
  );

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathParameters = new Set(
      [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter(Boolean),
    );
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const route = routeMap.get(`${method.toUpperCase()} ${path}`);
      operation.operationId ??= operationId(method, path);
      operation.summary ??= operationSummary(method, path);
      operation.tags ??= [operationTag(path)];
      const permission = route?.permission;
      if (permission) {
        operation.security ??= [{ bearerAuth: [] }, { sessionCookie: [] }];
        operation["x-facility-permission"] = permission;
      } else if (path === "/v1/runs/{runId}/kb-checkpoint") {
        operation.security ??= [{ runnerToken: [] }];
      } else if (path === "/webhooks/github") {
        operation.security ??= [{ githubSignature: [] }];
      } else if (path === "/webhooks/inbound/{integrationId}") {
        operation.security ??= [{ facilitySignature: [] }];
      } else {
        operation.security ??= [];
      }
      // Several routes intentionally share a permissive Zod params object at
      // runtime. Fastify's OpenAPI transform otherwise exposes every key from
      // that object as a required path parameter on every operation. Retain
      // only placeholders that are actually present in this path.
      if (Array.isArray(operation.parameters)) {
        operation.parameters = operation.parameters.filter((parameter) => {
          if (!parameter || typeof parameter !== "object") return true;
          const value = parameter as { in?: unknown; name?: unknown };
          return (
            value.in !== "path" ||
            (typeof value.name === "string" && pathParameters.has(value.name))
          );
        });
      }
      if (route?.idempotent || (method === "post" && route?.permission)) {
        const parameters = Array.isArray(operation.parameters)
          ? [...(operation.parameters as unknown[])]
          : [];
        parameters.push({
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "Replays the original response for the same principal, path, key, and request body for 24 hours.",
          schema: { type: "string", minLength: 8, maxLength: 200 },
        });
        operation.parameters = parameters;
      }
      if (method === "post" && path === "/webhooks/github") {
        addHeaderParameters(operation, [
          ["X-GitHub-Delivery", "Sender-unique GitHub delivery id."],
          ["X-GitHub-Event", "GitHub webhook event name."],
        ]);
        operation.requestBody = signedJsonBody(
          "The exact GitHub webhook JSON bytes covered by X-Hub-Signature-256.",
        );
      }
      if (method === "post" && path === "/webhooks/inbound/{integrationId}") {
        addHeaderParameters(operation, [
          ["X-Facility-Timestamp", "Ten-digit Unix timestamp within five minutes of receipt."],
          ["X-Facility-Delivery", "Sender-unique delivery id, deduplicated per integration."],
          ["X-Facility-Event", "Application-defined event type."],
        ]);
        operation.requestBody = signedJsonBody(
          "The exact JSON bytes covered by X-Facility-Signature.",
        );
      }
      operation.responses = { ...standardErrors, ...(operation.responses ?? {}) };
      if (method === "get" && path === "/v1/runs/{runId}/transcript") {
        operation.responses["200"] = {
          description: "The complete durable run transcript as newline-delimited JSON.",
          content: {
            "application/x-ndjson": { schema: { type: "string" } },
          },
        };
      }
      if (method === "get" && path === "/v1/runs/{runId}/stream") {
        operation.responses["200"] = {
          description: "A resumable server-sent event stream of durable run events.",
          content: {
            "text/event-stream": { schema: { type: "string" } },
          },
        };
      }
    }
  }

  const components = document.components ?? {};
  document.components = components;
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
            code: { type: "string", description: "Stable machine-readable error code." },
            message: { type: "string", description: "Human-readable error summary." },
            details: { description: "Optional structured diagnostic context." },
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
      description: "Facility browser session cookie.",
    },
    runnerToken: {
      type: "http",
      scheme: "bearer",
      description: "Short-lived token issued to a Facility run sandbox.",
    },
    githubSignature: {
      type: "apiKey",
      in: "header",
      name: "x-hub-signature-256",
      description: "GitHub webhook HMAC signature.",
    },
    facilitySignature: {
      type: "apiKey",
      in: "header",
      name: "X-Facility-Signature",
      description:
        "sha256= HMAC-SHA256 over timestamp.deliveryId.eventType followed by the exact request body.",
    },
  };

  document.paths = paths;
  return document;
}

function addHeaderParameters(
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

function signedJsonBody(description: string) {
  return {
    required: true,
    description,
    content: {
      "application/json": {
        schema: { type: "object", additionalProperties: true },
      },
    },
  };
}

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(method: string, path: string) {
  const tokens = path
    .replace(/^\/v1\//, "/")
    .split("/")
    .filter(Boolean)
    .map((token) => (token.startsWith("{") ? `By${pascal(token.slice(1, -1))}` : pascal(token)));
  return `${method.toLowerCase()}${tokens.join("")}`;
}

function operationSummary(method: string, path: string) {
  const custom: Record<string, string> = {
    "get /health": "Check API and database health",
    "get /readyz": "Check API readiness",
    "get /auth/login": "Start browser authentication",
    "get /auth/callback": "Complete browser authentication",
    "post /auth/logout": "End the browser session",
    "post /webhooks/github": "Receive a GitHub App webhook",
    "post /webhooks/inbound/{integrationId}": "Receive a signed integration event",
    "get /v1/me": "Get the authenticated principal",
    "get /v1/inbox": "List approval gates and operational issues",
    "get /v1/audit/verify": "Verify the audit hash chain",
    "get /v1/runs/{runId}/stream": "Stream run events with resumable SSE",
    "get /v1/catalog": "Get the platform capability catalog",
    "get /v1/org": "Get organization settings",
    "get /v1/admin/doctor": "Check deployment readiness",
    "get /v1/github/installations": "List GitHub App installations",
    "get /v1/github/installations/{installationId}/repos":
      "List repositories visible to a GitHub App installation",
  };
  const exact = custom[`${method} ${path}`];
  if (exact) return exact;
  const action = actionVerb(path);
  if (action) return `${action} ${actionSubject(path)}`;
  const tokens = staticPathTokens(path);
  const last = tokens.at(-1) ?? "resource";
  const endsInParameter = /\{[^}]+\}$/.test(path);
  if (method === "get") {
    if (endsInParameter) return `Get ${singular(resourceLabel(last))}`;
    if (GET_QUALIFIERS.has(last)) {
      const parent = tokens.at(-2);
      return `Get ${parent ? `${singular(resourceLabel(parent))} ` : ""}${resourceLabel(last)}`;
    }
    return `List ${listSubject(tokens)}`;
  }
  if (method === "post") return `Create ${singular(resourceLabel(last))}`;
  if (method === "patch") return `Update ${singular(resourceLabel(last))}`;
  if (method === "put") return `Create or replace ${singular(resourceLabel(last))}`;
  if (method === "delete") return `Delete ${singular(resourceLabel(last))}`;
  return `${method.toUpperCase()} ${resourceLabel(last)}`;
}

function actionVerb(path: string) {
  const action = path.split("/").at(-1) ?? "";
  const verbs: Record<string, string> = {
    ack: "Acknowledge",
    adopt: "Adopt",
    cancel: "Cancel",
    checkpoint: "Checkpoint",
    decide: "Decide",
    deprecate: "Deprecate",
    execute: "Execute",
    kickstart: "Kickstart",
    interrupt: "Interrupt",
    propose: "Propose",
    publish: "Publish",
    resolve: "Resolve",
    resume: "Resume",
    retry: "Retry",
    "rotate-secret": "Rotate",
    sync: "Synchronize",
    steer: "Steer",
    transition: "Transition",
    trigger: "Trigger",
    upgrade: "Upgrade",
    validate: "Validate",
    verify: "Verify",
  };
  return verbs[action];
}

function staticPathTokens(path: string) {
  return path
    .replace(/^\/v1\//, "")
    .split("/")
    .filter((token) => token && !token.startsWith("{"));
}

function actionSubject(path: string) {
  const tokens = staticPathTokens(path);
  const action = tokens.pop() ?? "resource";
  const parent = tokens.at(-1) ?? "resource";
  if (action === "rotate-secret") return `${singular(resourceLabel(parent))} secret`;
  if (action === "sync") {
    return parent === "issues" ? "project issue cache" : singular(resourceLabel(parent));
  }
  return singular(resourceLabel(parent));
}

const GET_QUALIFIERS = new Set([
  "envelope",
  "health",
  "overview",
  "preview",
  "space",
  "status",
  "transcript",
]);

const CONTEXTUAL_LISTS = new Set([
  "agents",
  "conversations",
  "deliveries",
  "entries",
  "events",
  "issues",
  "items",
  "messages",
  "repos",
  "runs",
  "tasks",
  "versions",
]);

function listSubject(tokens: string[]) {
  const last = tokens.at(-1) ?? "resources";
  const parent = tokens.at(-2);
  if (parent && CONTEXTUAL_LISTS.has(last)) {
    return `${singular(resourceLabel(parent))} ${resourceLabel(last)}`;
  }
  return resourceLabel(last);
}

function resourceLabel(token: string) {
  const labels: Record<string, string> = {
    kb: "knowledge base",
    llmRequests: "LLM requests",
    "llm-requests": "LLM requests",
    repos: "repositories",
    mcp: "MCP",
  };
  return labels[token] ?? token.replaceAll("-", " ");
}

function singular(value: string) {
  const irregular: Record<string, string> = {
    analytics: "analytics",
    entries: "entry",
    issues: "issue",
    keys: "key",
    policies: "policy",
    repositories: "repository",
    status: "status",
  };
  if (irregular[value]) return irregular[value];
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function operationTag(path: string) {
  const matches: Array<[RegExp, string]> = [
    [/\/projects\/[^/]+\/issues(?:\/|$)/, "GitHub"],
    [/\/webhook-deliveries(?:\/|$)/, "Integrations"],
    [/\/action-types(?:\/|$)/, "Human approval"],
    [/\/mcp(?:\/|$)/, "Human approval"],
    [/\/virtual-keys(?:\/|$)/, "Providers and keys"],
    [/\/agents(?:\/|$)/, "Agents"],
    [/\/sandbox-profiles(?:\/|$)/, "Sandboxes"],
    [/\/kb(?:\/|$)/, "Knowledge base"],
    [/\/tasks(?:\/|$)/, "Tasks"],
    [/\/runs(?:\/|$)/, "Runs"],
    [/\/conversations(?:\/|$)/, "Conversations"],
    [/\/github(?:\/|$)/, "GitHub"],
    [/\/integrations(?:\/|$)/, "Integrations"],
    [/\/catalog(?:\/|$)/, "Catalog"],
    [/\/outcomes(?:\/|$)/, "Outcomes"],
    [/\/repos(?:\/|$)/, "Repositories"],
    [/\/projects(?:\/|$)/, "Projects"],
    [/\/(?:inbox|proposals)(?:\/|$)/, "Human approval"],
    [/\/registry(?:\/|$)/, "Registry"],
    [/\/(?:providers|virtual-keys)(?:\/|$)/, "Providers and keys"],
    [/\/(?:budgets|spend|llm-requests|analytics)(?:\/|$)/, "Cost and analytics"],
    [/\/(?:org|me|members|roles|keys)(?:\/|$)/, "Organization and access"],
    [/\/(?:audit|issues|admin|health)(?:\/|$)/, "Operations"],
    [/^\/readyz$/, "Operations"],
    [/^\/auth\//, "Authentication"],
    [/^\/webhooks\//, "Webhooks"],
  ];
  return matches.find(([pattern]) => pattern.test(path))?.[1] ?? "Facility";
}

function pascal(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}
