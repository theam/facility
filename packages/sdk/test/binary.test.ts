import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, expectTypeOf, it } from "vitest";
import spec from "../openapi.json" with { type: "json" };
import {
  type FacilityBinaryBody,
  FacilityClient,
  type FacilityGeneratedBody,
  type FacilityGeneratedResponse,
} from "../src/index.js";

const path =
  "/v1/projects/project-a/workspace-stories/story-a/input-files/infile_0123456789abcdef/content" as const;
const specPath =
  "/v1/projects/{projectId}/workspace-stories/{storyId}/input-files/{fileId}/content";
const bytes = Uint8Array.from([0, 255, 128, 1]);

describe("binary input file contracts", () => {
  it("publishes and types octet-stream request and response bodies", () => {
    const route = spec.paths[specPath];
    expect(route.put.requestBody).toMatchObject({
      required: true,
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    });
    expect(route.get.responses[200]).toMatchObject({
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    });
    expectTypeOf<FacilityGeneratedBody<"PUT", typeof path>>().toEqualTypeOf<FacilityBinaryBody>();
    expectTypeOf<FacilityGeneratedResponse<"GET", typeof path>>().toEqualTypeOf<ArrayBuffer>();
  });

  it("round-trips binary bytes over HTTP with the file capability header", async () => {
    const received: Array<{ method?: string; token?: string; type?: string; body: Buffer }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({
        method: req.method,
        token: String(req.headers["x-facility-file-token"] ?? ""),
        type: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      if (req.method === "PUT") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ file: { state: "available" } }));
      } else {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(bytes);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const client = new FacilityClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        maxRetries: 0,
      });
      await client.put(path, bytes, {
        headers: { "x-facility-file-token": "synthetic-file-capability" },
      });
      const result = await client.get(path);
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(result)).toEqual(bytes);
      expect(received[0]).toMatchObject({
        method: "PUT",
        token: "synthetic-file-capability",
        type: "application/octet-stream",
        body: Buffer.from(bytes),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    "arrayBuffer",
    "view",
    "blob",
  ])("sends %s as bytes, preserving the selected view", async (kind) => {
    let body: BodyInit | null | undefined;
    const source =
      kind === "arrayBuffer"
        ? bytes.buffer
        : kind === "blob"
          ? new Blob([bytes])
          : Uint8Array.from([9, ...bytes, 8]).subarray(1, 5);
    const client = new FacilityClient({
      baseUrl: "https://facility.example",
      fetch: async (_url, init) => {
        body = init?.body;
        return Response.json({ file: { state: "available" } });
      },
    });
    await client.request("PUT", path, {
      body: source,
      headers: { "x-facility-file-token": "synthetic" },
    });
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(bytes);
  });

  it.each([
    "network",
    "503",
  ])("never replays a single-use binary capability after %s failure", async (kind) => {
    let calls = 0;
    const client = new FacilityClient({
      baseUrl: "https://facility.example",
      retryBaseMs: 0,
      maxRetries: 2,
      fetch: async () => {
        calls++;
        if (kind === "network") throw new Error("synthetic connection loss");
        return Response.json({ error: { message: "synthetic failure" } }, { status: 503 });
      },
    });
    await expect(
      client.put(path, bytes, { idempotencyKey: "not-an-upload-replay-key" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
