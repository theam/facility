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
  FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION: "facility-test-objects/codebuild-cache",
};

const cachePartition = "a".repeat(64);

describe("AwsSandboxDriver", () => {
  it("starts an isolated CodeBuild sandbox with deterministic overrides", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    const launched = await driver.launch({
      runId: "run_test",
      image: "attacker.example/runner:latest",
      env: { RUNNER_TOKEN: "secret", RUN_ID: "run_test" },
      cachePartition,
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
      computeTypeOverride: "BUILD_GENERAL1_LARGE",
      timeoutInMinutesOverride: 2160,
      environmentVariablesOverride: [
        { name: "RUN_ID", value: "run_test", type: "PLAINTEXT" },
        { name: "RUNNER_TOKEN", value: "secret", type: "PLAINTEXT" },
      ],
      cacheOverride: {
        type: "S3",
        location: `facility-test-objects/codebuild-cache/${cachePartition}`,
      },
    });
    expect((command as StartBuildCommand | undefined)?.input).not.toHaveProperty("imageOverride");
    expect((command as StartBuildCommand | undefined)?.input.buildspecOverride).toBe(
      "version: 0.2\nrun-as: root\nphases:\n  build:\n    commands:\n      - \"'/app/codebuild-runner.sh' 'node' 'runner'\\\"'\\\"'s script.js'\"\ncache:\n  paths:\n    - \"/work/.local/share/pnpm/store/**/*\"\n    - \"/work/.npm/_cacache/**/*\"\n",
    );
    expect((command as StartBuildCommand | undefined)?.input.buildspecOverride).not.toContain(
      "key:",
    );
  });

  it("anchors different cache partitions in different S3 locations", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    const partitions = ["b".repeat(64), "c".repeat(64)];

    for (const [index, partition] of partitions.entries()) {
      await driver.launch({
        runId: `run_${index}`,
        image: "runner",
        env: {},
        cachePartition: partition,
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 5,
      });
    }

    expect(
      codebuild.commands.map(
        (command) => (command as StartBuildCommand).input.cacheOverride?.location,
      ),
    ).toEqual(
      partitions.map(
        (partition) => `${env.FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION}/${partition}`,
      ),
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
        cachePartition,
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 1,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });

    const cacheUnconfigured = new AwsSandboxDriver(codebuild, new FakeLogsClient(), {
      AWS_REGION: "us-east-1",
      FACILITY_AWS_CODEBUILD_PROJECT: "facility-test-runner",
    });
    await expect(
      cacheUnconfigured.launch({
        runId: "run_test",
        image: "runner",
        env: {},
        cachePartition,
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 1,
      }),
    ).rejects.toThrow("FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION");

    codebuild.returnBuildId = false;
    const configured = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    await expect(
      configured.launch({
        runId: "run_test",
        image: "runner",
        env: {},
        cachePartition,
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 1,
      }),
    ).rejects.toThrow("CodeBuild StartBuild did not return a build id");
    expect(
      (codebuild.commands[0] as StartBuildCommand | undefined)?.input.timeoutInMinutesOverride,
    ).toBe(2160);
  });

  it("can inspect and stop existing builds when only launch cache config is missing", async () => {
    const codebuild = new FakeCodeBuildClient();
    codebuild.builds.push({ buildStatus: "SUCCEEDED" });
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), {
      AWS_REGION: "us-east-1",
      FACILITY_AWS_CODEBUILD_PROJECT: "facility-test-runner",
    });

    await expect(driver.status("existing-build")).resolves.toBe("exited");
    await expect(driver.stop("existing-build")).resolves.toBeUndefined();
    expect(codebuild.commands[0]).toBeInstanceOf(BatchGetBuildsCommand);
    expect(codebuild.commands[1]).toBeInstanceOf(StopBuildCommand);
  });

  it("fails closed when the cache partition is absent or malformed", async () => {
    const codebuild = new FakeCodeBuildClient();
    const driver = new AwsSandboxDriver(codebuild, new FakeLogsClient(), env);
    const launch = (partition?: string) =>
      driver.launch({
        runId: "run_cache",
        image: "runner",
        env: {},
        cachePartition: partition,
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 5,
      });

    await expect(launch()).rejects.toMatchObject({ code: "not_configured" });
    await expect(launch("../another-project")).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(codebuild.commands).toHaveLength(0);
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
