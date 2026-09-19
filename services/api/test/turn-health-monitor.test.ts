import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnHealthMonitor } from "../src/turns/health-monitor.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("turn health monitor", () => {
  it("samples during a run, never overlaps, and stops sampling after completion", async () => {
    vi.useFakeTimers();
    let resolve: ((v: { provider: string; state: string }) => void) | undefined;
    const inspect = vi.fn(
      () =>
        new Promise<{ provider: string; state: string }>((r) => {
          resolve = r;
        }),
    );
    const save = vi.fn().mockResolvedValue(undefined);
    const monitor = new TurnHealthMonitor(inspect, save);
    monitor.start();
    void monitor.sample();
    await Promise.resolve();
    expect(inspect).toHaveBeenCalledOnce();
    resolve?.({ provider: "fake", state: "running" });
    await monitor.sample();
    expect(save).toHaveBeenCalledOnce();
    await monitor.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(inspect).toHaveBeenCalledOnce();
  });
  it("records probe failures without copying provider secrets or failing the agent", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const monitor = new TurnHealthMonitor(async () => {
      throw new Error("authorization secret");
    }, save);
    await monitor.sample();
    await monitor.stop();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ probe: "unavailable", missedSamples: 0 });
    expect(JSON.stringify(save.mock.calls)).not.toContain("authorization secret");
  });
  it("bounds an unresponsive provider and does not create overlapping retries", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const inspect = vi.fn(() => new Promise<never>(() => {}));
    const save = vi.fn().mockResolvedValue(undefined);
    const monitor = new TurnHealthMonitor(inspect, save);
    const sample = monitor.sample();
    await Promise.resolve();
    controller.abort();
    await sample;
    await monitor.sample();
    await monitor.stop();
    expect(inspect).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ probe: "unavailable" });
  });

  it("exposes previously missed samples after a storage outage", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const save = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const monitor = new TurnHealthMonitor(
      async () => ({ provider: "fake", state: "running" }),
      save,
    );
    await monitor.sample();
    await monitor.sample();
    await monitor.stop();
    expect(save.mock.calls[1]?.[0]).toMatchObject({ missedSamples: 1 });
  });
});
