// A documented CLI flag that the real parser silently rejects is not a typo
// a reader notices — it fails at runtime with "Unknown option", after
// someone already shipped an issue, a review comment, or a support answer
// built on the doc. This guard reads the flag tables published in
// apps/docs/docs/reference/cli.md and the flag allowlist inside
// `validateLocalFlags` in packages/cli/src/cli.mjs, and fails when a
// documented flag is missing from the real allowlist for that command.
//
// Scope: only the `| Flag | Purpose |` table cells under a `## `facility
// <command>`` heading in cli.md are parsed — never README.md or free-flowing
// prose. Facility's own flag values routinely embed other tools' flags as
// literal strings, e.g. `--provision='pnpm install --frozen-lockfile'` and
// `--preview-readiness-command='curl --fail http://localhost:3000/health'`
// in README.md. A generic `--\w+` scan over prose would misread those as
// documented Facility flags and fail on tools this repository does not own.
// The structured table has no such embedded values in its cells.
import { readText } from "./_kit.mjs";

const CLI_DOC = "apps/docs/docs/reference/cli.md";
const CLI_SOURCE = "packages/cli/src/cli.mjs";

/** Flags documented in cli.md's `| Flag | Purpose |` tables, by command. */
export function documentedFlags(markdown) {
  const byCommand = new Map();
  let command = null;
  markdown.split("\n").forEach((line, index) => {
    const heading = line.match(/^## `facility ([a-z]+)/);
    if (heading) {
      command = heading[1];
      return;
    }
    if (!command || !line.startsWith("|")) return;
    if (/^\|\s*-+\s*\|/.test(line) || /^\|\s*Flag\s*\|/i.test(line)) return;

    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`--([a-z0-9-]+)(?:=[^`]*)?`/g)) {
      if (!byCommand.has(command)) byCommand.set(command, []);
      byCommand.get(command).push({ flag: match[1], line: index + 1 });
    }
  });
  return byCommand;
}

/** The real per-command flag allowlist, read out of cli.mjs's own source. */
export function realFlags(source, command) {
  const match = source.match(new RegExp(`\\b${command}:\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!match) return null;
  return new Set([...match[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
}

export default {
  name: "documented-cli-flags",
  description: "CLI flags documented in cli.md exist in the real flag allowlist",
  run() {
    const markdown = readText(CLI_DOC);
    const source = readText(CLI_SOURCE);
    if (!markdown) return [{ file: CLI_DOC, message: "expected file not found" }];
    if (!source) return [{ file: CLI_SOURCE, message: "expected file not found" }];

    const violations = [];
    for (const [command, flags] of documentedFlags(markdown)) {
      const allowlist = realFlags(source, command);
      if (!allowlist) {
        violations.push({
          file: CLI_SOURCE,
          message: `cli.md documents \`facility ${command}\` but validateLocalFlags has no allowlist for it`,
        });
        continue;
      }
      for (const { flag, line } of flags) {
        if (!allowlist.has(flag)) {
          violations.push({
            file: CLI_DOC,
            line,
            message: `--${flag} is documented for \`facility ${command}\` but is not in the real flag allowlist (packages/cli/src/cli.mjs)`,
          });
        }
      }
    }
    return violations;
  },
};
