export type StoryDraft = {
  agent: string;
  message: string;
  idempotencyKey?: string;
};

const lifetime = 24 * 60 * 60 * 1_000;
const maximumMessageLength = 200_000;

export function storyDraftKey(owner: string | undefined, project: string, story: string) {
  return owner ? `facility:story-draft:v1:${JSON.stringify([owner, project, story])}` : null;
}

/** Storage can be disabled or full; the mounted composer remains the working copy. */
export function readStoryDraft(key: string | null): StoryDraft | null {
  const draft = readStoredStoryDraft(key);
  return draft
    ? { agent: draft.agent, message: draft.message, idempotencyKey: draft.idempotencyKey }
    : null;
}

function readStoredStoryDraft(key: string | null): (StoryDraft & { updatedAt: number }) | null {
  if (!key) return null;
  try {
    const value = sessionStorage.getItem(key);
    if (!value) return null;
    const draft = JSON.parse(value);
    if (
      draft?.version !== 1 ||
      typeof draft.updatedAt !== "number" ||
      draft.updatedAt < Date.now() - lifetime ||
      draft.updatedAt > Date.now() + 60_000 ||
      typeof draft.agent !== "string" ||
      typeof draft.message !== "string" ||
      draft.message.length > maximumMessageLength ||
      (draft.idempotencyKey !== undefined &&
        (typeof draft.idempotencyKey !== "string" ||
          !/^ui-message-[a-f\d-]{36}$/i.test(draft.idempotencyKey)))
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    return {
      agent: draft.agent,
      message: draft.message,
      idempotencyKey: draft.idempotencyKey,
      updatedAt: draft.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeStoryDraft(key: string | null, draft: StoryDraft) {
  if (!key) return false;
  try {
    if (!draft.message) sessionStorage.removeItem(key);
    else {
      const previous = readStoredStoryDraft(key);
      const updatedAt =
        previous?.agent === draft.agent && previous.message === draft.message
          ? previous.updatedAt
          : Date.now();
      sessionStorage.setItem(key, JSON.stringify({ ...draft, version: 1, updatedAt }));
    }
    return true;
  } catch {
    return false;
  }
}

/** A receipt owns only its submitted draft, including across navigation/remounts. */
export function clearSentStoryDraft(key: string | null, attempt: StoryDraft) {
  if (!key || !attempt.idempotencyKey) return false;
  try {
    const current = readStoredStoryDraft(key);
    if (
      !current ||
      current.idempotencyKey !== attempt.idempotencyKey ||
      current.agent !== attempt.agent ||
      current.message !== attempt.message
    )
      return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
