import { describe, expect, it } from "vitest";
import { reservationFits } from "../src/insights/costs.js";

describe("budget reservation admission", () => {
  it("admits a hold that lands exactly on the cap", () => {
    expect(reservationFits(10, 5, 15)).toBe(true);
  });

  it("rejects a hold that would pass the cap", () => {
    expect(reservationFits(10, 6, 15)).toBe(false);
  });

  it("rejects another hold once spend has already reached the cap", () => {
    expect(reservationFits(15, 0, 15)).toBe(false);
    expect(reservationFits(0, 0, 0)).toBe(false);
  });

  it("admits a zero estimate while spend is still under the cap", () => {
    expect(reservationFits(0, 0, 1)).toBe(true);
  });
});
