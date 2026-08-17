import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACKABLE_STEER_ID, ackableSteerIds, steeringPollLoop } from "../src/index.js";
import type { RunEvent } from "../src/types.js";

type ControlMessage = { id: string; body: string; kind?: string };

// The shape the steer route's ack accepts, built the way newId("evt") builds it.
const ackable = (suffix: string) => `evt_${suffix.padStart(32, "0")}`;

// Stands in for the steer route: it records delivery from the ack, serves
// whatever is still pending, and answers the moment anything is — so a message
// that never reaches the ack is served again on every poll. That is the shape
// the loop has to pace itself against.
function fakeControlPlane(rows: ControlMessage[]) {
  const pending = [...rows];
  return {
    add(row: ControlMessage) {
      pending.push(row);
    },
    poll(ack: string[]) {
      for (const id of ack) {
        const index = pending.findIndex((row) => row.id === id);
        if (index >= 0) pending.splice(index, 1);
      }
      return [...pending];
    },
  };
}

function harness(options: {
  poll: (ack: string[], poll: number) => ControlMessage[] | Promise<ControlMessage[]>;
  polls: number;
  onSteer?: (body: string) => Promise<void>;
  onInterrupt?: () => Promise<void>;
  random?: () => number;
}) {
  const acks: string[][] = [];
  const sleeps: number[] = [];
  const steers: string[] = [];
  const events: RunEvent[] = [];
  const interrupts: number[] = [];
  let polls = 0;
  const done = steeringPollLoop({
    poll: async (ack) => {
      acks.push([...ack]);
      polls += 1;
      return await options.poll(ack, polls);
    },
    handlers: {
      appendSteer: async (body) => {
        steers.push(body);
        await options.onSteer?.(body);
      },
      emit: async (batch) => {
        events.push(...batch);
      },
      interrupt: async () => {
        interrupts.push(polls);
        await options.onInterrupt?.();
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    isStopped: () => polls >= options.polls,
    random: options.random ?? (() => 0),
  });
  return { done, acks, sleeps, steers, events, interrupts };
}

describe("steering poll pacing", () => {
  it("backs off when a served batch reaches the ack with nothing new", async () => {
    // An interrupt is never retired, so a kill that keeps throwing leaves the row
    // pending for the rest of the run and the route serves it on every poll.
    const control = fakeControlPlane([{ id: ackable("a1"), kind: "interrupt", body: "" }]);
    const run = harness({
      polls: 4,
      poll: (ack) => control.poll(ack),
      onInterrupt: async () => {
        throw new Error("engine already gone");
      },
    });

    await run.done;

    expect(run.acks).toEqual([[], [], [], []]);
    // Bounded exponential pacing, with the jitter pinned by random() === 0.
    expect(run.sleeps).toEqual([500, 1_000, 2_000, 4_000]);
    // The interrupt is still retried on every poll — pacing the channel must not
    // retire an operator's stop.
    expect(run.interrupts).toEqual([1, 2, 3, 4]);
  });

  it("keeps the stalled backoff bounded however long the message stays pending", async () => {
    const control = fakeControlPlane([{ id: ackable("a2"), kind: "interrupt", body: "" }]);
    const run = harness({
      polls: 8,
      poll: (ack) => control.poll(ack),
      // The top of the jitter window, so each delay is the whole window.
      random: () => 1,
      onInterrupt: async () => {
        throw new Error("engine already gone");
      },
    });

    await run.done;

    expect(run.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000]);
  });

  it("does not delay a poll whose message was handled", async () => {
    // Interrupt latency is the reason this channel exists, so the ordinary path
    // re-polls immediately.
    const control = fakeControlPlane([]);
    const run = harness({
      polls: 3,
      poll: (ack, poll) => {
        control.add({ id: ackable(`${poll}`), body: `steer ${poll}` });
        return control.poll(ack);
      },
    });

    await run.done;

    expect(run.sleeps).toEqual([]);
    expect(run.acks).toEqual([[], [ackable("1")], [ackable("2")]]);
    expect(run.steers).toEqual(["steer 1", "steer 2", "steer 3"]);
  });

  it("does not pace a poll the route answered with nothing", async () => {
    const run = harness({ polls: 3, poll: () => [] });

    await run.done;

    // An empty answer already cost the route's own long-poll window.
    expect(run.sleeps).toEqual([]);
  });

  it("reports the degraded window once the transport comes back", async () => {
    const control = fakeControlPlane([{ id: ackable("a3"), body: "tighten the diff" }]);
    const run = harness({
      polls: 3,
      poll: (ack, poll) => {
        if (poll === 1) throw new Error("ECONNREFUSED");
        return control.poll(ack);
      },
    });

    await run.done;

    expect(run.sleeps[0]).toBe(5_000);
    expect(run.events).toContainEqual({
      type: "artifact_error",
      data: { kind: "steer_poll_degraded", failures: 1 },
    });
    expect(run.steers).toEqual(["tighten the diff"]);
  });
});

describe("steer ack id filtering", () => {
  it("accepts only the shape the steer route's ack accepts", () => {
    expect(
      ackableSteerIds([
        ackable("ab"),
        // Too short, wrong prefix, uppercase hex, and an id carrying the
        // separator the runner encodes ids with.
        "evt_",
        `run_${"a".repeat(32)}`,
        `evt_${"A".repeat(32)}`,
        `${ackable("ab")},evt_second`,
        `${ackable("ab")}&ack=evt_second`,
      ]),
    ).toEqual([ackable("ab")]);
  });

  it("matches the shape the route enforces, read from the route itself", () => {
    // The wedge this filter closes is a disagreement between the two shapes, so
    // the route's own literal is the only honest thing to compare against.
    const route = readFileSync(
      new URL("../../services/api/src/routes/internal.ts", import.meta.url),
      "utf8",
    );
    const declared = /^(?:export )?const ACK_ID = (\/.+\/);$/m.exec(route);
    // A route that stopped declaring the shape this way fails here rather than
    // passing on an undefined match: the filter would then be guarding against
    // a rule nobody can point at.
    expect(declared?.[1]).toBe(String(ACKABLE_STEER_ID));
  });

  it("keeps the channel alive when a served id cannot be acked", async () => {
    // Nothing writes a steer row with an id of another shape today; a row that
    // had one would make every ack this runner sends get refused whole, and the
    // channel would be dead for the rest of the run.
    const legacy = { id: "steer_legacy", body: "read the runbook" };
    const control = fakeControlPlane([legacy]);
    const run = harness({
      polls: 4,
      poll: (ack, poll) => {
        if (poll === 3) control.add({ id: ackable("b2"), body: "tighten the diff" });
        return control.poll(ack);
      },
    });

    await run.done;

    // The unackable id never reaches the ack, so the ack that carries the good
    // message is accepted instead of being refused along with it.
    expect(run.acks).toEqual([[], [], [], [ackable("b2")]]);
    // Its durable action landed once. Since the route keeps serving it, applying
    // it again on every poll would append the same body to the steer file for the
    // rest of the run, so it is applied once and then skipped locally.
    expect(run.steers).toEqual(["read the runbook", "tighten the diff"]);
    // Not silent: reported once, not once per redelivery.
    expect(
      run.events.filter(
        (event) => (event.data as { kind?: string })?.kind === "steer_ack_id_unacceptable",
      ),
    ).toEqual([
      { type: "artifact_error", data: { kind: "steer_ack_id_unacceptable", id: "steer_legacy" } },
    ]);
    // Paced, not spun: the two polls that ended with nothing acked backed off,
    // and the poll that acked the good message did not.
    expect(run.sleeps).toEqual([500, 1_000, 500]);
  });

  it("re-applies an interrupt whose id cannot be acked", async () => {
    // An operator's stop must not be dropped for the shape of an id, and the
    // handler absorbs a repeat: it re-sets the flag and starts the escalation
    // only while none is pending.
    const control = fakeControlPlane([{ id: "int_legacy", kind: "interrupt", body: "" }]);
    const run = harness({ polls: 3, poll: (ack) => control.poll(ack) });

    await run.done;

    expect(run.interrupts).toEqual([1, 2, 3]);
    expect(run.acks).toEqual([[], [], []]);
    expect(
      run.events.filter(
        (event) => (event.data as { kind?: string })?.kind === "steer_ack_id_unacceptable",
      ),
    ).toHaveLength(1);
  });
});
