import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../app/api/avatars/[...target]/route";
import { resetAvatarGate } from "../lib/avatar-gate";

// A local fake of the GitHub avatar surface and of this deployment's own
// control plane: deterministic bytes, no network access. The suite never
// needs live credentials or egress.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The one session token the fake control plane recognises. */
const VALID_SESSION = "sealed-session-for-user-1";

type CapturedRequest = { url: string; headers: Headers };
let upstreamRequests: CapturedRequest[] = [];

function startUpstream(listener: RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(listener);
    serversToClose.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

type UpstreamAnswer = {
  status: number;
  body?: Uint8Array;
  type?: string;
  headers?: Record<string, string>;
};

async function serveAvatar(
  respond: (request: CapturedRequest) => UpstreamAnswer,
): Promise<void> {
  const origin = await startUpstream((request, response) => {
    request.resume(); // Drain so 'end' fires; we only need headers.
    request.on("end", () => {
      const parsed = new URL(request.url ?? "/", origin);
      const upstreamUrl =
        parsed.pathname
          .replace(/^\/gh/, "https://github.com")
          .replace(/^\/avatars\/u\//, "https://avatars.githubusercontent.com/u/") +
        (parsed.search || "");
      const captured = {
        // The route's fixed upstream hosts are rewritten onto this local
        // fake; strip the rewrite so assertions read the real target.
        url: upstreamUrl,
        headers: new Headers(request.headers as Record<string, string>),
      };
      upstreamRequests.push(captured);
      const outcome = respond(captured);
      response.writeHead(outcome.status, {
        "content-type": outcome.type ?? "text/plain",
        ...(outcome.headers ?? {}),
      });
      response.end(outcome.body ?? null);
    });
  });
  // Point the module's fixed hosts at the local fake for this test only.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rewritten = String(input instanceof URL ? input : input)
      .replace("https://github.com", `${origin}/gh`)
      .replace("https://avatars.githubusercontent.com", `${origin}/avatars`);
    return originalFetch(new Request(rewritten, init));
  }) as typeof fetch;
  cleanup.push(() => {
    globalThis.fetch = originalFetch;
  });
}

/**
 * A stand-in for this deployment's control plane. It answers /v1/me for the
 * one session token above and 401s everything else, which is what decides
 * whether the route is allowed to reach an upstream at all.
 */
async function serveControlPlane(
  options: { valid?: string[]; status?: number } = {},
): Promise<{ requests: number }> {
  const valid = new Set(options.valid ?? [VALID_SESSION]);
  const counter = { requests: 0 };
  const origin = await startUpstream((request, response) => {
    request.resume();
    request.on("end", () => {
      counter.requests += 1;
      if (options.status && options.status >= 400) {
        response.writeHead(options.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const cookie = String(request.headers.cookie ?? "");
      const token = cookie.replace(/^.*facility_session=/, "").split(";")[0];
      if (request.url !== "/v1/me" || !valid.has(token ?? "")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ principal: { id: "user_1" }, org: null, permissions: [] }));
    });
  });
  const previous = process.env.FACILITY_API_URL;
  process.env.FACILITY_API_URL = origin;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.FACILITY_API_URL;
    else process.env.FACILITY_API_URL = previous;
  });
  return counter;
}

const cleanup: (() => Promise<void> | void)[] = [];
const serversToClose: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  upstreamRequests = [];
  resetAvatarGate();
  // Unwind in reverse so nested fetch overrides restore correctly.
  for (const undo of cleanup.splice(0).reverse()) await undo();
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // Undici keeps idle keep-alive sockets open; drop them so close resolves.
          server.closeIdleConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function routeGet(
  path: string,
  options: { env?: Record<string, string | undefined>; session?: string | null } = {},
): Promise<Response> {
  // The route reads the mode from process.env; swap it per call.
  const previous = process.env.NEXT_PUBLIC_FACILITY_AVATARS;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const session = options.session === undefined ? VALID_SESSION : options.session;
  const segments = path.split("/").filter(Boolean);
  return GET(
    new Request(`https://app.example/api/avatars/${path}`, {
      headers: session ? { cookie: `theme=dark; facility_session=${session}` } : {},
    }),
    { params: Promise.resolve({ target: segments }) },
  ).finally(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_FACILITY_AVATARS;
    else process.env.NEXT_PUBLIC_FACILITY_AVATARS = previous;
  });
}

