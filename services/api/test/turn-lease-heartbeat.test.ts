import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurnLeaseHeartbeat } from "../src/turns/lease-heartbeat.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("reports and throttles failed writes, then records recovery without database details", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const renew = vi.fn().mockRejectedValue(new Error("password=private-value"));
  const lost = vi.fn();
  const heartbeat = new TurnLeaseHeartbeat(renew, lost, "turn_test");
  await vi.advanceTimersByTimeAsync(32_000);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.parse(warn.mock.calls[0]?.[0])).toMatchObject({
    event: "turn.heartbeat_unconfirmed",
    turnId: "turn_test",
    reason: "write_failed",
    failures: 1,
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
  expect(lost).not.toHaveBeenCalled();
  renew.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(JSON.parse(info.mock.calls[0]?.[0])).toMatchObject({
    event: "turn.heartbeat_recovered",
    failures: 16,
    sinceConfirmedMs: 34_000,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(info).toHaveBeenCalledOnce();
  heartbeat.stop();
});

it("reports a stuck write without overlapping writes and ignores late results after stop", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let finish!: (alive: boolean) => void;
  const renew = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const lost = vi.fn();
  const heartbeat = new TurnLeaseHeartbeat(renew, lost, "turn_test");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.parse(warn.mock.calls[0]?.[0])).toMatchObject({
    reason: "write_pending",
    sinceConfirmedMs: 30_000,
  });
  heartbeat.stop();
  finish(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(lost).not.toHaveBeenCalled();
});

it("cancels only on confirmed lease loss and stops renewing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const renew = vi.fn().mockResolvedValue(false);
  const lost = vi.fn();
  const heartbeat = new TurnLeaseHeartbeat(renew, lost, "turn_test");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(lost).toHaveBeenCalledOnce();
  expect(renew).toHaveBeenCalledOnce();
  expect(JSON.parse(warn.mock.calls[0]?.[0])).toMatchObject({
    event: "turn.lease_lost",
    turnId: "turn_test",
  });
  heartbeat.stop();
});
