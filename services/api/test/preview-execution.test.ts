import { expect, it } from "vitest";
import { previewExecutionAuthorizer } from "../src/stories/preview-execution.js";

it.each(["user", "key"])("accepts a current %s delegation", (type) => {
  expect(previewExecutionAuthorizer(2, { revision: 2, actor: { type, id: "principal" } })).toEqual({
    type,
    id: "principal",
  });
});
it.each([
  null,
  {},
  { revision: 1, actor: { type: "user", id: "principal" } },
  { revision: 2, actor: { type: "service", id: "principal" } },
  { revision: 2, actor: { type: "key", id: "" } },
  { revision: 2, actor: { type: "user", id: 42 } },
  { revision: 2, actor: null },
])("denies stale or malformed grants: %j", (grant) => {
  expect(previewExecutionAuthorizer(2, grant)).toBeNull();
});
