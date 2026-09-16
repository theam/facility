import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnEvent } from "../src/turns/engines.js";
import { LiveTurnEvents } from "../src/turns/live-events.js";

const event = (n: number): AgentTurnEvent => ({
  engine: "codex",
  type: "item.completed",
  data: { n },
});
afterEach(() => vi.useRealTimers());

describe("durable live engine events", () => {
  it("writes before completion, serializes concurrent arrivals and does not replay the prefix", async () => {
    const stored: AgentTurnEvent[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    const write = vi.fn(async (batch: AgentTurnEvent[]) => {
      expect(active++).toBe(0);
      if (!stored.length) await gate;
      stored.push(...batch);
      active--;
    });
    const recorder = new LiveTurnEvents(write);
    recorder.append(event(1));
    recorder.append(event(2));
    expect(write).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(stored).toEqual([event(1), event(2)]));
    await recorder.finish([event(1), event(2), event(3)]);
    expect(stored).toEqual([event(1), event(2), event(3)]);
  });

  it("retries an atomic failed batch without losing or duplicating preceding events", async () => {
    vi.useFakeTimers();
    const stored: AgentTurnEvent[] = [];
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("database disconnected"))
      .mockImplementation(async (batch: AgentTurnEvent[]) => {
        stored.push(...batch);
      });
    const recorder = new LiveTurnEvents(write);
    recorder.append(event(1));
    recorder.append(event(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toEqual([event(1), event(2)]);
    await recorder.finish([event(1), event(2)]);
    expect(stored).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports evidence persistence failure and clears its timer", async () => {
    vi.useFakeTimers();
    const recorder = new LiveTurnEvents(async () => {
      throw new Error("database unavailable");
    });
    recorder.append(event(1));
    await expect(recorder.finish()).rejects.toThrow("database unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
