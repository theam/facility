import { afterEach, expect, it, vi } from "vitest";
import { withPreviewLease } from "../src/stories/preview-lease.js";

afterEach(() => vi.useRealTimers());
it("renews throughout a command lasting longer than the initial lease", async () => {
  vi.useFakeTimers();
  const renew = vi.fn(async () => new Date(Date.now() + 3000));
  const stop = vi.fn(async () => undefined);
  const running = withPreviewLease(
    renew,
    async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      signal.throwIfAborted();
      return "ready";
    },
    stop,
  );
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await running).toBe("ready");
  expect(renew.mock.calls.length).toBeGreaterThan(9);
  expect(stop).not.toHaveBeenCalled();
});
it.each([
  "revoked",
  "unreachable",
])("cancels and waits for compute stop when authority is %s", async (mode) => {
  vi.useFakeTimers();
  let releaseStop!: () => void;
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      }),
  );
  let calls = 0;
  const renew = async () => {
    if (++calls === 1) return new Date(Date.now() + 3000);
    if (mode === "revoked") return null;
    return new Promise<Date | null>(() => undefined);
  };
  let signal: AbortSignal | undefined;
  const running = withPreviewLease(
    renew,
    async (s) => {
      signal = s;
      await new Promise<void>((resolve) =>
        s.addEventListener("abort", () => resolve(), { once: true }),
      );
      s.throwIfAborted();
    },
    stop,
  );
  const result = vi.fn();
  const observed = running.catch((error) => {
    result(error.code);
  });
  await vi.advanceTimersByTimeAsync(2500);
  expect(signal?.aborted).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(result).not.toHaveBeenCalled();
  releaseStop();
  await observed;
  expect(result).toHaveBeenCalledWith("preview_lease_lost");
});

it("reports an unconfirmed compute stop instead of releasing a lost writer", async () => {
  await expect(
    withPreviewLease(
      async () => null,
      async () => "unreachable",
      async () => {
        throw new Error("provider unavailable");
      },
    ),
  ).rejects.toMatchObject({ code: "preview_compute_stop_unconfirmed" });
});
