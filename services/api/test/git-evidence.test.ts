import { describe, expect, it } from "vitest";
import { parseGitLog, parseNameStatus } from "../src/turns/git-evidence.js";

describe("turn Git evidence parsing", () => {
  it("parses bounded commit metadata without depending on localized Git output", () => {
    expect(
      parseGitLog(
        [
          "a".repeat(40),
          "Ada Lovelace",
          "2026-09-04T10:00:00+00:00",
          "feat: record delivery evidence\x1e",
        ].join("\x1f"),
      ),
    ).toEqual([
      {
        sha: "a".repeat(40),
        author: "Ada Lovelace",
        authoredAt: "2026-09-04T10:00:00+00:00",
        subject: "feat: record delivery evidence",
      },
    ]);
  });

  it("preserves rename provenance and ordinary changed paths", () => {
    expect(parseNameStatus("M\0src/app.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { status: "M", path: "src/app.ts" },
      { status: "R100", path: "new.ts", previousPath: "old.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });
});
