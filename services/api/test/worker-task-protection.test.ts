import { afterEach, describe, expect, it, vi } from "vitest";
import { ecsTaskProtection, WorkerTurnGuard } from "../src/worker-task-protection.js";

afterEach(() => vi.useRealTimers());

describe("worker turn protection", () => {
  it("acquires before admission and releases only after the turn completes", async () => {
    const events: string[] = [];
    const guard = new WorkerTurnGuard(
      {
        set: async (value) => {
          events.push(String(value));
        },
      },
      { warn: vi.fn() },
    );
    await expect(
      guard.run(async () => {
        events.push("dispatch");
        return 42;
      }),
    ).resolves.toBe(42);
    expect(events).toEqual(["true", "dispatch", "false"]);
  });

  it("does not claim a turn when acquisition is denied", async () => {
    const dispatch = vi.fn();
    const guard = new WorkerTurnGuard(
      {
        set: async () => {
          throw new Error("denied");
        },
      },
      { warn: vi.fn() },
    );
    await expect(guard.run(dispatch)).rejects.toThrow("denied");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releases after failure without replacing the original error", async () => {
    const warn = vi.fn();
    const guard = new WorkerTurnGuard(
      {
        set: async (value) => {
          if (!value) throw new Error("release denied");
        },
      },
      { warn },
    );
    await expect(
      guard.run(async () => {
        throw new Error("engine failed");
      }),
    ).rejects.toThrow("engine failed");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: "worker.protection_release_failed",
      code: "REQUEST_FAILED",
      status: undefined,
      leaseRemainingMs: undefined,
    });
  });

  it("does not start work if shutdown arrives during acquisition", async () => {
    const dispatch = vi.fn();
    const states: boolean[] = [];
    const guard = new WorkerTurnGuard(
      {
        set: async (enabled) => {
          states.push(enabled);
          guard.close();
        },
      },
      { warn: vi.fn() },
    );
    await expect(guard.run(dispatch)).rejects.toThrow("shutting down");
    expect(states).toEqual([true, false]);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(guard.run(dispatch)).rejects.toThrow("not accepting");
  });

  it("renews long turns and never releases while renewal is in flight", async () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    let finish!: () => void;
    let finishRenewal!: () => void;
    const guard = new WorkerTurnGuard(
      {
        set: async (enabled) => {
          states.push(enabled);
          if (states.length === 2)
            await new Promise<void>((resolve) => {
              finishRenewal = resolve;
            });
        },
      },
      { warn: vi.fn() },
    );
    const turn = guard.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual([true, true]);
    await expect(guard.run(vi.fn())).rejects.toThrow("not accepting");
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual([true, true]);
    finishRenewal();
    await turn;
    expect(states).toEqual([true, true, false]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(states).toHaveLength(3);
  });

  it("retries transient renewal failure without restarting the turn", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const set = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("unavailable"));
    let finish!: () => void;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const turn = new WorkerTurnGuard({ set }, { warn }).run(dispatch);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(set.mock.calls).toEqual([[true], [true], [true]]);
    expect(warn).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    finish();
    await turn;
    expect(set).toHaveBeenLastCalledWith(false);
  });

  it("reports remaining protection without exposing arbitrary error details", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const expiresAt = Date.now() + 48 * 60 * 60_000;
    const set = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("provider credential=private-value"));
    let finish!: () => void;
    const turn = new WorkerTurnGuard({ set, expiresAt }, { warn }).run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: "worker.protection_renewal_failed",
      code: "REQUEST_FAILED",
      status: undefined,
      leaseRemainingMs: 48 * 60 * 60_000 - 60_000,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
    finish();
    await turn;
  });

  it("keeps non-ECS workers unchanged and rejects invalid opt-in configuration", async () => {
    expect(await ecsTaskProtection({})).toBeUndefined();
    expect(await new WorkerTurnGuard(undefined, { warn: vi.fn() }).run(async () => "ok")).toBe(
      "ok",
    );
    await expect(ecsTaskProtection({ FACILITY_WORKER_TASK_PROTECTION: "unknown" })).rejects.toThrow(
      "Unknown",
    );
    await expect(ecsTaskProtection({ FACILITY_WORKER_TASK_PROTECTION: "ecs" })).rejects.toThrow(
      "required",
    );
  });

  it.each([
    "https://169.254.170.2",
    "http://example.org",
    "http://169.254.170.2:80@evil.example",
    "http://169.254.170.2?x=1",
  ])("refuses untrusted agent endpoint %s", async (endpoint) => {
    const request = vi.fn();
    await expect(
      ecsTaskProtection(
        { FACILITY_WORKER_TASK_PROTECTION: "ecs", ECS_AGENT_URI: endpoint },
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
