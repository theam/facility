import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const EMPTY_SHA256 = sha256Hex("");

export type ObjectStoreConfig = {
  s3Bucket?: string;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  awsRegion?: string;
};

export type ObjectStoreFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  },
) => Promise<ObjectStoreResponse>;

export type ObjectStoreResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
};

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type ObjectStore = {
  putObject: (input: {
    orgId: string;
    requestId: string;
    payload: unknown;
    now?: Date;
  }) => Promise<string>;
  // `expectedKeyPrefix` binds the read to a known key namespace (e.g. one org's
  // envelope prefix): if the stored URI's key does not start with it, the read
  // fails as not-found instead of trusting the URI alone.
  getObject: (uri: string, options?: { expectedKeyPrefix?: string }) => Promise<unknown>;
  putBytes: (input: {
    key: string;
    body: Buffer;
    contentType: string;
    now?: Date;
  }) => Promise<string>;
  getBytes: (uri: string, options?: { expectedKeyPrefix?: string }) => Promise<Buffer>;
  verifyRoundTrip: (input: {
    orgId: string;
    requestId: string;
    payload: unknown;
    now?: Date;
  }) => Promise<{ uri: string; loaded: unknown }>;
};

type S3Ref = {
  bucket: string;
  key: string;
};

type ObjectStoreOptions = {
  fetch?: ObjectStoreFetch;
  now?: () => Date;
};

export class ObjectStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreConfigurationError";
  }
}

export class ObjectStoreNotFoundError extends Error {
  constructor(message = "Envelope not found") {
    super(message);
    this.name = "ObjectStoreNotFoundError";
  }
}

export class ObjectStoreHttpError extends Error {
  readonly status: number;

  constructor(status: number, message = `Envelope store returned ${status}`) {
    super(message);
    this.name = "ObjectStoreHttpError";
    this.status = status;
  }
}

export function createObjectStore(
  config: ObjectStoreConfig,
  options: ObjectStoreOptions = {},
): ObjectStore {
  const fetchImpl = options.fetch ?? globalFetch;
  const clock = options.now ?? (() => new Date());

  async function getBytesWithRef(uri: string, options?: { expectedKeyPrefix?: string }) {
    const bucket = requiredBucket(config);
    const ref = parseConfiguredS3Uri(uri, bucket);
    if (options?.expectedKeyPrefix && !ref.key.startsWith(options.expectedKeyPrefix)) {
      // The URI is well-formed for this bucket but points outside the caller's
      // key namespace — treat as not-found rather than reading another tenant.
      throw new ObjectStoreNotFoundError();
    }
    const response = await signedFetch({
      config,
      fetchImpl,
      method: "GET",
      bucket: ref.bucket,
      key: ref.key,
      now: clock(),
    });
    if (response.status === 404) throw new ObjectStoreNotFoundError();
    if (!response.ok) throw new ObjectStoreHttpError(response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { ref, buffer, contentEncoding: response.headers.get("content-encoding") };
  }

  const store: ObjectStore = {
    putObject: async ({ orgId, requestId, payload, now }) => {
      const bucket = requiredBucket(config);
      const key = envelopeKey(orgId, now ?? clock(), requestId);
      const body = await gzipAsync(Buffer.from(JSON.stringify(payload)));
      const response = await signedFetch({
        config,
        fetchImpl,
        method: "PUT",
        bucket,
        key,
        body,
        now: now ?? clock(),
        contentType: "application/json",
        contentEncoding: "gzip",
      });
      if (!response.ok) {
        throw new ObjectStoreHttpError(response.status);
      }
      return envelopeUri(bucket, key);
    },
    getObject: async (uri, options) => {
      const { ref, buffer, contentEncoding } = await getBytesWithRef(uri, options);
      const body =
        contentEncoding === "gzip" || ref.key.endsWith(".gz") ? await maybeGunzip(buffer) : buffer;
      return JSON.parse(body.toString("utf8")) as unknown;
    },
    putBytes: async ({ key, body, contentType, now }) => {
      const bucket = requiredBucket(config);
      const response = await signedFetch({
        config,
        fetchImpl,
        method: "PUT",
        bucket,
        key,
        body,
        now: now ?? clock(),
        contentType,
      });
      if (!response.ok) {
        throw new ObjectStoreHttpError(response.status);
      }
      return envelopeUri(bucket, key);
    },
    getBytes: async (uri, options) => {
      const { buffer } = await getBytesWithRef(uri, options);
      return buffer;
    },
    verifyRoundTrip: async (input) => {
      const uri = await store.putObject(input);
      const loaded = await store.getObject(uri);
      return { uri, loaded };
    },
  };
  return store;
}

export function envelopeKey(orgId: string, now: Date, requestId: string): string {
  const yyyyMm = now.toISOString().slice(0, 7);
  return `envelopes/${orgId}/${yyyyMm}/${requestId}.json.gz`;
}

export function envelopeUri(bucket: string, key: string) {
  return `s3://${bucket}/${key}`;
}

export async function resolveObjectStoreCredentials(
  config: ObjectStoreConfig,
  fetchImpl: ObjectStoreFetch = globalFetch,
): Promise<AwsCredentials> {
  const configAccessKey = config.s3AccessKey;
  const configSecretKey = config.s3SecretKey;
  if (configAccessKey && configSecretKey) {
    return {
      accessKeyId: configAccessKey,
      secretAccessKey: configSecretKey,
    };
  }

  const envAccessKey = process.env.AWS_ACCESS_KEY_ID;
  const envSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (envAccessKey && envSecretKey) {
    return {
      accessKeyId: envAccessKey,
      secretAccessKey: envSecretKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }

  const relativeUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const credentialsUrl = fullUri ?? (relativeUri ? `http://169.254.170.2${relativeUri}` : null);
  if (!credentialsUrl) {
    throw new ObjectStoreConfigurationError("AWS credentials are required for S3 envelope storage");
  }

  const headers: Record<string, string> = {};
  const tokenFile = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  if (tokenFile) {
    headers.authorization = (await readFile(tokenFile, "utf8")).trim();
  } else if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) {
    headers.authorization = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  }

  const response = await fetchImpl(credentialsUrl, { headers });
  if (!response.ok) {
    throw new ObjectStoreConfigurationError(`AWS credential lookup failed with ${response.status}`);
  }
  const payload = (await response.json()) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
  };
  if (!payload.AccessKeyId || !payload.SecretAccessKey) {
    throw new ObjectStoreConfigurationError(
      "AWS credential lookup returned incomplete credentials",
    );
  }
  return {
    accessKeyId: payload.AccessKeyId,
    secretAccessKey: payload.SecretAccessKey,
    sessionToken: payload.Token,
  };
}

