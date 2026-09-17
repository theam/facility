import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const loadDotenv = vi.hoisted(() => vi.fn());
vi.mock("dotenv", () => ({ config: loadDotenv }));

describe("seed environment loading", () => {
  // Regression for #373: `pnpm --filter @facility/db seed` runs with cwd=packages/db,
  // so seed must resolve the repository .env explicitly like migrate does.
  it("loads the repository .env regardless of the working directory", async () => {
    await import("../src/seed.js");
    expect(loadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({ path: join(import.meta.dirname, "../../..", ".env") }),
    );
  });
});
