import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createObjectStore,
  type ObjectStoreFetch,
  resolveObjectStoreCredentials,
  signS3Request,
} from "../src/object-store.js";

type CapturedRequest = {
  url: string;
  init?: Parameters<ObjectStoreFetch>[1];
};

const originalEnv = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  AWS_REGION: process.env.AWS_REGION,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  AWS_CONTAINER_AUTHORIZATION_TOKEN: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN,
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("object store", () => {
  it("does not combine explicit S3 credentials with an ambient AWS session token", async () => {
    process.env.AWS_SESSION_TOKEN = "expired-aws-session-token";

    await expect(
      resolveObjectStoreCredentials({
        s3Bucket: "facility-test",
        s3Endpoint: "http://127.0.0.1:9000",
        s3AccessKey: "minio-access",
        s3SecretKey: "minio-secret",
        awsRegion: "us-east-1",
      }),
    ).resolves.toEqual({
      accessKeyId: "minio-access",
      secretAccessKey: "minio-secret",
    });
  });

  it("creates deterministic SigV4 headers with the expected structure", () => {
    const body = Buffer.from("fixed body");
    const headers = signS3Request({
      method: "PUT",
      host: "s3.us-east-1.amazonaws.com",
      path: "/examplebucket/envelopes/org/2025-01/req.json.gz",
      region: "us-east-1",
      body,
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      now: new Date("2025-01-01T00:00:00Z"),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });

    const authorization = headers.authorization ?? "";
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20250101/us-east-1/s3/aws4_request",
    );
    expect(authorization).toContain(
      "SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    expect(headers["x-amz-date"]).toBe("20250101T000000Z");
    expect(authorization).toContain(
      "Signature=450e6ab53754973ba637491d32f229181b1979b8a10fbdf3a71b3475efe0b040",
    );
  });

  it("signs endpoint requests with SigV4 and never Basic auth", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl: ObjectStoreFetch = async (url, init) => {
      captured.push({ url, init });
      return response(200);
    };
    const store = createObjectStore(
      {
        s3Bucket: "facility-test",
        s3Endpoint: "http://127.0.0.1:9000",
        s3AccessKey: "access",
        s3SecretKey: "secret",
        awsRegion: "us-east-1",
      },
      { fetch: fetchImpl, now: () => new Date("2025-01-01T00:00:00Z") },
    );

    await store.putObject({
      orgId: "org",
      requestId: "req",
      payload: { ok: true },
      now: new Date("2025-01-01T00:00:00Z"),
    });

    const headers = captured[0]?.init?.headers ?? {};
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(Object.values(headers).join("\n")).not.toContain("Basic ");
  });

  it("uses ECS container credentials when static credentials are absent", async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/task";

    const captured: CapturedRequest[] = [];
    const fetchImpl: ObjectStoreFetch = async (url, init) => {
      if (url === "http://169.254.170.2/v2/credentials/task") {
        return response(
          200,
          Buffer.from(
            JSON.stringify({
              AccessKeyId: "ASIACONTAINER",
              SecretAccessKey: "container-secret",
              Token: "session-token",
            }),
          ),
        );
      }
      captured.push({ url, init });
      return response(200);
    };
    const store = createObjectStore(
      {
        s3Bucket: "facility-test",
        s3Endpoint: "http://127.0.0.1:9000",
        awsRegion: "us-east-1",
      },
      { fetch: fetchImpl, now: () => new Date("2025-01-01T00:00:00Z") },
    );

    await store.putObject({
      orgId: "org",
      requestId: "req",
      payload: { ok: true },
      now: new Date("2025-01-01T00:00:00Z"),
    });

    const headers = captured[0]?.init?.headers ?? {};
    expect(headers.authorization).toContain("Credential=ASIACONTAINER/");
    expect(headers["x-amz-security-token"]).toBe("session-token");
  });

  it("round trips gzipped JSON envelopes", async () => {
    const objects = new Map<string, Buffer>();
    const fetchImpl: ObjectStoreFetch = async (url, init) => {
      if (init?.method === "PUT" && init.body) {
        objects.set(url, init.body);
        return response(200);
      }
      const body = objects.get(url);
      if (init?.method === "GET" && body) {
        return response(200, body, { "content-encoding": "gzip" });
      }
      return response(404);
    };
    const store = createObjectStore(
      {
        s3Bucket: "facility-test",
        s3Endpoint: "http://127.0.0.1:9000",
        s3AccessKey: "access",
        s3SecretKey: "secret",
        awsRegion: "us-east-1",
      },
      { fetch: fetchImpl, now: () => new Date("2025-01-01T00:00:00Z") },
    );

    const payload = { request: { body: { model: "gpt-5.5" } }, response: { id: "resp_1" } };
    const roundTrip = await store.verifyRoundTrip({
      orgId: "org",
      requestId: "req",
      payload,
      now: new Date("2025-01-01T00:00:00Z"),
    });

    expect(roundTrip.uri).toBe("s3://facility-test/envelopes/org/2025-01/req.json.gz");
    expect(roundTrip.loaded).toEqual(payload);
    const stored = [...objects.values()][0];
    expect(stored ? JSON.parse(gunzipSync(stored).toString("utf8")) : null).toEqual(payload);
  });
});

function response(
  status: number,
  body: Buffer<ArrayBufferLike> = Buffer.from(""),
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    arrayBuffer: async () => Uint8Array.from(body).buffer,
    json: async () => JSON.parse(body.toString("utf8")),
  };
}
