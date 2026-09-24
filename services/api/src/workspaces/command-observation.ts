import { setTimeout } from "node:timers/promises";
import type { CommandObservation } from "./runtime.js";

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
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
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

/** A read deadline releases a stuck request; only the caller's deadline ends recovery. */
export class CommandReadObserver {
  constructor(
    private readonly signal: AbortSignal,
    private readonly notify: (event: CommandObservation) => void,
  ) {}

  async read<T>(
    operation: "journal" | "completion",
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    let recovering = false;
    let lastReport = -Infinity;
    for (let attempt = 0; ; attempt += 1) {
      this.signal.throwIfAborted();
      const timeout = new AbortController();
      const timer = globalThis.setTimeout(
        () => timeout.abort(new DOMException("Command read deadline exceeded", "TimeoutError")),
        30_000,
      );
      timer.unref();
      const signal = AbortSignal.any([this.signal, timeout.signal]);
      try {
        const result = await request(signal);
        this.signal.throwIfAborted();
        if (recovering)
          this.notify({
            state: "recovered",
            operation,
            attempt,
            elapsedMs: Date.now() - startedAt,
          });
        return result;
      } catch (error) {
        this.signal.throwIfAborted();
        const transient = isTransientObservationError(error);
        // A long poll naturally expires while the command is still working.
        // A simultaneous permanent response must still take precedence.
        if (operation === "completion" && timeout.signal.aborted && transient) continue;
        if (!transient || Date.now() - lastReport >= 30_000) {
          const failure = error as { status?: number; response?: { status?: number } };
          const status = failure?.status ?? failure?.response?.status;
          this.notify({
            state: transient ? "recovering" : "failed",
            operation,
            attempt,
            elapsedMs: Date.now() - startedAt,
            reason:
              error instanceof DOMException && error.name === "TimeoutError"
                ? "read_timeout"
                : "read_failed",
            ...(typeof status === "number" && status >= 400 && status <= 599
              ? { httpStatus: status }
              : {}),
          });
          lastReport = Date.now();
        }
        if (!transient) throw error;
        recovering = true;
      } finally {
        clearTimeout(timer);
      }
      await setTimeout(Math.min(500 * 2 ** Math.min(attempt, 6), 30_000), undefined, {
        signal: this.signal,
      });
    }
  }
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
