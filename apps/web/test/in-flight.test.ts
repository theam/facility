import { describe, expect, it } from "vitest";
import type { Pipeline, Run, RunEvent } from "@/lib/api";
import { buildInFlightRows, latestRunActivity } from "@/lib/in-flight";

const run = {
  id: "run_1109",
  status: "running",
  mode: "architect",
  engine: "codex",
  startedAt: "2026-08-12T10:00:00.000Z",
  gh: { owner: "theam", repo: "tam-os", issueNumber: 1109 },
} as unknown as Run;

const pipeline = {
  stages: [
    {
      key: "planning",
      label: "Planning",
      sub: "shape the approach",
      kind: "agent",
      count: 1,
      stories: [
        {
          number: 1109,
          repoId: "repo_tam_os",
          repoOwner: "theam",
          repoName: "tam-os",
          storyType: "issue",
          title: "Hiring chat fallback: narrow the grounding it hands the retry",
          stageState: "in_progress",
          currentRun: { id: "run_1109", mode: "architect", status: "running", engine: "codex" },
        },
      ],
    },
  ],
} as Pipeline;

describe("in-flight rows", () => {
  it("makes the story, lifecycle state, and latest activity the run identity", () => {
    const progress = {
      runId: run.id,
      seq: 4,
      type: "agent_progress",
      data: { markdown: "Inspecting retry grounding and tracing fallback inputs" },
    } as unknown as RunEvent;

    expect(
      buildInFlightRows({
        projectId: "proj_tam_os",
        runs: [run],
        pipeline,
        eventsByRun: new Map([[run.id, [progress]]]),
      }),
    ).toEqual([
      expect.objectContaining({
        storyLabel: "theam/tam-os#1109",
        storyTitle: "Hiring chat fallback: narrow the grounding it hands the retry",
        storyHref: "/projects/proj_tam_os/stories/1109?repoId=repo_tam_os&storyType=issue",
        stageLabel: "Planning",
        stateLabel: "In progress",
        activity: "Inspecting retry grounding and tracing fallback inputs",
      }),
    ]);
  });

  it("uses a role-specific activity when a live run has not emitted progress yet", () => {
    expect(latestRunActivity("builder", "running", [])).toBe("Implementing the accepted plan");
    expect(latestRunActivity("architect", "provisioning", [])).toBe("Preparing workspace");
  });

  it("ignores noisy heartbeats and translates execution phases", () => {
    const events = [
      { seq: 9, type: "heartbeat", data: { status: "alive" } },
      { seq: 8, type: "phase", data: { name: "acceptance" } },
    ] as unknown as RunEvent[];

    expect(latestRunActivity("builder", "running", events)).toBe("Running acceptance checks");
  });
});
