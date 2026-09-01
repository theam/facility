import { newId } from "@facility/core";
import { describe, expect, it } from "vitest";
import { STEER_ACK_MAX, STEER_BATCH, SteerAck } from "../src/routes/internal.js";

// The steer poll's own tests drive this validation through a live route, where a
// rejected list is observable only as a 400. These exercise the schema itself, so
// the boundary between "an id this route could have issued" and everything else
// is pinned to the validator rather than to what the surrounding query does with
// what it is handed.
describe("steer acknowledgment ids", () => {
  it("normalizes the shapes a poll can arrive in", () => {
    const first = newId("evt");
    const second = newId("evt");
    // The parameter absent, which is the poll of a runner that predates the ack.
    // The route tells that protocol from the current one by presence alone, so
    // absence has to survive the transform instead of collapsing into a list.
    expect(SteerAck.parse(undefined)).toBeUndefined();
    // The parameter present and empty: an acknowledgment naming no row, which is
    // what a runner sends whenever the last batch left it nothing to name.
    expect(SteerAck.parse("")).toEqual([]);
    expect(SteerAck.parse(first)).toEqual([first]);
    expect(SteerAck.parse(`${first},${second}`)).toEqual([first, second]);
    // A repeated query parameter arrives as an array, and each entry may still
    // carry a comma-separated list of its own.
    expect(SteerAck.parse([first, second])).toEqual([first, second]);
    expect(SteerAck.parse([`${first},${second}`])).toEqual([first, second]);
  });

  it("accepts a list at the bound and refuses one past it", () => {
    const ids = Array.from({ length: STEER_ACK_MAX }, () => newId("evt"));
    expect(SteerAck.parse(ids.join(","))).toEqual(ids);
    expect(SteerAck.safeParse([...ids, newId("evt")].join(",")).success).toBe(false);
  });

  it("keeps a whole served batch inside the acknowledgment bound", () => {
    // A runner acknowledges the ids of one batch in one request, so a batch
    // larger than the bound would be refused whole every time. The runner re-sends
    // an unrecorded ack unchanged, so that refusal would repeat for the rest of
    // the run and no row would ever be retired, with no error surfaced anywhere.
    expect(STEER_BATCH).toBeLessThanOrEqual(STEER_ACK_MAX);
  });

  it("refuses a list carrying anything this route could not have issued", () => {
    const valid = newId("evt");
    const malformed = [
      `,${valid}`, // an entry that names no row at all: only a wholly empty
      `${valid},,${valid}`, // parameter is the empty ack, an empty entry is not
      "evt_z", // the prefix with no id behind it
      "not-an-id",
      `${valid}x`, // a real id with a suffix
      valid.toUpperCase(),
      valid.replace("evt_", "run_"), // an id of another kind, right length
      `${valid},evt_z`, // one bad entry refuses the whole list
      `${valid}, ${valid}`, // entries are not trimmed, so a spaced list is refused
    ];
    for (const ack of malformed) {
      expect(SteerAck.safeParse(ack).success).toBe(false);
    }
  });
});
