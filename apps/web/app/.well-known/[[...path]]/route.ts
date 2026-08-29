import { proxyApiRequest } from "@/lib/api-proxy";

export const dynamic = "force-dynamic";

const handler = (request: Request) =>
  proxyApiRequest(request, { publicPathPrefix: "/.well-known" });

export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
