import { describe, expect, it } from "vitest";
import { parseWorkspaceVariables, WorkspaceVariablesPatch } from "../src/workspaces/variables.js";

describe("workspace variable input", () => {
  it("imports quoted and multiline dotenv values without expanding shell expressions", () => {
    expect(
      parseWorkspaceVariables({
        revision: "",
        dotenv:
          '# comment\nWORKOS_CLIENT_ID="client_example"\nMULTILINE="first\nsecond"\nLITERAL=\'$(whoami) `pwd` $HOME\'\nEMPTY=',
      }),
    ).toEqual({
      revision: "",
      variables: {
        WORKOS_CLIENT_ID: "client_example",
        MULTILINE: "first\nsecond",
        LITERAL: "$(whoami) `pwd` $HOME",
        EMPTY: "",
      },
    });
  });
  it.each([
    "PATH",
    "HOME",
    "NODE_OPTIONS",
    "NODE_AUTH_TOKEN",
    "GIT_CONFIG_COUNT",
    "FACILITY_PREVIEW_GATEWAY_TOKEN",
    "CODEX_HOME",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "LD_PRELOAD",
    "BAD-NAME",
    "__proto__",
  ])("rejects reserved or malformed name %s", (name) => {
    expect(
      WorkspaceVariablesPatch.safeParse({ revision: "", variables: { [name]: "secret" } }).success,
    ).toBe(false);
  });
  it("supports empty values and deletion but rejects NUL, oversized input, and empty imports", () => {
    expect(
      WorkspaceVariablesPatch.parse({ revision: "", variables: { EMPTY: "", REMOVED: null } })
        .variables,
    ).toEqual({ EMPTY: "", REMOVED: null });
    for (const variables of [{ KEY: "a\0b" }, { KEY: "x".repeat(32769) }, {}])
      expect(WorkspaceVariablesPatch.safeParse({ revision: "", variables }).success).toBe(false);
    expect(() => parseWorkspaceVariables({ revision: "", dotenv: "# only a comment" })).toThrow();
  });
});
