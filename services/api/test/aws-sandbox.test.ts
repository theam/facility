import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  BatchGetBuildsCommand,
  StartBuildCommand,
  StopBuildCommand,
} from "@aws-sdk/client-codebuild";
import { describe, expect, it } from "vitest";
import { AwsSandboxDriver } from "../src/sandbox/aws.js";

const env = {
  AWS_REGION: "us-east-1",
  FACILITY_AWS_CODEBUILD_PROJECT: "facility-test-runner",
};

describe("AwsSandboxDriver", () => {
  it("starts an isolated CodeBuild sandbox with deterministic overrides", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    const launched = await driver.launch({
      runId: "run_test",
      image: "facility-runner:dev",
      env: { RUNNER_TOKEN: "secret", RUN_ID: "run_test" },
      cpu: 8,
      memoryMb: 15_360,
      timeoutMin: 30,
      cmd: ["node", "runner's script.js"],
    });

    expect(launched).toEqual({ ref: "facility-test-runner:build-1" });
    const command = codebuild.commands[0];
    expect(command).toBeInstanceOf(StartBuildCommand);
    expect((command as StartBuildCommand | undefined)?.input).toMatchObject({
      projectName: "facility-test-runner",
      idempotencyToken: "run_test",
      imageOverride: "facility-runner:dev",
      computeTypeOverride: "BUILD_GENERAL1_LARGE",
      timeoutInMinutesOverride: 30,
      environmentVariablesOverride: [
        { name: "RUN_ID", value: "run_test", type: "PLAINTEXT" },
        { name: "RUNNER_TOKEN", value: "secret", type: "PLAINTEXT" },
      ],
    });
    expect((command as StartBuildCommand | undefined)?.input.buildspecOverride).toBe(
      "version: 0.2\nrun-as: root\nphases:\n  build:\n    commands:\n      - \"'/app/codebuild-runner.sh' 'node' 'runner'\\\"'\\\"'s script.js'\"\n",
    );
  });

  it("maps CodeBuild phases and terminal states", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    codebuild.builds.push(
      { buildStatus: "IN_PROGRESS", currentPhase: "PROVISIONING" },
      { buildStatus: "IN_PROGRESS", currentPhase: "BUILD" },
      { buildStatus: "SUCCEEDED", currentPhase: "COMPLETED" },
      undefined,
    );

    await expect(driver.status("build-starting")).resolves.toBe("starting");
    await expect(driver.status("build-running")).resolves.toBe("running");
    await expect(driver.status("build-complete")).resolves.toBe("exited");
    await expect(driver.status("build-missing")).resolves.toBe("lost");
    expect(codebuild.commands.every((command) => command instanceof BatchGetBuildsCommand)).toBe(
      true,
    );
  });

  it("stops CodeBuild sandboxes", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);

    await driver.stop("facility-test-runner:build-1");

    const command = codebuild.commands[0];
    expect(command).toBeInstanceOf(StopBuildCommand);
    expect((command as StopBuildCommand | undefined)?.input).toEqual({
      id: "facility-test-runner:build-1",
    });
  });

  it("discovers and reads the exact CloudWatch stream returned by CodeBuild", async () => {
    const codebuild = new FakeCodeBuildClient();
    codebuild.builds.push({
      buildStatus: "IN_PROGRESS",
      currentPhase: "BUILD",
      logs: { groupName: "/facility/test/runner", streamName: "runner/build-1" },
    });
    const logs = new FakeLogsClient();
    logs.events.push({ message: "first\nsecond" }, { message: "third" });
    const driver = new AwsSandboxDriver(codebuild, logs, env);

    const lines: string[] = [];
    for await (const line of driver.logs("facility-test-runner:build-1", 1)) lines.push(line);

    expect(lines).toEqual(["second", "third"]);
    const command = logs.commands[0];
    expect(command).toBeInstanceOf(GetLogEventsCommand);
    expect(command?.input).toMatchObject({
      logGroupName: "/facility/test/runner",
      logStreamName: "runner/build-1",
      startFromHead: true,
    });
  });

  it("fails closed when configuration or the returned build id is missing", async () => {
    const codebuild = new FakeCodeBuildClient();
    const unconfigured = new AwsSandboxDriver(codebuild, new FakeLogsClient(), {
      AWS_REGION: "us-east-1",
    });
    await expect(
      unconfigured.launch({
        runId: "run_test",
        image: "runner",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 1,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });

    codebuild.returnBuildId = false;
    const configured = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    await expect(
      configured.launch({
        runId: "run_test",
        image: "runner",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 1,
      }),
    ).rejects.toThrow("CodeBuild StartBuild did not return a build id");
    expect(
      (codebuild.commands[0] as StartBuildCommand | undefined)?.input.timeoutInMinutesOverride,
    ).toBe(5);
  });
});

type Build = {
  buildStatus?: string;
  currentPhase?: string;
  logs?: { groupName?: string; streamName?: string };
};

class FakeCodeBuildClient {
  readonly commands: Array<StartBuildCommand | BatchGetBuildsCommand | StopBuildCommand> = [];
  readonly builds: Array<Build | undefined> = [];
  returnBuildId = true;

  async send(command: StartBuildCommand | BatchGetBuildsCommand | StopBuildCommand) {
    this.commands.push(command);
    if (command instanceof StartBuildCommand) {
      return {
        $metadata: {},
        build: this.returnBuildId ? { id: "facility-test-runner:build-1" } : {},
      };
    }
    if (command instanceof BatchGetBuildsCommand) {
      const build = this.builds.shift();
      return { $metadata: {}, builds: build ? [build] : [] };
    }
    return { $metadata: {} };
  }
}

class FakeLogsClient {
  readonly commands: GetLogEventsCommand[] = [];
  readonly events: Array<{ message: string }> = [];

  async send(command: GetLogEventsCommand) {
    this.commands.push(command);
    return { $metadata: {}, events: this.events };
  }
}
