import { describe, expect, it } from "vitest";
import { builderPlanDecision } from "../src/builder-plan-policy.js";

describe("builder plan policy", () => {
  it("preserves direct Builder dispatch for optional projects", () => {
    expect(
      builderPlanDecision({
        policy: "optional",
        mode: "builder",
        trigger: { type: "manual" },
        acceptanceValid: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("denies Builder without a plan when the project requires one", () => {
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "codex-builder",
        trigger: { type: "web_issue" },
        acceptanceValid: false,
      }),
    ).toEqual({ allowed: false, code: "builder_plan_required" });
  });

  it("accepts only a durably validated plan_acceptance in required mode", () => {
    const trigger = {
      source: "plan_acceptance",
      proposalId: "prop_test",
      architectRunId: "run_test",
    };
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "builder",
        trigger,
        acceptanceValid: false,
      }),
    ).toEqual({ allowed: false, code: "builder_plan_context_invalid" });
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "builder",
        trigger,
        acceptanceValid: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("does not gate read-only Architect runs", () => {
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "codex-architect",
        trigger: { type: "github_comment" },
        acceptanceValid: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("derives Builder identity from the canonical agent when mode describes a surface", () => {
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "conversation",
        agentName: "codex-builder",
        trigger: { type: "conversation" },
        acceptanceValid: false,
      }),
    ).toEqual({ allowed: false, code: "builder_plan_required" });
  });

  it.each([
    "builder_plan_expired",
    "builder_plan_rejected",
    "builder_plan_already_consumed",
    "builder_plan_stale",
    "builder_plan_freshness_unavailable",
    "builder_plan_context_invalid",
  ] as const)("preserves the stable %s denial code", (denialCode) => {
    expect(
      builderPlanDecision({
        policy: "required",
        mode: "codex_builder",
        trigger: { source: "plan_acceptance" },
        acceptanceValid: false,
        denialCode,
      }),
    ).toEqual({ allowed: false, code: denialCode });
  });
});
