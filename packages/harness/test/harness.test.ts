import { expect, it } from "vitest";
import { productChain, researchChain } from "../src/chain.js";
import { buildHarnessBundle } from "../src/session.js";
import { validate } from "../src/validate.js";
import {
  parseWsjfValueSection,
  rankByWsjf,
  validateWsjf,
  wsjfScore,
  wsjfValueSection,
} from "../src/wsjf.js";

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

it("accepts product learnings", () => {
  const learning = entry({ type: "L", id: "l" });
  const report = validate({
    space: activeSpace({ config: { chain: "product" } }),
    chain: productChain,
    entries: [learning],
    links: [],
    entryId: "l",
    validateSpecials: false,
  });

  expect(report.ok).toBe(true);
  expect(report.errors.map((error) => error.code)).not.toContain("unknown_artifact_type");
});

it("names L as Learning on product and Literature on research", () => {
  expect(productChain.types.L?.name).toBe("Learning");
  expect(researchChain.types.L?.name).toBe("Literature");
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

it("round-trips a WSJF judgement through the issue-body Value section", () => {
  const wsjf = { value: 8, time: 5, risk: 2, effort: 4 };
  const body = `Task body.

${wsjfValueSection(wsjf)}

## KB trace

- task: pot_1
`;
  expect(parseWsjfValueSection(body)).toEqual({ ...wsjf, score: 3.75 });
});

it("treats missing or malformed Value sections as unscored, never as errors", () => {
  expect(parseWsjfValueSection(null)).toBeNull();
  expect(parseWsjfValueSection("Plain hand-written issue body.")).toBeNull();
  expect(parseWsjfValueSection("## Value\n\nno fenced block here")).toBeNull();
  expect(parseWsjfValueSection("## Value\n\n```json\nnot json\n```")).toBeNull();
  expect(
    parseWsjfValueSection('## Value\n\n```json\n{ "value": 1, "time": 1, "risk": 1 }\n```'),
  ).toBeNull();
  expect(
    parseWsjfValueSection(
      '## Value\n\n```json\n{ "value": 1, "time": 1, "risk": 1, "effort": 0 }\n```',
    ),
  ).toBeNull();
  // A fence in a later section is not a Value block.
  expect(
    parseWsjfValueSection(
      '## Value\n\nprose only\n\n## KB trace\n\n```json\n{ "value": 1, "time": 1, "risk": 1, "effort": 1 }\n```',
    ),
  ).toBeNull();
});

it("rejects Value blocks the canonical WSJF schema rejects", () => {
  const body = (wsjf: unknown) => `## Value\n\n\`\`\`json\n${JSON.stringify(wsjf)}\n\`\`\``;
  // Negative and fractional components are not canonical judgements.
  expect(parseWsjfValueSection(body({ value: -8, time: 5, risk: 3, effort: 2 }))).toBeNull();
  expect(parseWsjfValueSection(body({ value: 8, time: 5, risk: 3, effort: -2 }))).toBeNull();
  expect(parseWsjfValueSection(body({ value: 8.5, time: 5, risk: 3, effort: 2 }))).toBeNull();
  // Strings that JSON.parse happily carries are not numbers.
  expect(parseWsjfValueSection(body({ value: "8", time: 5, risk: 3, effort: 2 }))).toBeNull();
  expect(parseWsjfValueSection(body([8, 5, 3, 2]))).toBeNull();
});

it("never yields a non-finite score, whatever the block claims", () => {
  const body = (wsjf: unknown) => `## Value\n\n\`\`\`json\n${JSON.stringify(wsjf)}\n\`\`\``;
  // The canonical schema bounds components to safe integers, so a 1e308
  // numerator never reaches the division.
  expect(parseWsjfValueSection(body({ value: 1e308, time: 1e308, risk: 0, effort: 1 }))).toBeNull();
  // Effort is any positive number: a subnormal divides an honest numerator to
  // Infinity, so the score itself must also be checked.
  expect(parseWsjfValueSection(body({ value: 1, time: 1, risk: 1, effort: 5e-324 }))).toBeNull();
  // JSON has no Infinity literal, but the validator must not depend on that.
  expect(validateWsjf({ value: Number.POSITIVE_INFINITY, time: 0, risk: 0, effort: 1 })).toBeNull();
  expect(() => wsjfScore({ value: 1e308, time: 1e308, risk: 0, effort: 1 })).toThrow(
    "wsjf_score_must_be_finite",
  );
  // A large but finite score survives.
  expect(validateWsjf({ value: 1_000_000, time: 0, risk: 0, effort: 0.001 })).toMatchObject({
    score: 1_000_000_000,
  });
});

it("validates untrusted judgements with the same schema task frontmatter uses", () => {
  expect(validateWsjf({ value: 8, time: 5, risk: 2, effort: 4 })).toEqual({
    value: 8,
    time: 5,
    risk: 2,
    effort: 4,
    score: 3.75,
  });
  expect(validateWsjf(null)).toBeNull();
  expect(validateWsjf("wsjf")).toBeNull();
  expect(validateWsjf({})).toBeNull();
  expect(validateWsjf({ value: 8, time: 5, risk: 2, effort: 0 })).toBeNull();
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
