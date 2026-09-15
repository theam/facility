import { setTimeout } from "node:timers/promises";

/** Only retry observation reads, never submission or authorization failures. */
export function isTransientObservationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    status?: number;
    response?: { status?: number };
    code?: string;
    cause?: unknown;
  };
  const status = failure.status ?? failure.response?.status;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504].includes(status);
  if (
    failure.code &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(failure.code)
  )
    return true;
  if (error instanceof TypeError && /^(?:fetch failed|terminated)$/.test(error.message)) {
    return true;
  }
  return failure.cause !== error && isTransientObservationError(failure.cause);
}

export async function retryObservation(error: unknown, attempt: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!isTransientObservationError(error) || attempt >= 8) throw error;
  await setTimeout(Math.min(250 * 2 ** attempt, 5_000), undefined, { signal });
}

/** The provider replays logs from the start; chunk boundaries can change. */
export class CommandLogReplay {
  private readonly output = { stdout: "", stderr: "" };
  private readonly position = { stdout: 0, stderr: 0 };

  restart() {
    this.position.stdout = 0;
    this.position.stderr = 0;
  }

  append(stream: "stdout" | "stderr", data: string): string {
    const position = this.position[stream];
    const overlap = Math.min(data.length, this.output[stream].length - position);
    if (this.output[stream].slice(position, position + overlap) !== data.slice(0, overlap)) {
      throw new Error("Command log replay differs from previously observed output");
    }
    this.position[stream] += data.length;
    const fresh = data.slice(overlap);
    this.output[stream] += fresh;
    return fresh;
  }
}
