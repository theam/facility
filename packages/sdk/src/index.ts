import type {
  FacilityGeneratedQuery,
  FacilityRouteBody,
  FacilityRouteMethod,
  FacilityRoutePath,
  FacilityRouteResponse,
  Me,
  PageQuery,
  Project,
  QueryParams,
} from "./contracts.js";

export type * from "./contracts.js";
export { FACILITY_V1_ROUTES, type FacilityV1Route } from "./routes.js";
export type {
  components as FacilityOpenApiComponents,
  paths as FacilityOpenApiPaths,
} from "./schema.js";

type RequestOptions<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>> = {
  body?: FacilityRouteBody<Method, Path>;
  query?: FacilityGeneratedQuery<Method, Path>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  responseType?: "json" | "text";
  headers?: Record<string, string>;
};

export type FacilityClientOptions = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
};

export type FacilityWriteOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export class FacilityApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = "FacilityApiError";
  }
}

export class FacilityClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Headers;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: FacilityClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.headers = new Headers(options.headers);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs, 30_000, "timeoutMs");
    this.maxRetries = nonNegativeInteger(options.maxRetries, 2, "maxRetries");
    this.retryBaseMs = nonNegativeInteger(options.retryBaseMs, 250, "retryBaseMs");
  }

  request<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>>(
    method: Method,
    path: Path,
    options: RequestOptions<Method, Path> = {},
  ): Promise<FacilityRouteResponse<Method, Path>> {
    return this.send(method, path, options);
  }

  get<Path extends FacilityRoutePath<"GET">>(
    path: Path,
    query?: FacilityGeneratedQuery<"GET", Path>,
    options: { signal?: AbortSignal; responseType?: "json" | "text" } = {},
  ) {
    return this.send("GET", path, { query, ...options });
  }

  post<Path extends FacilityRoutePath<"POST">>(
    path: Path,
    body?: FacilityRouteBody<"POST", Path>,
    options: FacilityWriteOptions = {},
  ) {
    return this.send("POST", path, { body, ...options });
  }

  put<Path extends FacilityRoutePath<"PUT">>(
    path: Path,
    body: FacilityRouteBody<"PUT", Path>,
    options: FacilityWriteOptions = {},
  ) {
    return this.send("PUT", path, { body, ...options });
  }

  patch<Path extends FacilityRoutePath<"PATCH">>(
    path: Path,
    body: FacilityRouteBody<"PATCH", Path>,
    options: FacilityWriteOptions = {},
  ) {
    return this.send("PATCH", path, { body, ...options });
  }

  delete<Path extends FacilityRoutePath<"DELETE">>(
    path: Path,
    body?: FacilityRouteBody<"DELETE", Path>,
    options: FacilityWriteOptions = {},
  ) {
    return this.send("DELETE", path, { body, ...options });
  }

  me(): Promise<Me> {
    return this.get("/v1/me");
  }

  projects(query?: PageQuery): Promise<Project[]> {
    return this.get("/v1/projects", query);
  }

  project(projectId: string): Promise<Project> {
    return this.get(`/v1/projects/${encodeURIComponent(projectId)}`);
  }

  private async send<Method extends FacilityRouteMethod, Path extends FacilityRoutePath<Method>>(
    method: Method,
    path: Path,
    options: RequestOptions<Method, Path>,
  ): Promise<FacilityRouteResponse<Method, Path>> {
    const hasBody = options.body !== undefined;
    const binary = rawBinaryBody(options.body);
    const headers = new Headers(this.headers);
    new Headers(options.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    headers.set(
      "accept",
      options.responseType === "text" ? "text/plain" : "application/json, application/octet-stream",
    );
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    if (hasBody)
      headers.set(
        "content-type",
        binary === undefined ? "application/json" : "application/octet-stream",
      );
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

    let attempt = 0;
    while (true) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path, options.query as QueryParams | undefined), {
          method,
          headers,
          credentials: "include",
          signal,
          body: binary ?? (hasBody ? JSON.stringify(options.body) : undefined),
        });
      } catch (error) {
        if (
          binary === undefined &&
          attempt < this.maxRetries &&
          retryable(method, options.idempotencyKey)
        ) {
          await delay(this.retryBaseMs * 2 ** attempt, options.signal);
          attempt += 1;
          continue;
        }
        throw error;
      }

      if (
        [429, 502, 503, 504].includes(response.status) &&
        attempt < this.maxRetries &&
        binary === undefined &&
        retryable(method, options.idempotencyKey)
      ) {
        await delay(retryDelay(response, this.retryBaseMs * 2 ** attempt), options.signal);
        attempt += 1;
        continue;
      }
      if (!response.ok) throw await apiError(response);
      if (response.status === 204) return undefined as FacilityRouteResponse<Method, Path>;
      if (options.responseType === "text") {
        return (await response.text()) as FacilityRouteResponse<Method, Path>;
      }
      if (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
        "application/octet-stream"
      )
        return (await response.arrayBuffer()) as FacilityRouteResponse<Method, Path>;
      return (await response.json()) as FacilityRouteResponse<Method, Path>;
    }
  }

  private url(path: string, query?: QueryParams) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function rawBinaryBody(value: unknown): Blob | ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer || (typeof Blob !== "undefined" && value instanceof Blob))
    return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  return undefined;
}

function retryable(method: FacilityRouteMethod, idempotencyKey?: string) {
  return method === "GET" || Boolean(idempotencyKey);
}

function retryDelay(response: Response, fallback: number) {
  const value = response.headers.get("retry-after");
  if (value && /^\d+$/.test(value)) return Math.min(Number(value) * 1_000, 30_000);
  return fallback;
}

async function apiError(response: Response) {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | undefined;
  return new FacilityApiError(
    payload?.error?.message ?? `Facility API request failed (${response.status})`,
    response.status,
    payload?.error?.code,
    payload?.error?.details,
    payload,
  );
}

function delay(ms: number, signal?: AbortSignal) {
  if (ms === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return resolved;
}
