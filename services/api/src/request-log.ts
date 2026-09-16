// OAuth callbacks and preview launch URLs contain credentials. Access logs need
// the route, never the query string or browser headers.
export function safeRequestLog(request: { method?: string; url?: string }) {
  return { method: request.method, url: request.url?.split("?", 1)[0] };
}
