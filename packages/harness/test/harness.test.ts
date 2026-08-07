import { expect, it } from "vitest";
import { productChain, researchChain } from "../src/chain.js";
import { buildHarnessBundle } from "../src/session.js";
import { validate } from "../src/validate.js";
import { rankByWsjf, wsjfScore } from "../src/wsjf.js";

const created = "2026-07-03";

function entry(overrides: Partial<Parameters<typeof validate>[0]["entries"][number]>) {
  const type = overrides.type ?? "H";
  const number = overrides.number ?? 1;
  const id = `${type}${String(number).padStart(3, "0")}`;
  return {
    id: `row-${id}`,
    type,
    number,
    slug: "slug",
    frontmatter: { id, aliases: [id], type, created, tags: [], ...(overrides.frontmatter ?? {}) },
    bodyMd: `Body\n\n## Links\n\n- [[${id}]]\n`,
    ...overrides,
  };
}

it("enforces chain, frontmatter, backlinks, aliases, and links", () => {
  const parent = entry({
    type: "H",
    id: "h",
    bodyMd: "Body\n\n## Links\n\n- [[H001]]\n- [[E001]]\n",
  });
  const child = entry({
    type: "E",
    id: "e",
    bodyMd: "Body\n\n## Links\n\n- [[E001]]\n- [[H001]]\n",
  });
  expect(
    validate({
      space: activeSpace(),
      chain: researchChain,
      entries: [parent, child],
      links: [
        { fromEntry: "e", toEntry: "h" },
        { fromEntry: "h", toEntry: "e" },
      ],
    }).ok,
  ).toBe(true);

  expect(
    validate({
      space: activeSpace(),
      chain: researchChain,
      entries: [child],
      links: [],
    }).errors.map((error) => error.code),
  ).toContain("parent_required");
});

it("validates product task frontmatter", () => {
  const task = entry({
    type: "T",
    id: "t",
    frontmatter: {
      id: "T001",
      aliases: ["T001"],
      type: "T",
      created,
      status: "draft",
      wsjf: { value: 8, time: 5, risk: 3, effort: 2 },
    },
  });
  const report = validate({
    space: activeSpace({ config: { chain: "product" } }),
    chain: productChain,
    entries: [task],
    links: [],
    entryId: "t",
    validateSpecials: false,
  });
  expect(report.errors.map((error) => error.code)).toContain("parent_required");
});

it("scores and ranks WSJF", () => {
  expect(wsjfScore({ value: 8, time: 5, risk: 2, effort: 4 })).toBe(3.75);
  expect(
    rankByWsjf([
      { id: "a", wsjf: { value: 1, time: 1, risk: 1, effort: 3 } },
      { id: "b", wsjf: { value: 9, time: 1, risk: 0, effort: 2 } },
    ])[0]?.id,
  ).toBe("b");
});

it("builds session recovery bundle text", () => {
  const bundle = buildHarnessBundle({
    chain: researchChain,
    charterMd: "## Blocked Stop Condition\n",
    activeMd: "## Objective\n\n## Next Step\n\n## Blocker\n\n## Links\n",
    runId: "run_1",
  });
  expect(bundle.files["harness/SESSION.md"]).toContain("Session recovery");
  expect(bundle.files["harness/SESSION.md"]).toContain("ACTIVE is capped");
  expect(bundle.files["harness/TOOLS.md"]).toContain(
    "POST $FACILITY_API_URL/v1/projects/:projectId/kb/entries?dry=1",
  );
  expect(bundle.files["harness/TOOLS.md"]).not.toContain("localhost");
});

function activeSpace(overrides: Partial<Parameters<typeof validate>[0]["space"]> = {}) {
  return {
    charterMd: "## Blocked Stop Condition\nNone\n",
    activeMd: "## Objective\n\n## Next Step\n\n## Blocker\n\n## Links\n",
    ...overrides,
  };
}
