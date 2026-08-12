import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineIdentity, modelIdentity, modelProductLabel, providerIdentity } from "./ai-identity";

describe("AI identity display", () => {
  it("humanizes known platform identifiers", () => {
    expect(engineIdentity("claude_code")).toEqual({ brand: "claude", label: "Claude Code" });
    expect(modelIdentity("claude-sonnet-5")).toEqual({
      brand: "claude",
      label: "Claude Sonnet 5",
    });
    expect(modelIdentity("claude-sonnet-4-6")).toEqual({
      brand: "claude",
      label: "Claude Sonnet 4.6",
    });
    expect(modelIdentity("claude-haiku-4-5-20251001")).toEqual({
      brand: "claude",
      label: "Claude Haiku 4.5",
    });
    expect(modelIdentity("gpt-5.6-sol")).toEqual({ brand: "openai", label: "GPT-5.6 Sol" });
    expect(providerIdentity("openai")).toEqual({ brand: "openai", label: "OpenAI" });
  });

  it("preserves user-defined engine, model, and provider names exactly", () => {
    expect(engineIdentity("Adrián's runner")).toEqual({
      brand: null,
      label: "Adrián's runner",
    });
    expect(modelIdentity("team_model-v2")).toEqual({ brand: null, label: "team_model-v2" });
    expect(providerIdentity("local gateway")).toEqual({
      brand: null,
      label: "local gateway",
    });
  });

  it("removes a redundant Claude prefix when the engine already carries the brand", () => {
    expect(modelProductLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelProductLabel("claude-fable-5")).toBe("Fable 5");
    expect(modelProductLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelProductLabel("team_model-v2")).toBe("team_model-v2");
  });

  it("keeps the official vendor assets byte-identical", () => {
    const digest = (path: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(path, import.meta.url)))
        .digest("hex");

    expect(digest("../public/brands/claude.svg")).toBe(
      "059e22f525d67c6258c4f64514f0b0e717c914df8a706936d0299d5e6b8082d9",
    );
    expect(digest("../public/brands/openai.svg")).toBe(
      "01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285",
    );
  });
});
