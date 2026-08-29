import { describe, expect, it } from "vitest";
import {
  chainFromConfig,
  entriesStrandedByChain,
  productChain,
  researchChain,
} from "../src/index.js";

function stored(type: string, number = 1) {
  const id = `${type}${String(number).padStart(3, "0")}`;
  return {
    id: `row-${id}`,
    type,
    number,
    slug: "slug",
    frontmatter: { id, aliases: [id], type, created: "2026-01-01" },
    bodyMd: "## Links\n",
  };
}

describe("entriesStrandedByChain", () => {
  it("reproduces the orphan: the research default, then a switch to product", () => {
    // A space stored with an empty config runs the research chain, so agents
    // legitimately write H/E/F/L under it. Resolving {"chain":"product"} for
    // the same space retains the shared L type, but leaves H/E/F undeclared.
    const written = [stored("H"), stored("E"), stored("L")];
    expect(chainFromConfig({}).id).toBe("research");
    expect(entriesStrandedByChain(written, chainFromConfig({}))).toEqual([]);
    expect(entriesStrandedByChain(written, chainFromConfig({ chain: "product" }))).toEqual([
      { entryId: "row-H001", artifactId: "H001", type: "H" },
      { entryId: "row-E001", artifactId: "E001", type: "E" },
    ]);
  });

  it("strands in the other direction too", () => {
    // Product artifacts are just as undeclared under the research chain.
    const written = [stored("S"), stored("D"), stored("T", 2)];
    expect(entriesStrandedByChain(written, productChain)).toEqual([]);
    expect(entriesStrandedByChain(written, researchChain).map((item) => item.artifactId)).toEqual([
      "S001",
      "D001",
      "T002",
    ]);
  });

  it("reports only the undeclared entries, by their artifact id", () => {
    const mixed = [stored("H"), stored("R")];
    expect(entriesStrandedByChain(mixed, productChain)).toEqual([
      { entryId: "row-H001", artifactId: "H001", type: "H" },
    ]);
    expect(entriesStrandedByChain([], productChain)).toEqual([]);
  });
});
