import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_REVALIDATE_MS,
  PREVIEW_SOCKET_EXPIRED,
  PREVIEW_SOCKET_REVOKED,
  PreviewSocketWatch,
} from "../src/workspaces/preview-socket-watch.js";

const HOUR = 60 * 60 * 1_000;
const token = "t".repeat(43);
const invalid = () =>
  Object.assign(new Error("invalid"), { statusCode: 401, code: "preview_access_invalid" });

function session(id = "psess_1234567890abcdef", ttlMs = HOUR) {
  return { id, expiresAt: new Date(Date.now() + ttlMs) };
}

describe("open preview WebSocket revalidation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes a socket with 4401 within one interval of losing access", async () => {
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw invalid();
    });
    const watch = new PreviewSocketWatch(authorize);
    const close = vi.fn();
    watch.watch(session(), token, close);

    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS);
    expect(authorize).toHaveBeenCalledWith("psess_1234567890abcdef", token);
    expect(close).not.toHaveBeenCalled();

    allowed = false;
    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS);
    expect(close).toHaveBeenCalledExactlyOnceWith(PREVIEW_SOCKET_REVOKED, "Preview access revoked");
    expect(watch.size).toBe(0);
  });

  it("closes a socket with 4408 when its session expires, without a query", async () => {
    const authorize = vi.fn(async () => {});
    const watch = new PreviewSocketWatch(authorize, HOUR);
    const close = vi.fn();
    watch.watch(session("psess_1234567890abcdef", 5_000), token, close);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledExactlyOnceWith(
      PREVIEW_SOCKET_EXPIRED,
      "Preview session expired",
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks a session once per interval however many sockets it holds", async () => {
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw invalid();
    });
    const watch = new PreviewSocketWatch(authorize);
    const opened = session();
    const closers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    for (const close of closers) {
      watch.watch(opened, token, close);
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS * 2);
    expect(authorize).toHaveBeenCalledTimes(2);

    allowed = false;
    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS);
    for (const close of closers)
      expect(close).toHaveBeenCalledWith(PREVIEW_SOCKET_REVOKED, expect.any(String));
  });

  it("never runs a second check while one is still in flight", async () => {
    let resolve: () => void = () => {};
    const authorize = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    const watch = new PreviewSocketWatch(authorize);
    watch.watch(session(), token, vi.fn());

    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS * 3);
    expect(authorize).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("keeps sockets open through a failed check that is not a denial", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    const watch = new PreviewSocketWatch(authorize);
    const close = vi.fn();
    watch.watch(session(), token, close);

    await vi.advanceTimersByTimeAsync(PREVIEW_REVALIDATE_MS * 3);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(close).toHaveBeenCalledWith(PREVIEW_SOCKET_EXPIRED, expect.any(String));
  });

  it("clears both timers once the last socket of a session closes", async () => {
    const authorize = vi.fn(async () => {});
    const watch = new PreviewSocketWatch(authorize);
    const opened = session();
    const first = watch.watch(opened, token, vi.fn());
    const second = watch.watch(opened, token, vi.fn());
    expect(vi.getTimerCount()).toBe(2);

    first();
    expect(vi.getTimerCount()).toBe(2);
    second();
    expect(vi.getTimerCount()).toBe(0);
    expect(watch.size).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("closes a socket whose session has already expired", async () => {
    const watch = new PreviewSocketWatch(vi.fn(async () => {}));
    const close = vi.fn();
    watch.watch(session("psess_1234567890abcdef", -1), token, close);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith(PREVIEW_SOCKET_EXPIRED, expect.any(String));
    expect(vi.getTimerCount()).toBe(0);
  });
});
