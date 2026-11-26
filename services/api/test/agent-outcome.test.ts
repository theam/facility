import { describe, expect, it } from "vitest";
import { agentOutcome } from "../src/turns/agent-outcome.js";

const review = (text: string) => `<facility-ready-for-review>${text}</facility-ready-for-review>`;
const question = (text: string) => `<facility-needs-attention>${text}</facility-needs-attention>`;

describe("agent outcome control block", () => {
  it("requires a real response before a result can be marked for review", () => {
    expect(agentOutcome(review("Review the result."))).toEqual({ output: "" });
    expect(agentOutcome(question("Which option?"))).toEqual({
      output: "",
      attention: "Which option?",
    });
  });

  it("preserves preceding prose and only extracts the final block", () => {
    const report = `Example: ${review("example")}\n\nHere is the completed report.`;
    expect(agentOutcome(`${report}\n${review("Review this report.")}\n`)).toEqual({
      output: report,
      readyForReview: "Review this report.",
    });
  });

  it.each([
    `Report\n${review("First")}\n${review("Second")}`,
    `Report\n${question("Which option?")}\n${review("Also review")}`,
    `Report\n${question(review("Nested"))}`,
    `Report\n${review("Fenced")}\n\x60\x60\x60`,
    `Report\n${review(" ")}`,
  ])("leaves an ambiguous or non-final marker as plain output", (output) => {
    expect(agentOutcome(output)).toEqual({ output });
  });
});
