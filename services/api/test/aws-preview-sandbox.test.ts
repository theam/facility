import {
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";
import { AwsPreviewSandboxDriver, fargateResources } from "../src/sandbox/aws-preview.js";

const previewEnv = {
  AWS_REGION: "eu-west-1",
  FACILITY_AWS_ECS_CLUSTER: "facility-prod",
  FACILITY_AWS_SUBNETS: "subnet-a,subnet-b",
  FACILITY_AWS_PREVIEW_SECURITY_GROUPS: "sg-preview",
  FACILITY_AWS_PREVIEW_TASK_FAMILY: "facility-prod-preview",
  FACILITY_AWS_PREVIEW_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/preview-execution",
  FACILITY_AWS_PREVIEW_TASK_ROLE_ARN: "arn:aws:iam::123:role/preview-task",
  FACILITY_AWS_PREVIEW_LOG_GROUP: "/facility/prod/preview",
  FACILITY_AWS_TASK_CPU_ARCHITECTURE: "X86_64",
};

describe("AWS preview sandbox driver", () => {
  it("registers the requested image and launches an unprivileged Fargate service", async () => {
    const commands: unknown[] = [];
    const responses = [
      {
        taskDefinition: {
          taskDefinitionArn: "arn:aws:ecs:eu-west-1:123:task-definition/facility-prod-preview:7",
        },
      },
      {
        tasks: [
          {
            taskArn: "arn:aws:ecs:eu-west-1:123:task/facility-prod/task-1",
            lastStatus: "PENDING",
            attachments: [{ details: [{ name: "privateIPv4Address", value: "10.0.2.41" }] }],
          },
        ],
      },
      { tasks: [] },
      { tasks: [{ lastStatus: "RUNNING" }] },
      { tasks: [{ lastStatus: "RUNNING" }] },
      {},
      {},
    ];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        return responses.shift() ?? {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => undefined,
    );
    const launched = await driver.launch({
      runId: "preview:sbx_1",
      image: "123.dkr.ecr.eu-west-1.amazonaws.com/widget:abc123",
      cmd: ["node", "server.js"],
      env: { PORT: "3000", FACILITY_PREVIEW: "1" },
      cpu: 1,
      memoryMb: 1024,
      timeoutMin: 60,
      servicePort: 3000,
    });
    expect(launched.endpoint).toBe("http://10.0.2.41:3000");
    expect(commands[0]).toBeInstanceOf(RegisterTaskDefinitionCommand);
    expect((commands[0] as RegisterTaskDefinitionCommand).input).toMatchObject({
      family: "facility-prod-preview",
      cpu: "1024",
      memory: "2048",
      executionRoleArn: "arn:aws:iam::123:role/preview-execution",
      taskRoleArn: "arn:aws:iam::123:role/preview-task",
      containerDefinitions: [
        {
          image: "123.dkr.ecr.eu-west-1.amazonaws.com/widget:abc123",
          command: ["node", "server.js"],
          portMappings: [{ containerPort: 3000, protocol: "tcp" }],
        },
      ],
    });
    expect(commands[1]).toBeInstanceOf(RunTaskCommand);
    expect((commands[1] as RunTaskCommand).input.startedBy).toMatch(
      /^facility-preview-[a-f0-9]{19}$/,
    );
    expect((commands[1] as RunTaskCommand).input.startedBy).toHaveLength(36);
    expect(commands[2]).toBeInstanceOf(DescribeTasksCommand);
    expect(commands[3]).toBeInstanceOf(DescribeTasksCommand);
    await expect(driver.status(launched.ref)).resolves.toBe("running");
    expect(commands[4]).toBeInstanceOf(DescribeTasksCommand);
    await driver.destroy(launched.ref);
    expect(commands[5]).toBeInstanceOf(StopTaskCommand);
    expect(commands[6]).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("recovers the exact active task and its private endpoint without relaunching", async () => {
    const commands: unknown[] = [];
    const taskArn = "arn:aws:ecs:eu-west-1:123:task/facility-prod/recovered";
    const taskDefinitionArn = "arn:aws:ecs:eu-west-1:123:task-definition/preview:12";
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListTasksCommand) {
          return command.input.desiredStatus === "STOPPED"
            ? { taskArns: [] }
            : { taskArns: [taskArn] };
        }
        if (command instanceof DescribeTasksCommand) {
          return {
            tasks: [
              {
                taskArn,
                taskDefinitionArn,
                startedBy: (commands[0] as ListTasksCommand).input.startedBy,
                lastStatus: "RUNNING",
                attachments: [{ details: [{ name: "privateIPv4Address", value: "10.0.2.44" }] }],
              },
            ],
          };
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => undefined,
    );

    await expect(
      driver.recoverLaunch({ runId: "preview:sbx_recovered", servicePort: 3000 }),
    ).resolves.toEqual({
      ref: Buffer.from(JSON.stringify({ taskArn, taskDefinitionArn })).toString("base64url"),
      endpoint: "http://10.0.2.44:3000",
    });
    expect(commands).toHaveLength(3);
    expect(commands[0]).toBeInstanceOf(ListTasksCommand);
    expect((commands[0] as ListTasksCommand).input).toMatchObject({
      cluster: "facility-prod",
      startedBy: expect.stringMatching(/^facility-preview-[a-f0-9]{19}$/),
    });
    expect((commands[0] as ListTasksCommand).input).not.toHaveProperty("desiredStatus");
    expect(commands[1]).toBeInstanceOf(ListTasksCommand);
    expect((commands[1] as ListTasksCommand).input).toMatchObject({
      cluster: "facility-prod",
      family: "facility-prod-preview",
      desiredStatus: "STOPPED",
    });
    expect(commands[2]).toBeInstanceOf(DescribeTasksCommand);
  });

  it("cleans a stopped recovered task and its definition before allowing relaunch", async () => {
    const commands: unknown[] = [];
    const taskArn = "arn:aws:ecs:eu-west-1:123:task/facility-prod/stopped-recovery";
    const taskDefinitionArn = "arn:aws:ecs:eu-west-1:123:task-definition/preview:13";
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ListTasksCommand) {
          return command.input.desiredStatus === "STOPPED"
            ? { taskArns: [taskArn] }
            : { taskArns: [] };
        }
        if (command instanceof DescribeTasksCommand) {
          return {
            tasks: [
              {
                taskArn,
                taskDefinitionArn,
                startedBy: (commands[0] as ListTasksCommand).input.startedBy,
                lastStatus: "STOPPED",
              },
            ],
          };
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );

    await expect(
      driver.recoverLaunch({ runId: "preview:stopped-recovery", servicePort: 3000 }),
    ).resolves.toBeUndefined();
    expect(
      commands.map((command) => (command as { constructor: { name: string } }).constructor.name),
    ).toEqual([
      "ListTasksCommand",
      "ListTasksCommand",
      "DescribeTasksCommand",
      "StopTaskCommand",
      "DeregisterTaskDefinitionCommand",
    ]);
  });

  it("returns no recovery when no active task exists and propagates discovery denial", async () => {
    const missing = new AwsPreviewSandboxDriver(
      { send: async () => ({ taskArns: [] }) } as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    await expect(
      missing.recoverLaunch({ runId: "preview:missing", servicePort: 3000 }),
    ).resolves.toBeUndefined();

    const denied = new AwsPreviewSandboxDriver(
      {
        send: async () => {
          throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
        },
      } as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    await expect(
      denied.recoverLaunch({ runId: "preview:denied", servicePort: 3000 }),
    ).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("returns a private endpoint after the existing activation budget expires", async () => {
    const commands: unknown[] = [];
    let sleeps = 0;
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof RegisterTaskDefinitionCommand) {
          return { taskDefinition: { taskDefinitionArn: "arn:aws:ecs:task-definition/preview:8" } };
        }
        if (command instanceof RunTaskCommand) {
          return { tasks: [{ taskArn: "arn:aws:ecs:task/facility-prod/slow" }] };
        }
        if (command instanceof DescribeTasksCommand) {
          return {
            tasks: [
              {
                lastStatus: "ACTIVATING",
                attachments: [{ details: [{ name: "privateIPv4Address", value: "10.0.2.42" }] }],
              },
            ],
          };
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => {
        sleeps += 1;
      },
    );
    const launched = await driver.launch({
      runId: "preview:slow",
      image: "example.invalid/preview:latest",
      env: {},
      cpu: 1,
      memoryMb: 1024,
      timeoutMin: 60,
      servicePort: 3000,
    });
    expect(launched.endpoint).toBe("http://10.0.2.42:3000");
    expect(commands.filter((command) => command instanceof DescribeTasksCommand)).toHaveLength(30);
    expect(sleeps).toBe(29);
  });

  it("cleans up a preview task that stops after receiving a private IP", async () => {
    const commands: unknown[] = [];
    const responses = [
      { taskDefinition: { taskDefinitionArn: "arn:aws:ecs:task-definition/preview:9" } },
      { tasks: [{ taskArn: "arn:aws:ecs:task/facility-prod/stopped" }] },
      {
        tasks: [
          {
            lastStatus: "PENDING",
            attachments: [{ details: [{ name: "privateIPv4Address", value: "10.0.2.43" }] }],
          },
        ],
      },
      { tasks: [{ lastStatus: "STOPPED", stoppedReason: "CannotPullContainerError" }] },
      {},
      {},
    ];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        return responses.shift() ?? {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => undefined,
    );
    await expect(
      driver.launch({
        runId: "preview:stopped",
        image: "example.invalid/preview:missing",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      }),
    ).rejects.toThrow("aws_preview_task_stopped_before_running:STOPPED");
    expect(commands.at(-2)).toBeInstanceOf(StopTaskCommand);
    expect(commands.at(-1)).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("deregisters the per-preview definition when task launch is denied", async () => {
    const commands: unknown[] = [];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof RegisterTaskDefinitionCommand) {
          return { taskDefinition: { taskDefinitionArn: "arn:aws:ecs:task-definition/preview:8" } };
        }
        if (command instanceof RunTaskCommand) {
          return { failures: [{ reason: "ACCESS_DENIED", detail: "policy denied" }] };
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    await expect(
      driver.launch({
        runId: "preview:denied",
        image: "example.invalid/preview:latest",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      }),
    ).rejects.toThrow("ACCESS_DENIED policy denied");
    expect(commands.at(-1)).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("stops a launched preview when private-IP discovery fails", async () => {
    const commands: unknown[] = [];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof RegisterTaskDefinitionCommand) {
          return { taskDefinition: { taskDefinitionArn: "arn:aws:ecs:task-definition/preview:9" } };
        }
        if (command instanceof RunTaskCommand) {
          return { tasks: [{ taskArn: "arn:aws:ecs:task/facility-prod/launched" }] };
        }
        if (command instanceof DescribeTasksCommand) throw new Error("transient describe failure");
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => undefined,
    );
    await expect(
      driver.launch({
        runId: "preview:describe-failure",
        image: "example.invalid/preview:latest",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      }),
    ).rejects.toThrow("transient describe failure");
    expect(commands).toHaveLength(5);
    expect(commands[0]).toBeInstanceOf(RegisterTaskDefinitionCommand);
    expect(commands[1]).toBeInstanceOf(RunTaskCommand);
    expect(commands[2]).toBeInstanceOf(DescribeTasksCommand);
    expect(commands[3]).toBeInstanceOf(StopTaskCommand);
    expect(commands[4]).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("returns a retryable ref when launch cleanup cannot stop the task", async () => {
    const commands: unknown[] = [];
    const taskArn = "arn:aws:ecs:eu-west-1:123:task/facility-prod/leaked";
    const taskDefinitionArn = "arn:aws:ecs:eu-west-1:123:task-definition/preview:10";
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof RegisterTaskDefinitionCommand) {
          return { taskDefinition: { taskDefinitionArn } };
        }
        if (command instanceof RunTaskCommand) return { tasks: [{ taskArn }] };
        if (command instanceof DescribeTasksCommand) throw new Error("describe failed");
        if (command instanceof StopTaskCommand) {
          throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
      async () => undefined,
    );
    const expectedRef = Buffer.from(JSON.stringify({ taskArn, taskDefinitionArn })).toString(
      "base64url",
    );
    await expect(
      driver.launch({
        runId: "preview:cleanup-failure",
        image: "example.invalid/preview:latest",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      }),
    ).rejects.toMatchObject({
      name: "SandboxLaunchError",
      message: "AWS preview launch failed and cleanup did not converge",
      ref: expectedRef,
    });
    expect(commands.at(-2)).toBeInstanceOf(StopTaskCommand);
    expect(commands.at(-1)).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("retries definition-only cleanup when RunTask and deregistration both fail", async () => {
    const commands: unknown[] = [];
    const taskDefinitionArn = "arn:aws:ecs:eu-west-1:123:task-definition/preview:11";
    let deregistrationFails = true;
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof RegisterTaskDefinitionCommand) {
          return { taskDefinition: { taskDefinitionArn } };
        }
        if (command instanceof RunTaskCommand) {
          return { failures: [{ reason: "CAPACITY", detail: "try later" }] };
        }
        if (command instanceof DeregisterTaskDefinitionCommand && deregistrationFails) {
          throw new Error("transient deregistration failure");
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    const expectedRef = Buffer.from(JSON.stringify({ taskDefinitionArn })).toString("base64url");
    let retryRef = "";
    try {
      await driver.launch({
        runId: "preview:definition-cleanup-failure",
        image: "example.invalid/preview:latest",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      });
    } catch (error) {
      expect(error).toMatchObject({ name: "SandboxLaunchError", ref: expectedRef });
      retryRef = (error as { ref: string }).ref;
    }
    expect(retryRef).toBe(expectedRef);
    deregistrationFails = false;
    const beforeRetry = commands.length;
    await driver.destroy(retryRef);
    expect(commands.slice(beforeRetry)).toHaveLength(1);
    expect(commands.at(-1)).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("still deregisters a preview definition when stopping the task fails", async () => {
    const commands: unknown[] = [];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof StopTaskCommand) {
          throw Object.assign(new Error("The referenced task was not found."), {
            name: "InvalidParameterException",
          });
        }
        if (command instanceof DeregisterTaskDefinitionCommand) {
          throw Object.assign(new Error("The task definition does not exist."), {
            name: "ResourceNotFoundException",
          });
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    const ref = Buffer.from(
      JSON.stringify({
        taskArn: "arn:aws:ecs:eu-west-1:123:task/facility-prod/gone",
        taskDefinitionArn: "arn:aws:ecs:eu-west-1:123:task-definition/facility-prod-preview:9",
      }),
    ).toString("base64url");
    await expect(driver.destroy(ref)).resolves.toBeUndefined();
    expect(commands[0]).toBeInstanceOf(StopTaskCommand);
    expect(commands[1]).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("retains real stop failures after deregistering for a later cleanup retry", async () => {
    const commands: unknown[] = [];
    const ecs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof StopTaskCommand) {
          throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
        }
        return {};
      },
    };
    const driver = new AwsPreviewSandboxDriver(
      ecs as never,
      { send: async () => ({}) } as never,
      previewEnv,
    );
    const ref = Buffer.from(
      JSON.stringify({
        taskArn: "arn:aws:ecs:eu-west-1:123:task/facility-prod/denied",
        taskDefinitionArn: "arn:aws:ecs:eu-west-1:123:task-definition/facility-prod-preview:10",
      }),
    ).toString("base64url");
    await expect(driver.destroy(ref)).rejects.toThrow("not authorized");
    expect(commands[0]).toBeInstanceOf(StopTaskCommand);
    expect(commands[1]).toBeInstanceOf(DeregisterTaskDefinitionCommand);
  });

  it("fails closed when the dedicated preview role configuration is absent", async () => {
    const driver = new AwsPreviewSandboxDriver(
      { send: async () => ({}) } as never,
      { send: async () => ({}) } as never,
      { ...previewEnv, FACILITY_AWS_PREVIEW_TASK_ROLE_ARN: "" },
    );
    await expect(
      driver.launch({
        runId: "preview:missing",
        image: "preview:latest",
        env: {},
        cpu: 1,
        memoryMb: 1024,
        timeoutMin: 60,
        servicePort: 3000,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("rounds requests up to a valid Fargate CPU/memory pair", () => {
    expect(fargateResources(1, 1024)).toEqual({ cpu: "1024", memory: "2048" });
    expect(fargateResources(0.4, 1500)).toEqual({ cpu: "512", memory: "2048" });
    expect(fargateResources(4, 8192)).toEqual({ cpu: "4096", memory: "8192" });
  });
});
