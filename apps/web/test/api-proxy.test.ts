import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { apiProxyRequestHeaders, apiTargetUrl, proxyApiRequest } from "../lib/api-proxy";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("runtime API proxy policy", () => {
  it("maps only the same-origin /api surface to a fixed HTTP(S) API origin", () => {
    expect(
      apiTargetUrl("https://app.example/api/v1/runs?limit=10", "https://api.example").toString(),
    ).toBe("https://api.example/v1/runs?limit=10");
    expect(() => apiTargetUrl("https://app.example/admin", "https://api.example")).toThrow(
      "facility_api_proxy_path_invalid",
    );
    for (const apiUrl of [
      "file:///tmp/socket",
      "https://user:secret@api.example",
      "https://api.example/base",
      "https://api.example?target=other",
      "not a URL",
    ]) {
      expect(() => apiTargetUrl("https://app.example/api/v1/runs", apiUrl)).toThrow(
        "facility_api_proxy_url_invalid",
      );
    }
  });

  it("keeps OAuth and authorization metadata on the browser's web origin", () => {
    expect(
      apiTargetUrl(
        "https://app.example/oauth/authorize?client_id=codex",
        "https://api.example",
        "/oauth",
      ).toString(),
    ).toBe("https://api.example/oauth/authorize?client_id=codex");
    expect(
      apiTargetUrl(
        "https://app.example/.well-known/oauth-authorization-server",
        "https://api.example",
        "/.well-known",
      ).toString(),
    ).toBe("https://api.example/.well-known/oauth-authorization-server");
    expect(() =>
      apiTargetUrl("https://app.example/v1/me", "https://api.example", "/oauth"),
    ).toThrow("facility_api_proxy_path_invalid");
  });

  it("preserves application headers but strips hop-by-hop and spoofed forwarding headers", () => {
    const headers = apiProxyRequestHeaders(
      new Headers({
        authorization: "Bearer token",
        cookie: "facility_session=signed",
        connection: "keep-alive, x-remove-me",
        "x-remove-me": "secret",
        host: "evil.example",
        "content-length": "99",
        "x-forwarded-for": "127.0.0.1",
      }),
    );
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("cookie")).toBe("facility_session=signed");
    expect(headers.get("accept-encoding")).toBe("identity");
    for (const name of ["connection", "x-remove-me", "host", "content-length", "x-forwarded-for"]) {
      expect(headers.has(name)).toBe(false);
    }
  });

  it("fails closed when production runtime configuration is missing or invalid", async () => {
    const request = new Request("https://app.example/api/v1/runs");
    const missing = await proxyApiRequest(request, { apiUrl: "", nodeEnv: "production" });
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({ error: "api_proxy_not_configured" });

    const invalid = await proxyApiRequest(request, {
      apiUrl: "https://user:secret@api.example",
      nodeEnv: "production",
    });
    expect(invalid.status).toBe(503);
  });

  it("returns a sanitized error when the configured API is unavailable", async () => {
    const request = new Request("https://app.example/api/v1/runs");
    const result = await proxyApiRequest(request, {
      apiUrl: "https://api.example",
      nodeEnv: "production",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4400");
      },
    });
    expect(result.status).toBe(502);
    expect(result.headers.get("cache-control")).toBe("no-store");
    await expect(result.json()).resolves.toEqual({ error: "api_proxy_unavailable" });
  });
});

