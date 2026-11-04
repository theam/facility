import type { WorkspaceCommand } from "./runtime.js";

const GIT_TEXT_INPUT = `input="$1"; shift
exec git "$@" <<FACILITY_PREVIEW_GIT_INPUT
$input
FACILITY_PREVIEW_GIT_INPUT
`;

/** Small Git control records travel as literal argv, including on providers without stdin. */
export function previewGitCommand(
  args: string[],
  input?: string,
): Pick<WorkspaceCommand, "command" | "args"> {
  if (input === undefined) return { command: "git", args };
  if (!input.endsWith("\n") || input.includes("\0")) {
    throw new Error("Preview Git input must be newline-terminated text");
  }
  // The here-document supplies the final newline; exec preserves Git's exit and signal target.
  return {
    command: "sh",
    args: ["-c", GIT_TEXT_INPUT, "facility-preview-git", input.slice(0, -1), ...args],
  };
}
