import { describe, expect, it } from "vitest";
import { escapeRegExp, yamlQuotedScalar } from "../src/escaping.js";

describe("escaping", () => {
  it("escapes regex metacharacters in branch names", () => {
    expect(escapeRegExp("release/2026")).toBe("release\\/2026");
  });

  it("quotes YAML list scalars safely", () => {
    expect(yamlQuotedScalar("CI: Build")).toBe('"CI: Build"');
  });
});
