import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads a wire fixture shared with the core contract tests. It is read when the
 * test runs instead of imported, so the web production build, which type-checks
 * this folder without the core package, does not depend on core test files.
 */
export function coreFixture<T>(name: string): T {
  const directory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/core/test/fixtures",
  );
  return JSON.parse(readFileSync(resolve(directory, name), "utf8")) as T;
}