describe("the /api/avatars proxy route", () => {
  it("forwards a valid login target as image bytes from this origin", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...PNG_BYTES]);
    expect(upstreamRequests).toHaveLength(1);
    const captured: CapturedRequest = upstreamRequests[0] ?? { url: "", headers: new Headers() };
    expect(captured.url).toBe("https://github.com/octocat.png?size=40");
    // Fresh outbound request: nothing about the deployment or viewer leaks.
    expect(captured.headers?.get("cookie")).toBeNull();
    expect(captured.headers?.get("authorization")).toBeNull();
    expect(captured.headers?.get("referer")).toBeNull();
  });

  it("serves numeric-ID targets from the avatars host", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("id/583231");
    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.url).toContain("https://avatars.githubusercontent.com/u/583231");
  });

  it("rejects any path that is not one of the two exact shapes", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    for (const hostile of [
      "u/../etc/passwd",
      "u/octocat/extra",
      "id/not-a-number",
      "u/-leading-hyphen",
      "other/octocat",
      "",
    ]) {
      const response = await routeGet(hostile);
      expect(response.status).toBe(404);
    }
    expect(upstreamRequests).toHaveLength(0);
  });

  it("fails closed to 404 when the upstream answer is not an image", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, type: "text/html", body: new Uint8Array([60]) }));
    expect((await routeGet("u/octocat")).status).toBe(404);

    await serveAvatar(() => ({ status: 404 }));
    expect((await routeGet("u/someone-else")).status).toBe(404);
  });

  it("fails closed to 404 when the upstream is unreachable", async () => {
    await serveControlPlane();
    const controlPlaneUrl = process.env.FACILITY_API_URL ?? "";
    // Every call but the control-plane check fails outright.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof URL ? input : input);
      if (url.startsWith(controlPlaneUrl)) return originalFetch(input as RequestInfo, init);
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as typeof fetch;
    cleanup.push(() => {
      globalThis.fetch = originalFetch;
    });
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).not.toBe("max-age=86400");
  });

  it("serves nothing but 404 when the avatar mode is off", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat", { env: { NEXT_PUBLIC_FACILITY_AVATARS: "off" } });
    expect(response.status).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("marks successful responses as cacheable but private", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("who may make the route fetch from GitHub", () => {
  it("refuses a request with no session and never reaches the upstream", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat", { session: null });
    expect(response.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("refuses a session the control plane does not recognise", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat", { session: "forged-or-expired" });
    expect(response.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("refuses every target while unauthenticated, however many are tried", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    for (let i = 0; i < 25; i += 1) {
      const response = await routeGet(`u/probe${i}`, { session: null });
      expect(response.status).toBe(401);
    }
    expect(upstreamRequests).toHaveLength(0);
  });

  it("does not re-ask the control plane about a token it has already judged", async () => {
    const controlPlane = await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    for (const login of ["octocat", "hubot", "mona"]) await routeGet(`u/${login}`);
    expect(controlPlane.requests).toBe(1);
    expect(upstreamRequests).toHaveLength(3);
  });

  it("denies the request when the control plane cannot answer", async () => {
    await serveControlPlane({ status: 503 });
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });
});

describe("bounding how much GitHub traffic a viewer can cause", () => {
  it("serves a repeated target from the server-side cache, fetching once", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    for (let i = 0; i < 10; i += 1) {
      const response = await routeGet("u/octocat");
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PNG_BYTES]);
    }
    expect(upstreamRequests).toHaveLength(1);
  });

  it("remembers an upstream miss instead of refetching it on every paint", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 404 }));
    for (let i = 0; i < 10; i += 1) {
      expect((await routeGet("u/ghost")).status).toBe(404);
    }
    expect(upstreamRequests).toHaveLength(1);
  });

  it("caps a viewer cycling fresh logins, and stops fetching once capped", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const statuses: number[] = [];
    for (let i = 0; i < 90; i += 1) {
      statuses.push((await routeGet(`u/probe${i}`)).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // The allowance, not the request count, decides how much egress happens.
    expect(upstreamRequests.length).toBeLessThan(90);
    expect(upstreamRequests.length).toBe(statuses.filter((status) => status === 200).length);
  });
});

describe("following an upstream redirect", () => {
  it("follows a hop that stays on a permitted GitHub host", async () => {
    await serveControlPlane();
    await serveAvatar((request) =>
      request.url.startsWith("https://github.com/")
        ? {
            status: 302,
            headers: { location: "https://avatars.githubusercontent.com/u/583231?v=4" },
          }
        : { status: 200, body: PNG_BYTES, type: "image/png" },
    );
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PNG_BYTES]);
    expect(upstreamRequests.map((r) => r.url)).toEqual([
      "https://github.com/octocat.png?size=40",
      "https://avatars.githubusercontent.com/u/583231?v=4",
    ]);
  });

  it("refuses a hop to a host outside GitHub and never requests it", async () => {
    await serveControlPlane();
    let elsewhereRequests = 0;
    const elsewhere = await startUpstream((request, response) => {
      request.resume();
      elsewhereRequests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    });
    await serveAvatar(() => ({ status: 302, headers: { location: `${elsewhere}/evil.png` } }));

    const response = await routeGet("u/octocat");
    expect(response.status).toBe(404);
    expect(elsewhereRequests).toBe(0);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("refuses an off-host hop however the Location is written", async () => {
    for (const location of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "http://github.com/octocat.png",
      "https://github.com.evil.example/x.png",
    ]) {
      await serveControlPlane();
      await serveAvatar(() => ({ status: 302, headers: { location } }));
      const response = await routeGet("u/octocat");
      expect(response.status, location).toBe(404);
      expect(upstreamRequests, location).toHaveLength(1);

      upstreamRequests = [];
      resetAvatarGate();
      for (const undo of cleanup.splice(0).reverse()) await undo();
    }
  });

  it("cuts off an upstream that redirects without end", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({
      status: 302,
      headers: { location: "https://avatars.githubusercontent.com/u/1?v=4" },
    }));
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(404);
    // One initial request plus a fixed number of hops — never the upstream's choice.
    expect(upstreamRequests.length).toBeLessThanOrEqual(4);
    expect(upstreamRequests.length).toBeGreaterThan(1);
  });

  it("treats a redirect with no Location as a failure", async () => {
    await serveControlPlane();
    await serveAvatar(() => ({ status: 302 }));
    expect((await routeGet("u/octocat")).status).toBe(404);
    expect(upstreamRequests).toHaveLength(1);
  });
});
