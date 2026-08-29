import { describe, expect, it } from "vitest";
import { chainIdFromConfig, groupSections, type KbEntry, typeLabelFor, typeLabelsFor } from "./kb";

const learning: KbEntry = {
  id: "kb_l001",
  type: "L",
  number: 1,
  slug: "session-lesson",
  frontmatter: { id: "L001", type: "L" },
  bodyMd: "body",
  status: null,
  supersedes: null,
};

describe("KB type labels", () => {
  it("follows the selected chain for L", () => {
    expect(chainIdFromConfig({ chain: "product" })).toBe("product");
    expect(chainIdFromConfig({ chain: "research" })).toBe("research");
    expect(chainIdFromConfig({})).toBe("research");

    expect(typeLabelFor("L", "product")).toBe("learning");
    expect(typeLabelFor("L", "research")).toBe("literature");
    expect(typeLabelsFor("product").L).toBe("learnings");
    expect(typeLabelsFor("research").L).toBe("literature");

    expect(groupSections([learning], "product").find((section) => section.key === "L")?.label).toBe(
      "learnings",
    );
    expect(
      groupSections([learning], "research").find((section) => section.key === "L")?.label,
    ).toBe("literature");
  });
});
