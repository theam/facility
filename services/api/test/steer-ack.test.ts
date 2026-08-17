import { newId } from "@facility/core";
import { describe, expect, it } from "vitest";
import { STEER_ACK_MAX, SteerAck } from "../src/routes/internal.js";

// The steer poll's own tests drive this validation through a live route, where a
// rejected list is observable only as a 400. These exercise the schema itself, so
// the boundary between "an id this route could have issued" and everything else
// is pinned to the validator rather than to what the surrounding query does with
// what it is handed.
describe("steer acknowledgment ids", () => {
  it("normalizes the shapes a poll can arrive in", () => {
    const first = newId("evt");
    const second = newId("evt");
    // No ack at all is a plain poll: an empty list mutates nothing.
    expect(SteerAck.parse(undefined)).toEqual([]);
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

  it("refuses a list carrying anything this route could not have issued", () => {
    const valid = newId("evt");
    const malformed = [
      "", // an entry that names no row at all
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
