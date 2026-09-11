import { describe, expect, it } from "vitest";
import { readAgentCatalogFiles } from "../src/agents/catalog-files.js";

const failure = (status: number) => Object.assign(new Error("GitHub unavailable"), { status });

function fixture() {
  const calls: string[] = [];
  const contents = new Map<string, unknown>([
    [
      ".agents",
      [
        { type: "file", path: ".agents/builder.md" },
        { type: "file", path: ".agents/README.md" },
      ],
    ],
    [
      ".agents/builder.md",
      { type: "file", encoding: "base64", content: Buffer.from("builder").toString("base64") },
    ],
    [".claude/skills", [{ type: "dir", path: ".claude/skills/review" }]],
    [
      ".claude/skills/review",
      [
        { type: "file", path: ".claude/skills/review/SKILL.md" },
        { type: "file", path: ".claude/skills/review/large-reference.txt" },
        { type: "dir", path: ".claude/skills/review/nested" },
      ],
    ],
    [".claude/skills/review/SKILL.md", { type: "file", content: "review" }],
    [
      ".claude/skills/review/nested",
      [{ type: "file", path: ".claude/skills/review/nested/SKILL.md" }],
    ],
    [".claude/skills/review/nested/SKILL.md", { type: "file", content: "nested review" }],
  ]);
  return {
    calls,
    contents,
    client: {
      getContent: async (path: string, ref: string) => {
        expect(ref).toBe("a".repeat(40));
        calls.push(path);
        const value = contents.get(path);
        if (value instanceof Error) throw value;
        if (value === undefined) throw failure(404);
        return value;
      },
    },
  };
}

describe("complete agent catalog reads", () => {
  it("reads manifests and nested skills at one commit without downloading support files", async () => {
    const f = fixture();
    expect(await readAgentCatalogFiles(f.client, "a".repeat(40))).toEqual(
      new Map([
        [".agents/builder.md", "builder"],
        [".claude/skills/review/SKILL.md", "review"],
        [".claude/skills/review/nested/SKILL.md", "nested review"],
      ]),
    );
    expect(f.calls).not.toContain(".agents/README.md");
    expect(f.calls).not.toContain(".claude/skills/review/large-reference.txt");
  });

  it("accepts missing optional roots as an empty catalog", async () => {
    const f = fixture();
    f.contents.clear();
    expect(await readAgentCatalogFiles(f.client, "a".repeat(40))).toEqual(new Map());
  });

  it.each([
    401, 403, 429, 500,
  ])("rejects a failed root read (%s) instead of returning an empty snapshot", async (status) => {
    const f = fixture();
    f.contents.set(".agents", failure(status));
    await expect(readAgentCatalogFiles(f.client, "a".repeat(40))).rejects.toMatchObject({ status });
  });

  it.each([
    401, 403, 404, 429, 500,
  ])("rejects partial child reads (%s) instead of deleting existing skills", async (status) => {
    const f = fixture();
    f.contents.set(".claude/skills/review/SKILL.md", failure(status));
    await expect(readAgentCatalogFiles(f.client, "a".repeat(40))).rejects.toMatchObject({ status });
  });

  it.each([
    { response: [{ type: "file", path: "../other-tenant/secret" }] },
    { response: [{ type: "file" }] },
    { response: [{ type: "dir", path: ".agents/.." }] },
    { response: { type: "file", content: "unexpected root" } },
  ])("rejects malformed catalog directory responses", async ({ response }) => {
    const f = fixture();
    f.contents.set(".agents", response);
    await expect(readAgentCatalogFiles(f.client, "a".repeat(40))).rejects.toThrow(
      "Invalid agent catalog",
    );
  });

  it("rejects a directory masquerading as an agent manifest", async () => {
    const f = fixture();
    f.contents.set(".agents/builder.md", []);
    await expect(readAgentCatalogFiles(f.client, "a".repeat(40))).rejects.toThrow(
      "Invalid agent catalog file",
    );
  });

  it("rejects incomplete file responses", async () => {
    const f = fixture();
    f.contents.set(".agents/builder.md", { type: "file" });
    await expect(readAgentCatalogFiles(f.client, "a".repeat(40))).rejects.toThrow(
      "Incomplete agent catalog file",
    );
  });
});
