export type StoryUploadAttempt = {
  idempotencyKey: string;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
  resume: boolean;
  fileId?: string;
};

const lifetime = 24 * 60 * 60 * 1_000;

/** The upload intent has no file bytes or capability token. It is separate from a message. */
function parse(value: unknown): StoryUploadAttempt | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.idempotencyKey !== "string" ||
    !/^ui-file-[a-f\d-]{36}$/i.test(item.idempotencyKey) ||
    typeof item.name !== "string" ||
    !item.name.length ||
    item.name.length > 180 ||
    typeof item.size !== "number" ||
    !Number.isSafeInteger(item.size) ||
    item.size < 1 ||
    item.size > 25 * 1024 * 1024 ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    typeof item.mediaType !== "string" ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.mediaType) ||
    item.mediaType.length > 120 ||
    typeof item.resume !== "boolean" ||
    (item.fileId !== undefined &&
      (typeof item.fileId !== "string" || !/^infile_[a-z0-9]{16,64}$/.test(item.fileId)))
  )
    return null;
  return {
    idempotencyKey: item.idempotencyKey,
    name: item.name,
    size: item.size,
    sha256: item.sha256,
    mediaType: item.mediaType,
    resume: item.resume,
    ...(item.fileId ? { fileId: item.fileId as string } : {}),
  };
}

export function readStoryUpload(draftKey: string | null): StoryUploadAttempt | undefined {
  if (!draftKey) return undefined;
  try {
    const key = `${draftKey}:upload`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw);
    const attempt = parse(stored.attempt);
    if (
      stored.version !== 1 ||
      typeof stored.updatedAt !== "number" ||
      stored.updatedAt < Date.now() - lifetime ||
      stored.updatedAt > Date.now() + 60_000 ||
      !attempt
    ) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    return attempt;
  } catch {
    return undefined;
  }
}

export function writeStoryUpload(draftKey: string | null, attempt?: StoryUploadAttempt) {
  if (!draftKey) return false;
  try {
    const key = `${draftKey}:upload`;
    if (!attempt) sessionStorage.removeItem(key);
    else {
      const safe = parse(attempt);
      if (!safe) return false;
      const raw = sessionStorage.getItem(key);
      let previous: { attempt?: StoryUploadAttempt; updatedAt?: number } | undefined;
      try {
        previous = raw ? JSON.parse(raw) : undefined;
      } catch {
        // A new explicit intent replaces an unreadable local record.
      }
      const updatedAt =
        previous?.attempt?.idempotencyKey === safe.idempotencyKey &&
        typeof previous.updatedAt === "number"
          ? previous.updatedAt
          : Date.now();
      sessionStorage.setItem(key, JSON.stringify({ version: 1, updatedAt, attempt: safe }));
    }
    return true;
  } catch {
    return false;
  }
}
