import { expect, it } from "vitest";
import { requirePermissions } from "../src/auth/required-permissions.js";

it.each([
  ["projects:write"],
  ["github:write"],
  [],
])("denies a partial privileged grant %j", (...permissions) => {
  expect(() => requirePermissions({ permissions }, ["projects:write", "github:write"])).toThrow(
    "Requires projects:write and github:write",
  );
});
it.each([
  ["projects:write", "github:write"],
  ["projects:*", "github:*"],
  ["*"],
])("accepts complete wildcard or explicit grants %j", (...permissions) => {
  expect(() =>
    requirePermissions({ permissions }, ["projects:write", "github:write"]),
  ).not.toThrow();
});
