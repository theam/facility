import { describe, expect, it, vi } from "vitest";
import {
  CommandLogReplay,
  CommandReadObserver,
  isTransientObservationError,
  retryObservation,
} from "../src/workspaces/command-observation.js";

describe("command observation recovery", () => {
  it("does not renew a completion poll denied at the same time as its deadline", async () => {
    vi.useFakeTimers();
    try {
      const failure = Object.assign(new Error("Forbidden"), { status: 403 });
      const request = vi.fn(
        (signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(failure), { once: true });
          }),
      );
      const notify = vi.fn();
      const observer = new CommandReadObserver(new AbortController().signal, notify);
      const result = expect(observer.read("completion", request)).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(30_000);
      await result;
      expect(request).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: "failed", httpStatus: 403 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new TypeError("terminated"),
    new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
    { response: { status: 503 } },
    { status: 429 },
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  ])("recognizes recoverable read failures", (error) => {
    expect(isTransientObservationError(error)).toBe(true);
  });

  it.each([
    { status: 403, cause: { code: "ECONNRESET" } },
    { response: { status: 401 } },
    { status: 404 },
    new SyntaxError("invalid provider response"),
    new TypeError("invalid argument"),
    { name: "StreamError", code: "session_stopped" },
    new DOMException("Canceled", "AbortError"),
    Object.assign(new DOMException("Timed out", "TimeoutError"), { status: 403 }),
  ])("preserves denial and permanent errors", (error) => {
    expect(isTransientObservationError(error)).toBe(false);
  });

  it("bounds retries and honors cancellation before waiting", async () => {
    const failure = new TypeError("terminated");
    await expect(retryObservation(failure, 8, new AbortController().signal)).rejects.toBe(failure);
    const canceled = new AbortController();
    canceled.abort(new Error("canceled"));
    await expect(retryObservation(failure, 0, canceled.signal)).rejects.toThrow("canceled");
  });

  it("distinguishes repeated text within a run from replay and rejects changed history", () => {
    const logs = new CommandLogReplay();
    expect(logs.append("stdout", "same\nsame\n")).toBe("same\nsame\n");
    logs.restart();
    expect(logs.append("stdout", "same\n")).toBe("");
    expect(logs.append("stderr", "warning")).toBe("warning");
    expect(logs.append("stdout", "same\nnew\n")).toBe("new\n");
    logs.restart();
    expect(() => logs.append("stdout", "different")).toThrow("differs");
  });
});
