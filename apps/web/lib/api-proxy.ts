const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const UNTRUSTED_FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

type ApiProxyOptions = {
  apiUrl?: string;
  nodeEnv?: string;
  fetchImpl?: typeof fetch;
  publicPathPrefix?: "/api" | "/oauth" | "/.well-known";
};

export function apiTargetUrl(requestUrl: string, apiUrl: string, publicPathPrefix = "/api") {
  let request: URL;
  let base: URL;
  try {
    request = new URL(requestUrl);
    base = new URL(apiUrl);
  } catch {
    throw new Error("facility_api_proxy_url_invalid");
  }
  if (
    !new Set(["http:", "https:"]).has(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error("facility_api_proxy_url_invalid");
  }
  if (
    request.pathname !== publicPathPrefix &&
    !request.pathname.startsWith(`${publicPathPrefix}/`)
  ) {
    throw new Error("facility_api_proxy_path_invalid");
  }

  const target = new URL(base);
  target.pathname =
    publicPathPrefix === "/api"
      ? request.pathname.slice(publicPathPrefix.length) || "/"
      : request.pathname;
  target.search = request.search;
  return target;
}

export function apiProxyRequestHeaders(input: Headers) {
  const headers = new Headers(input);
  const connectionTokens = (headers.get("connection") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) {
    if (HEADER_NAME.test(name)) headers.delete(name);
  }
  headers.delete("host");
  headers.delete("content-length");
  for (const name of UNTRUSTED_FORWARDING_HEADERS) headers.delete(name);
  // Undici transparently decompresses upstream responses. Ask for identity so
  // the forwarded content-encoding header can never describe different bytes;
  // production compression belongs at the edge in front of this service.
  headers.set("accept-encoding", "identity");
  return headers;
}

export async function proxyApiRequest(request: Request, options: ApiProxyOptions = {}) {
  const configuredApiUrl = options.apiUrl ?? process.env.FACILITY_API_URL;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const apiUrl =
    configuredApiUrl || (nodeEnv === "production" ? undefined : "http://localhost:4400");
  if (!apiUrl) return proxyError(503, "api_proxy_not_configured");

  let target: URL;
  try {
    target = apiTargetUrl(request.url, apiUrl, options.publicPathPrefix);
  } catch {
    return proxyError(503, "api_proxy_not_configured");
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: apiProxyRequestHeaders(request.headers),
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    // Node's fetch requires half-duplex when the body is a ReadableStream.
    init.duplex = "half";
  }

  try {
    return await (options.fetchImpl ?? fetch)(target, init);
  } catch {
    return proxyError(502, "api_proxy_unavailable");
  }
}

function proxyError(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
