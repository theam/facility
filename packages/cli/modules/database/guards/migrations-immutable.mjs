// facility module: database
//
// Applied migrations are immutable. This guard fails when a commit range
// modifies or deletes an existing migration file instead of adding a new one.
// In CI it diffs against the PR base; locally it diffs against the merge-base
// with the default branch.
import { execFileSync } from "node:child_process";

// Directories that hold ordered migration files. Adjust to your stack.
const MIGRATION_DIRS = [
  "migrations/",
  "supabase/migrations/",
  "db/migrations/",
  "prisma/migrations/",
];

// key: "<path>", value: written reason (e.g. "squashed baseline, 2026-01").
const ALLOWLIST = {};

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export default {
  name: "migrations-immutable",
  description: "existing migration files are never edited or deleted, only added",
  run() {
    const base =
      process.env.GITHUB_BASE_SHA ||
      git(["merge-base", "HEAD", `origin/${process.env.DEFAULT_BRANCH || "main"}`]) ||
      git(["merge-base", "HEAD", "main"]);
    if (!base) return []; // shallow clone or fresh repo — nothing to compare against

    const out = git(["diff", "--name-status", base, "HEAD"]);
    const violations = [];
    for (const row of out.split("\n").filter(Boolean)) {
      const [status, ...paths] = row.split("\t");
      const path = paths[paths.length - 1];
      if (!MIGRATION_DIRS.some((dir) => path.startsWith(dir))) continue;
      if (status.startsWith("M") || status.startsWith("D") || status.startsWith("R")) {
        if (ALLOWLIST[path]) continue;
        violations.push({
          file: path,
          message: `migration ${status.startsWith("D") ? "deleted" : "modified"} — migrations are append-only; write a new one`,
        });
      }
    }
    return violations;
  },
};
