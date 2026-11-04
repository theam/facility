import { describe, expect, it } from "vitest";
import { leavesOwnerRole } from "../src/routes/v1/me-members-roles.js";

describe("last-owner role policy", () => {
  it.each([
    ["viewer"],
    ["maintainer"],
    [undefined],
  ])("treats moving an owner to %s as leaving the owner role", (nextRole) => {
    expect(leavesOwnerRole("owner", nextRole)).toBe(true);
  });

  it.each([
    ["owner", "owner"],
    [undefined, "viewer"],
    [undefined, "owner"],
    ["viewer", "maintainer"],
    ["maintainer", undefined],
  ])("does not require another owner for %s -> %s", (currentRole, nextRole) => {
    expect(leavesOwnerRole(currentRole, nextRole)).toBe(false);
  });
});
