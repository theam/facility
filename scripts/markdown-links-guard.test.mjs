import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { resolveWithinRoot } from "../guards/markdown-links.mjs";

// `git rev-parse --show-toplevel` reports POSIX separators on every platform,
// so on Windows the guard receives `C:/repo` while `path.resolve` produces
// `C:\repo`. Comparing the two without normalising rejected every in-repo
// target, and the guard reported all 56 local links in this repository as
// missing on Windows.
test("a git-reported Windows root resolves in-repo targets", () => {
  assert.equal(
    resolveWithinRoot("C:/projects/facility", "README.md", "SECURITY.md", win32),
    "C:\\projects\\facility\\SECURITY.md",
  );
  assert.equal(
    resolveWithinRoot("C:/projects/facility", "apps/docs/docs/faq.md", "../index.md", win32),
    "C:\\projects\\facility\\apps\\docs\\index.md",
  );
});

test("a native Windows root keeps working", () => {
  assert.equal(
    resolveWithinRoot("C:\\projects\\facility", "README.md", "LICENSE", win32),
    "C:\\projects\\facility\\LICENSE",
  );
});

test("POSIX roots are unaffected", () => {
  assert.equal(
    resolveWithinRoot("/srv/facility", "README.md", "SECURITY.md", posix),
    "/srv/facility/SECURITY.md",
  );
  assert.equal(
    resolveWithinRoot("/srv/facility", "docs/README.md", "testing.md", posix),
    "/srv/facility/docs/testing.md",
  );
});

test("targets escaping the repository are still rejected on both platforms", () => {
  assert.equal(resolveWithinRoot("C:/projects/facility", "README.md", "../outside.md", win32), null);
  assert.equal(resolveWithinRoot("/srv/facility", "README.md", "../outside.md", posix), null);
  assert.equal(
    resolveWithinRoot("/srv/facility", "README.md", "../facility-sibling/x.md", posix),
    null,
  );
});

test("the repository root itself is inside the repository", () => {
  assert.equal(resolveWithinRoot("C:/projects/facility", "README.md", ".", win32), "C:\\projects\\facility");
  assert.equal(resolveWithinRoot("/srv/facility", "README.md", ".", posix), "/srv/facility");
});
