import { describe, expect, it } from "vitest";
import { agentHandlesCommand } from "../src/github/agent-routing.js";

describe("agent command routing", () => {
  it("routes a legacy manual-only agent by its name", () => {
    expect(
      agentHandlesCommand(
        { name: "builder", triggers: [{ type: "manual", config: {} }] },
        "builder",
      ),
    ).toBe(true);
  });

  it("routes a renamed agent through its explicit command binding", () => {
    expect(
      agentHandlesCommand(
        {
          name: "delivery-specialist",
          triggers: [{ type: "github", command: "/builder" }],
        },
        "builder",
      ),
    ).toBe(true);
  });

  it("does not override an explicit command remapping with the agent name", () => {
    expect(
      agentHandlesCommand(
        { name: "builder", triggers: [{ type: "command", handle: "/ship" }] },
        "builder",
      ),
    ).toBe(false);
  });
});
