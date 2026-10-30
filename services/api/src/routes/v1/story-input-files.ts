import { Transform } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { AppConfig } from "../../types.js";
import { INPUT_FILE_MAX_BYTES } from "../../workspaces/input-files.js";
import { DateValue, principal } from "./shared.js";

const Scope = z.object({ projectId: z.string().min(1), storyId: z.string().min(1) });
const FileScope = Scope.extend({ fileId: z.string().regex(/^infile_[a-z0-9]{16,64}$/) });
const Prepare = z.object({
  name: z.string().min(1).max(180),
  size: z.number().int().min(1).max(INPUT_FILE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z
    .string()
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
    .max(120)
    .default("application/octet-stream"),
  resume: z.boolean().default(false),
  idempotency_key: z.string().min(8).max(200),
});
const InputFile = z.object({
  id: FileScope.shape.fileId,
  name: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  mediaType: z.string(),
  state: z.enum(["prepared", "uploading", "available", "failed", "removed"]),
  errorCode: z.string().nullable(),
  createdAt: DateValue,
  receivedAt: DateValue.nullable(),
  expiresAt: DateValue,
});
const FileResult = z.object({ file: InputFile });
// Runtime validation stays binary; the metadata describes its wire encoding.
const BinaryBody = z
  .custom<Buffer>((value) => Buffer.isBuffer(value))
  .meta({ type: "string", format: "binary" });
const Limits = z.object({
  fileBytes: z.number().int(),
  storyBytes: z.number().int(),
  messageFiles: z.number().int(),
});
const PreparedFile = FileResult.extend({
  upload: z.object({
    method: z.literal("PUT"),
    path: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: DateValue,
    mayResumeCompute: z.boolean(),
  }),
  limits: Limits,
});

export async function registerStoryInputFileRoutes(app: FastifyInstance, config: AppConfig) {
  const files = app.storyDomain.inputFiles;
  const uploadSizes = new WeakMap<FastifyRequest, number>();
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );
  const base = "/v1/projects/:projectId/workspace-stories/:storyId/input-files";
  app.get(
    base,
    {
      config: { permission: "projects:read" },
      schema: {
        params: Scope,
        operationId: "listStoryInputFiles",
        response: {
          200: z.object({
            items: z.array(InputFile),
            limits: Limits.extend({ projectBytes: z.number().int() }),
          }),
        },
      },
    },
    async (request) => {
      const scope = request.params as z.infer<typeof Scope>;
      return files.list({ ...scope, orgId: principal(request).orgId });
    },
  );
  app.post(
    base,
    {
      config: { permission: "workspaces:execute", auditAction: "story.input_file.prepared" },
      schema: {
        params: Scope,
        body: Prepare,
        operationId: "prepareStoryInputFile",
        response: { 200: PreparedFile },
      },
    },
    async (request) => {
      const scope = request.params as z.infer<typeof Scope>;
      const body = request.body as z.infer<typeof Prepare>;
      const actor = principal(request);
      const prepared = await files.prepare(
        { ...scope, orgId: actor.orgId },
        { ...body, idempotencyKey: body.idempotency_key },
        { type: actor.type, id: actor.id },
      );
      return {
        ...prepared,
        upload: {
          ...prepared.upload,
          url: new URL(prepared.upload.path, config.publicUrl).toString(),
        },
      };
    },
  );
  // A single-file, short-lived capability authenticates this binary transfer.
  // Validate before buffering the body; it does not grant general API access.
  app.put(
    `${base}/:fileId/content`,
    {
      bodyLimit: INPUT_FILE_MAX_BYTES,
      config: { public: true },
      schema: {
        params: FileScope,
        operationId: "uploadStoryInputFile",
        consumes: ["application/octet-stream"],
        body: BinaryBody,
        headers: z.object({ "x-facility-file-token": z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
        response: { 200: FileResult },
        description:
          "Single-use, file-scoped upload capability; send raw application/octet-stream bytes, never JSON or base64.",
      },
      onRequest: async (request) => {
        const { projectId, storyId, fileId } = FileScope.parse(request.params);
        const grant = await files.beginUpload(
          projectId,
          storyId,
          fileId,
          String(request.headers["x-facility-file-token"] ?? ""),
          request.id,
        );
        uploadSizes.set(request, grant.size);
        if (
          request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/octet-stream"
        )
          throw new ApiError(415, "input_file_content_type", "Upload as application/octet-stream");
        if (Number(request.headers["content-length"]) > grant.size)
          throw new ApiError(413, "input_file_too_large", "Upload exceeds its declared byte limit");
        request.raw.once("aborted", () => {
          void files.failUpload(fileId, request.id).catch(() => undefined);
        });
      },
      preParsing: (request, _reply, payload, done) => {
        const limit = uploadSizes.get(request);
        if (limit === undefined) {
          done(new ApiError(401, "input_upload_invalid", "Upload grant required"));
          return;
        }
        const meter = Object.assign(
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              meter.receivedEncodedLength += chunk.length;
              if (meter.receivedEncodedLength > limit)
                callback(
                  new ApiError(
                    413,
                    "input_file_too_large",
                    "Upload exceeds its declared byte limit",
                  ),
                );
              else callback(null, chunk);
            },
          }),
          { receivedEncodedLength: 0 },
        );
        payload.once("error", (error) => meter.destroy(error));
        done(null, meter);
        payload.pipe(meter);
      },
      onError: async (request) => {
        const { fileId } = request.params as { fileId?: string };
        if (fileId)
          await files.failUpload(fileId, request.id).catch(() => {
            // Preserve the original transfer error. No body or grant is logged.
            request.log.warn({ fileId }, "could not record input file transfer failure");
          });
      },
    },
    async (request) => {
      const { projectId, storyId, fileId } = request.params as z.infer<typeof FileScope>;
      if (!Buffer.isBuffer(request.body))
        throw new ApiError(415, "input_file_content_type", "Upload as application/octet-stream");
      return files.upload(
        projectId,
        storyId,
        fileId,
        String(request.headers["x-facility-file-token"] ?? ""),
        request.id,
        request.body,
      );
    },
  );
  app.get(
    `${base}/:fileId/content`,
    {
      config: { permission: "workspaces:read" },
      schema: {
        params: FileScope,
        operationId: "downloadStoryInputFile",
        produces: ["application/octet-stream"],
        response: { 200: BinaryBody },
      },
    },
    async (request, reply) => {
      const { fileId, ...scope } = request.params as z.infer<typeof FileScope>;
      const result = await files.download({ ...scope, orgId: principal(request).orgId }, fileId);
      return reply
        .type("application/octet-stream")
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(result.file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        )
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(result.bytes);
    },
  );
  app.delete(
    `${base}/:fileId`,
    {
      config: { permission: "workspaces:execute", auditAction: "story.input_file.removed" },
      schema: {
        params: FileScope,
        querystring: z.object({ resume: z.enum(["true", "false"]).default("false") }),
        operationId: "removeStoryInputFile",
        response: { 200: FileResult },
      },
    },
    async (request) => {
      const { fileId, ...scope } = request.params as z.infer<typeof FileScope>;
      const actor = principal(request);
      return files.remove(
        { ...scope, orgId: actor.orgId },
        fileId,
        { type: actor.type, id: actor.id },
        (request.query as { resume: string }).resume === "true",
      );
    },
  );
}
