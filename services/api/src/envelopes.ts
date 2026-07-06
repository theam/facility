import {
  createObjectStore,
  ObjectStoreConfigurationError,
  ObjectStoreHttpError,
  ObjectStoreNotFoundError,
} from "@facility/core";
import { ApiError } from "./errors.js";
import type { AppConfig } from "./types.js";

export async function readEnvelopeObject(
  config: AppConfig,
  uri: string | null | undefined,
  orgId: string,
) {
  if (!uri) throw envelopeNotFound();
  if (!config.s3Bucket) throw envelopeNotFound();
  try {
    // Bind the read to the owning org's envelope prefix (envelopes/<orgId>/…) so
    // a row whose stored URI was mis-set to another same-bucket object cannot be
    // read cross-tenant — the row scope check alone would not catch that.
    return await createObjectStore(config).getObject(uri, {
      expectedKeyPrefix: `envelopes/${orgId}/`,
    });
  } catch (error) {
    throw mapObjectStoreReadError(error);
  }
}

export async function writeEnvelopeObject(input: {
  config: AppConfig;
  orgId: string;
  requestId: string;
  payload: unknown;
  now?: Date;
}) {
  if (!input.config.s3Bucket) {
    throw new ApiError(500, "envelope_store_unconfigured", "S3_BUCKET is required");
  }
  try {
    return await createObjectStore(input.config).putObject({
      orgId: input.orgId,
      requestId: input.requestId,
      payload: input.payload,
      now: input.now,
    });
  } catch (error) {
    throw mapObjectStoreWriteError(error);
  }
}

export async function verifyEnvelopeRoundTrip(input: {
  config: AppConfig;
  orgId: string;
  requestId: string;
  payload: unknown;
  now?: Date;
}) {
  const uri = await writeEnvelopeObject(input);
  const loaded = await readEnvelopeObject(input.config, uri, input.orgId);
  return { uri, loaded };
}

export async function writeTranscriptObject(input: {
  config: AppConfig;
  orgId: string;
  runId: string;
  body: Buffer;
  now?: Date;
}) {
  if (!input.config.s3Bucket) {
    throw new ApiError(500, "transcript_store_unconfigured", "S3_BUCKET is required");
  }
  try {
    return await createObjectStore(input.config).putBytes({
      key: transcriptKey(input.orgId, input.runId),
      body: input.body,
      contentType: "application/x-ndjson",
      now: input.now,
    });
  } catch (error) {
    throw mapTranscriptWriteError(error);
  }
}

export async function readTranscriptObject(
  config: AppConfig,
  uri: string | null | undefined,
  orgId: string,
) {
  if (!uri) throw transcriptNotFound();
  if (!config.s3Bucket) throw transcriptNotFound();
  try {
    return await createObjectStore(config).getBytes(uri, {
      expectedKeyPrefix: `transcripts/${orgId}/`,
    });
  } catch (error) {
    throw mapTranscriptReadError(error);
  }
}

function transcriptKey(orgId: string, runId: string) {
  return `transcripts/${orgId}/${runId}.jsonl`;
}

function mapObjectStoreReadError(error: unknown) {
  if (error instanceof ObjectStoreNotFoundError) return envelopeNotFound();
  if (error instanceof ObjectStoreHttpError) {
    if (error.status === 404) return envelopeNotFound();
    return new ApiError(502, "envelope_read_failed", `Envelope store returned ${error.status}`);
  }
  if (error instanceof ObjectStoreConfigurationError) {
    return new ApiError(500, "envelope_store_unconfigured", error.message);
  }
  return new ApiError(502, "envelope_read_failed", "Envelope read failed");
}

function mapObjectStoreWriteError(error: unknown) {
  if (error instanceof ObjectStoreConfigurationError) {
    return new ApiError(500, "envelope_store_unconfigured", error.message);
  }
  if (error instanceof ObjectStoreHttpError) {
    return new ApiError(502, "envelope_write_failed", `Envelope store returned ${error.status}`);
  }
  return new ApiError(502, "envelope_write_failed", "Envelope write failed");
}

function mapTranscriptReadError(error: unknown) {
  if (error instanceof ObjectStoreNotFoundError) return transcriptNotFound();
  if (error instanceof ObjectStoreHttpError) {
    if (error.status === 404) return transcriptNotFound();
    return new ApiError(502, "transcript_read_failed", `Transcript store returned ${error.status}`);
  }
  if (error instanceof ObjectStoreConfigurationError) {
    return new ApiError(500, "transcript_store_unconfigured", error.message);
  }
  return new ApiError(502, "transcript_read_failed", "Transcript read failed");
}

function mapTranscriptWriteError(error: unknown) {
  if (error instanceof ObjectStoreConfigurationError) {
    return new ApiError(500, "transcript_store_unconfigured", error.message);
  }
  if (error instanceof ObjectStoreHttpError) {
    return new ApiError(
      502,
      "transcript_write_failed",
      `Transcript store returned ${error.status}`,
    );
  }
  return new ApiError(502, "transcript_write_failed", "Transcript write failed");
}

function envelopeNotFound() {
  return new ApiError(404, "envelope_not_found", "Envelope not found");
}

function transcriptNotFound() {
  return new ApiError(404, "transcript_not_found", "Transcript not found");
}
