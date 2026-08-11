import { describe, expect, it } from "vitest";
import { claudeOAuthRequestProblem, providerRequestHeaders } from "../src/provider-auth.js";

const oauthIncoming = {
  authorization: "Bearer fvk_00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "user-agent": "claude-cli/test",
};

describe("provider authentication transport", () => {
  it("swaps a virtual OAuth bearer for the sealed upstream token", () => {
    const headers = providerRequestHeaders(
      "anthropic",
      oauthIncoming,
      {
        authMode: "oauth",
        secret: "real-claude-oauth",
        baseUrl: "https://api.anthropic.com/v1",
      },
      Buffer.from("{}"),
    );

    expect(headers.get("authorization")).toBe("Bearer real-claude-oauth");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("x-app")).toBe("cli");
    expect([...headers.values()].join(" ")).not.toContain("fvk_");
  });

  it("keeps API-key transport unchanged", () => {
    const headers = providerRequestHeaders(
      "anthropic",
      { "anthropic-version": "2023-06-01" },
      { authMode: "api_key", secret: "real-api-key", baseUrl: "https://api.anthropic.com/v1" },
      Buffer.from("{}"),
    );
    expect(headers.get("x-api-key")).toBe("real-api-key");
    expect(headers.get("authorization")).toBeNull();
  });

  it.each([
    {
      name: "project virtual key",
      key: { runId: null, engine: null },
      headers: oauthIncoming,
    },
    {
      name: "non-Claude engine",
      key: { runId: "run_1", engine: "codex" },
      headers: oauthIncoming,
    },
    {
      name: "API-key-shaped request",
      key: { runId: "run_1", engine: "claude_code" },
      headers: { ...oauthIncoming, authorization: undefined, "x-api-key": "fvk_test" },
    },
    {
      name: "missing OAuth beta",
      key: { runId: "run_1", engine: "claude_code" },
      headers: { ...oauthIncoming, "anthropic-beta": "claude-code-20250219" },
    },
  ])("rejects a $name from using a subscription credential", ({ key, headers }) => {
    expect(claudeOAuthRequestProblem(key, headers)).not.toBeNull();
  });

  it("accepts only the run-scoped Claude Code OAuth request shape", () => {
    expect(
      claudeOAuthRequestProblem({ runId: "run_1", engine: "claude_code" }, oauthIncoming),
    ).toBeNull();
  });
});