export function signS3Request(input: {
  method: string;
  host: string;
  path: string;
  region: string;
  body?: Buffer;
  credentials: AwsCredentials;
  now: Date;
  headers?: Record<string, string>;
}) {
  const iso = input.now.toISOString();
  const dateStamp = iso.slice(0, 10).replaceAll("-", "");
  const amzDate = `${dateStamp}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
  const payloadHash = input.body ? sha256Hex(input.body) : EMPTY_SHA256;
  const headers = lowerCaseHeaders({
    ...(input.headers ?? {}),
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((header) => `${header}:${headers[header]?.trim()}`)
    .join("\n");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    signingKey(input.credentials.secretAccessKey, dateStamp, input.region),
    stringToSign,
  );
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  return headers;
}

async function signedFetch(input: {
  config: ObjectStoreConfig;
  fetchImpl: ObjectStoreFetch;
  method: "GET" | "PUT";
  bucket: string;
  key: string;
  body?: Buffer;
  now: Date;
  contentType?: string;
  contentEncoding?: string;
}) {
  const region = input.config.awsRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new ObjectStoreConfigurationError("AWS_REGION is required for S3 envelope storage");
  }
  const credentials = await resolveObjectStoreCredentials(input.config, input.fetchImpl);
  const target = objectTarget(input.config, input.bucket, input.key, region);
  const requestHeaders =
    input.method === "PUT"
      ? {
          ...(input.contentType ? { "content-type": input.contentType } : {}),
          ...(input.contentEncoding ? { "content-encoding": input.contentEncoding } : {}),
        }
      : undefined;
  const headers = signS3Request({
    method: input.method,
    host: target.host,
    path: target.path,
    region,
    body: input.body,
    credentials,
    now: input.now,
    headers: requestHeaders,
  });
  return input.fetchImpl(target.url, { method: input.method, headers, body: input.body });
}

function objectTarget(config: ObjectStoreConfig, bucket: string, key: string, region: string) {
  const path = `/${encodeS3Path(`${bucket}/${key}`)}`;
  if (config.s3Endpoint) {
    const endpoint = config.s3Endpoint.replace(/\/+$/, "");
    const url = new URL(`${endpoint}${path}`);
    return { url: url.toString(), host: url.host, path: url.pathname };
  }
  const host = `s3.${region}.amazonaws.com`;
  return { url: `https://${host}${path}`, host, path };
}

function requiredBucket(config: ObjectStoreConfig) {
  if (!config.s3Bucket) {
    throw new ObjectStoreConfigurationError("S3_BUCKET is required");
  }
  return config.s3Bucket;
}

function parseConfiguredS3Uri(uri: string, configuredBucket: string): S3Ref {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new ObjectStoreNotFoundError();
  }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.hostname !== configuredBucket) {
    throw new ObjectStoreNotFoundError();
  }
  return { bucket: parsed.hostname, key: parsed.pathname.replace(/^\/+/, "") };
}

async function maybeGunzip(buffer: Buffer) {
  try {
    return await gunzipAsync(buffer);
  } catch {
    return buffer;
  }
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string) {
  const dateKey = hmacBuffer(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, "s3");
  return hmacBuffer(serviceKey, "aws4_request");
}

function lowerCaseHeaders(headers: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function hmacBuffer(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256Hex(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeS3Path(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function globalFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  },
) {
  return fetch(url, init) as Promise<ObjectStoreResponse>;
}
