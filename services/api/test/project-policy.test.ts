import { describe, expect, it } from "vitest";
import {
  githubFeedbackMode,
  githubFeedbackModeForRun,
  projectAutonomyMode,
  scheduledAutonomyAllowed,
} from "../src/project-policy.js";

describe("project autonomy policy", () => {
  it("preserves active behaviour for existing projects without a policy", () => {
    expect(projectAutonomyMode({})).toBe("active");
    expect(scheduledAutonomyAllowed(null)).toBe(true);
    expect(githubFeedbackMode(undefined)).toBe("live");
  });

  it("makes observe-first silent and gates schedules", () => {
    const settings = { autonomy_mode: "observe" };
    expect(projectAutonomyMode(settings)).toBe("observe");
    expect(scheduledAutonomyAllowed(settings)).toBe(false);
    expect(githubFeedbackMode(settings)).toBe("silent");
  });

  it("allows one explicit terminal summary without enabling schedules", () => {
    const settings = { autonomy_mode: "observe", observe_summary: true };
    expect(scheduledAutonomyAllowed(settings)).toBe(false);
    expect(githubFeedbackMode(settings)).toBe("summary");
  });

  it("fails legacy and malformed run feedback values to live behaviour", () => {
    expect(githubFeedbackModeForRun({})).toBe("live");
    expect(githubFeedbackModeForRun({ githubFeedback: "unexpected" })).toBe("live");
    expect(githubFeedbackModeForRun({ githubFeedback: "silent" })).toBe("silent");
  });
});
