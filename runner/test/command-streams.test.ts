import { describe, expect, it } from "vitest";
import { awaitCommandStreams } from "../src/index.js";

// A rejected promise nothing has handled raises unhandledRejection at the end of
// the turn, which for the runner means the process aborts before it can post a
// terminal result. Observing that takes the process listener, so the harness's
// own listeners are lifted for the duration and put back afterwards.
async function withUnhandledRejectionCapture(body: () => Promise<void>) {
  const existing = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    await body();
    // The event is emitted once the microtask queue has drained, so give it a
    // macrotask to land in before the listener goes away.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", capture);
    for (const listener of existing) {
      process.on("unhandledRejection", listener as (reason: unknown) => void);
    }
  }
  return unhandled;
}

describe("command stream supervision", () => {
  it("marks each drain handled before it waits on the command's exit", async () => {
    const cleared: string[] = [];
    const drains = [
      Promise.reject(new Error("event delivery failed mid-command")),
      Promise.resolve(undefined),
    ];
    // The command keeps running for several macrotasks after the drain has
    // already failed: exactly the window an unhandled rejection would abort in.
    const exit = new Promise<number>((resolve) => setTimeout(() => resolve(0), 10));

    const unhandled = await withUnhandledRejectionCapture(async () => {
      await expect(
        awaitCommandStreams(exit, drains, () => cleared.push("cleared")),
      ).rejects.toThrow("event delivery failed mid-command");
    });

    expect(unhandled).toEqual([]);
    // The armed SIGKILL escalation is a live timer handle, so it has to be
    // disarmed on the rejection path too.
    expect(cleared).toEqual(["cleared"]);
  });

  it("returns the exit code only after both drains finish, then disarms the timer", async () => {
    const order: string[] = [];
    const cleared: string[] = [];
    const settle = (name: string, ms: number) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push(name);
          resolve();
        }, ms),
      );
    const exit = new Promise<number>((resolve) =>
      setTimeout(() => {
        order.push("exit");
        resolve(7);
      }, 1),
    );

    const code = await awaitCommandStreams(exit, [settle("stdout", 5), settle("stderr", 10)], () =>
      cleared.push("cleared"),
    );

    expect(code).toBe(7);
    // No output line may be emitted after the caller records the run's result.
    expect(order).toEqual(["exit", "stdout", "stderr"]);
    expect(cleared).toEqual(["cleared"]);
  });
});