describe("runtime API proxy integration", () => {
  it("streams request and response bodies while preserving auth, cookies, status, and set-cookie", async () => {
    const { origin } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        expect(request.url).toBe("/v1/echo?mode=stream");
        expect(request.headers.authorization).toBe("Bearer runtime-token");
        expect(request.headers.cookie).toBe("facility_session=signed");
        expect(request.headers.host).toBe(new URL(origin).host);
        expect(request.headers["x-forwarded-for"]).toBeUndefined();
        expect(Buffer.concat(chunks).toString("utf8")).toBe("first-second");
        response.writeHead(207, {
          "content-type": "text/plain",
          "set-cookie": ["a=1; HttpOnly", "b=2; Secure"],
          "x-facility-upstream": "api",
        });
        response.write("response-");
        response.end("stream");
      });
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first-"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    });
    const request = new Request("https://app.example/api/v1/echo?mode=stream", {
      method: "POST",
      headers: {
        authorization: "Bearer runtime-token",
        cookie: "facility_session=signed",
        "content-type": "text/plain",
        "x-forwarded-for": "203.0.113.10",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await proxyApiRequest(request, { apiUrl: origin, nodeEnv: "production" });
    expect(result.status).toBe(207);
    expect(result.headers.get("x-facility-upstream")).toBe("api");
    expect(result.headers.getSetCookie()).toEqual(["a=1; HttpOnly", "b=2; Secure"]);
    await expect(result.text()).resolves.toBe("response-stream");
  });

  it("returns upstream redirects without following them", async () => {
    let requests = 0;
    const { origin } = await listen((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/should-not-be-followed" });
      response.end();
    });
    const result = await proxyApiRequest(new Request("https://app.example/api/auth/callback"), {
      apiUrl: origin,
      nodeEnv: "production",
    });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/should-not-be-followed");
    expect(requests).toBe(1);
  });

  it("preserves a host-only interaction cookie across two web-origin OAuth proxy hops", async () => {
    let hop = 0;
    const { origin } = await listen((request, response) => {
      hop += 1;
      if (hop === 1) {
        expect(request.url).toBe("/oauth/authorize?client_id=codex");
        expect(request.headers.cookie).toBeUndefined();
        response.writeHead(303, {
          location: "https://app.example/oauth/interaction/interaction_1",
          "set-cookie":
            "_interaction=sealed; Path=/oauth/interaction/interaction_1; HttpOnly; Secure",
        });
        response.end();
        return;
      }
      expect(request.url).toBe("/oauth/interaction/interaction_1");
      expect(request.headers.cookie).toBe("_interaction=sealed");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("interaction resumed");
    });
    const authorization = await proxyApiRequest(
      new Request("https://app.example/oauth/authorize?client_id=codex"),
      {
        apiUrl: origin,
        nodeEnv: "production",
        publicPathPrefix: "/oauth",
      },
    );
    expect(authorization.status).toBe(303);
    expect(authorization.headers.get("location")).toBe(
      "https://app.example/oauth/interaction/interaction_1",
    );
    expect(authorization.headers.getSetCookie()).toEqual([
      "_interaction=sealed; Path=/oauth/interaction/interaction_1; HttpOnly; Secure",
    ]);
    const cookie = authorization.headers.getSetCookie()[0]?.split(";", 1)[0];
    if (!cookie) throw new Error("OAuth proxy response omitted its interaction cookie");

    const interaction = await proxyApiRequest(
      new Request("https://app.example/oauth/interaction/interaction_1", {
        headers: { cookie },
      }),
      {
        apiUrl: origin,
        nodeEnv: "production",
        publicPathPrefix: "/oauth",
      },
    );
    expect(interaction.status).toBe(200);
    await expect(interaction.text()).resolves.toBe("interaction resumed");
    expect(hop).toBe(2);
  });

  it("delivers an event-stream chunk before the upstream response completes", async () => {
    let releaseSecondChunk = () => {};
    let secondChunkSent = false;
    const secondChunkAllowed = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const { origin } = await listen((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write("data: first\n\n");
      void secondChunkAllowed.then(() => {
        secondChunkSent = true;
        response.end("data: second\n\n");
      });
    });
    const fallback = setTimeout(releaseSecondChunk, 2_000);

    try {
      const result = await proxyApiRequest(
        new Request("https://app.example/api/v1/runs/1/stream"),
        {
          apiUrl: origin,
          nodeEnv: "production",
        },
      );
      const reader = result.body?.getReader();
      if (!reader) throw new Error("proxied event stream has no response body");

      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
      expect(secondChunkSent).toBe(false);

      releaseSecondChunk();
      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      clearTimeout(fallback);
      releaseSecondChunk();
    }
  });
});

async function listen(handler: RequestListener): Promise<{ origin: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return { origin: `http://127.0.0.1:${address.port}` };
}
