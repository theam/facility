import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web favicon", () => {
  it("uses the canonical Facility mark", async () => {
    const [favicon, mark] = await Promise.all([
      readFile(new URL("../app/icon.svg", import.meta.url), "utf8"),
      readFile(new URL("../../../assets/mark.svg", import.meta.url), "utf8"),
    ]);

    expect(favicon).toBe(mark);
  });
});
