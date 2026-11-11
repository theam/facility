import { describe, expect, it } from "vitest";
import { previewGitCommand } from "../src/workspaces/preview-git-command.js";

describe("preview Git command transport", () => {
  it("keeps commands without input as direct Git executions", () => {
    expect(previewGitCommand(["rev-parse", "HEAD"])).toEqual({
      command: "git",
      args: ["rev-parse", "HEAD"],
    });
  });

  it("keeps control records and command arguments outside the static shell source", () => {
    const input = "start\noption no-deref\n$HOME `literal` '%s'\ncommit\n\n";
    const command = previewGitCommand(["update-ref", "--stdin"], input);
    expect(command.command).toBe("sh");
    expect(command).not.toHaveProperty("stdin");
    expect(command.args?.slice(2)).toEqual([
      "facility-preview-git",
      input.slice(0, -1),
      "update-ref",
      "--stdin",
    ]);
    expect(command.args?.[1]).toContain('exec git "$@"');
    expect(command.args?.[1]).not.toContain(input);
  });

  it.each(["", "unterminated", "nul\0record\n"])("rejects malformed control input %j", (input) => {
    expect(() => previewGitCommand(["update-ref", "--stdin"], input)).toThrow(
      "Preview Git input must be newline-terminated text",
    );
  });
});
