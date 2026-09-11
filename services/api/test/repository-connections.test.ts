import { describe, expect, it } from "vitest";
import { repositoryRemovalBlocker } from "../src/github/repository-connections.js";

describe("repository removal policy", () => {
  it("allows a repository without durable dependencies", () => {
    expect(repositoryRemovalBlocker(false, false)).toBeNull();
  });
  it.each([false, true])("preserves retained stories with workspaces=%s", (workspaces) => {
    expect(repositoryRemovalBlocker(true, workspaces)).toContain("retained Facility stories");
  });
  it("protects related checkouts even without a direct repository story", () => {
    expect(repositoryRemovalBlocker(false, true)).toContain("retained workspaces");
  });
});
