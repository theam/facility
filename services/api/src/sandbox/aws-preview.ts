import { createHash } from "node:crypto";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  type GetLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  type DescribeTasksCommandOutput,
  ECSClient,
  ListTasksCommand,
  type ListTasksCommandOutput,
  RegisterTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandOutput,
  RunTaskCommand,
  type RunTaskCommandOutput,
  StopTaskCommand,
  type StopTaskCommandOutput,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  type LaunchSpec,
  type RecoverLaunchSpec,
  type SandboxDriver,
  SandboxLaunchError,
} from "./driver.js";

type EcsCommand =
  | RegisterTaskDefinitionCommand
  | DeregisterTaskDefinitionCommand
  | RunTaskCommand
  | ListTasksCommand
  | DescribeTasksCommand
  | StopTaskCommand;
type EcsOutput =
  | RegisterTaskDefinitionCommandOutput
  | RunTaskCommandOutput
  | ListTasksCommandOutput
  | DescribeTasksCommandOutput
  | StopTaskCommandOutput
  | Record<string, never>;

type EcsSender = { send(command: EcsCommand): Promise<EcsOutput> };
type LogsSender = { send(command: GetLogEventsCommand): Promise<GetLogEventsCommandOutput> };
type Sleep = (milliseconds: number) => Promise<void>;

type AwsPreviewConfig = {
  cluster: string;
  subnets: string[];
  securityGroups: string[];
  family: string;
  executionRoleArn: string;
  taskRoleArn: string;
  logGroup: string;
  cpuArchitecture: "X86_64" | "ARM64";
};

type PreviewRef = { taskArn?: string; taskDefinitionArn?: string };

/**
 * Preview services need a stable inbound endpoint, which CodeBuild intentionally
 * does not expose. Keep them on isolated, unprivileged Fargate tasks while agent
 * runs use privileged CodeBuild. Each preview gets an immutable task definition
 * so its requested image and command are honored instead of reusing the runner.
 */
export class AwsPreviewSandboxDriver implements SandboxDriver {
  readonly name = "aws" as const;

  constructor(
    private readonly ecs: EcsSender = new ECSClient({ region: process.env.AWS_REGION }),
    private readonly cloudwatchLogs: LogsSender = new CloudWatchLogsClient({
      region: process.env.AWS_REGION,
    }),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly sleep: Sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async launch(spec: LaunchSpec): Promise<{ ref: string; endpoint?: string }> {
    const config = this.config();
    if (!spec.servicePort) throw new Error("aws_preview_service_port_required");
    const resources = fargateResources(spec.cpu, spec.memoryMb);
    const registered = (await this.ecs.send(
      new RegisterTaskDefinitionCommand({
        family: config.family,
        requiresCompatibilities: ["FARGATE"],
        networkMode: "awsvpc",
        cpu: resources.cpu,
        memory: resources.memory,
        executionRoleArn: config.executionRoleArn,
        taskRoleArn: config.taskRoleArn,
        runtimePlatform: {
          cpuArchitecture: config.cpuArchitecture,
          operatingSystemFamily: "LINUX",
        },
        containerDefinitions: [
          {
            name: "preview",
            image: spec.image,
            essential: true,
            ...(spec.cmd ? { command: spec.cmd } : {}),
            environment: Object.entries(spec.env)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, value]) => ({ name, value })),
            portMappings: [{ containerPort: spec.servicePort, protocol: "tcp" }],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": config.logGroup,
                "awslogs-region": requiredEnv(this.env, "AWS_REGION"),
                "awslogs-stream-prefix": "preview",
              },
            },
          },
        ],
      }),
    )) as RegisterTaskDefinitionCommandOutput;
    const taskDefinitionArn = registered.taskDefinition?.taskDefinitionArn;
    if (!taskDefinitionArn) throw new Error("ECS did not register a preview task definition");

    let taskArn: string | undefined;
    try {
      const launched = (await this.ecs.send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: taskDefinitionArn,
          launchType: "FARGATE",
          count: 1,
          startedBy: previewStartedBy(spec.runId),
          enableExecuteCommand: false,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: config.subnets,
              securityGroups: config.securityGroups,
              assignPublicIp: "DISABLED",
            },
          },
          tags: [
            { key: "facility.run", value: spec.runId },
            { key: "facility.kind", value: "preview" },
          ],
        }),
      )) as RunTaskCommandOutput;
      if (launched.failures?.length) throw new Error(formatFailures(launched.failures));
      taskArn = launched.tasks?.[0]?.taskArn;
      if (!taskArn) throw new Error("ECS RunTask did not return a preview task ARN");
      const privateIp = await this.waitForRunnableEndpoint(
        config.cluster,
        taskArn,
        launched.tasks?.[0],
      );
      return {
        ref: encodeRef({ taskArn, taskDefinitionArn }),
        ...(privateIp ? { endpoint: `http://${privateIp}:${spec.servicePort}` } : {}),
      };
    } catch (error) {
      let cleanupFailure: unknown;
      if (taskArn) {
        try {
          await this.ecs.send(
            new StopTaskCommand({
              cluster: config.cluster,
              task: taskArn,
              reason: "Facility preview launch failed",
            }),
          );
        } catch (stopError) {
          if (!isTaskAlreadyGone(stopError)) cleanupFailure = stopError;
        }
      }
      try {
        await this.deregister(taskDefinitionArn);
      } catch (deregisterError) {
        if (!isTaskDefinitionAlreadyGone(deregisterError)) cleanupFailure ??= deregisterError;
      }
      if (cleanupFailure) {
        throw new SandboxLaunchError(
          "AWS preview launch failed and cleanup did not converge",
          encodeRef({ taskArn, taskDefinitionArn }),
          { cause: new AggregateError([error, cleanupFailure]) },
        );
      }
      throw error;
    }
  }

  async recoverLaunch(
    spec: RecoverLaunchSpec,
  ): Promise<{ ref: string; endpoint?: string } | undefined> {
    const config = this.config();
    if (!spec.servicePort) throw new Error("aws_preview_service_port_required");
    const startedBy = previewStartedBy(spec.runId);
    const taskArns = new Set<string>();
    for (const filter of [
      { startedBy },
      // ECS forbids combining startedBy with another filter. Stopped tasks are
      // visible for roughly an hour, so scan only this preview family and then
      // verify startedBy on DescribeTasks before cleaning its task definition.
      { desiredStatus: "STOPPED" as const, family: config.family },
    ]) {
      let nextToken: string | undefined;
      do {
        const listed = (await this.ecs.send(
          new ListTasksCommand({ cluster: config.cluster, ...filter, nextToken }),
        )) as ListTasksCommandOutput;
        for (const taskArn of listed.taskArns ?? []) taskArns.add(taskArn);
        nextToken = listed.nextToken;
      } while (nextToken);
    }
    if (taskArns.size === 0) return undefined;

    const describedTasks: Task[] = [];
    const listedTaskArns = [...taskArns];
    for (let offset = 0; offset < listedTaskArns.length; offset += 100) {
      const described = (await this.ecs.send(
        new DescribeTasksCommand({
          cluster: config.cluster,
          tasks: listedTaskArns.slice(offset, offset + 100),
        }),
      )) as DescribeTasksCommandOutput;
      describedTasks.push(...(described.tasks ?? []));
    }
    const tasks = describedTasks
      .filter((task) => task.startedBy === startedBy && task.taskArn && task.taskDefinitionArn)
      .sort(
        (left, right) =>
          Number(terminalTaskStatus(left.lastStatus)) -
            Number(terminalTaskStatus(right.lastStatus)) ||
          (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
          compareCodePoints(String(left.taskArn), String(right.taskArn)),
      );
    const recovered = tasks[0];
    if (!recovered?.taskArn || !recovered.taskDefinitionArn) return undefined;

    // A previous implementation or an exceptionally stale retry may have
    // produced more than one task. Do not attach one while silently leaking the
    // rest: converge extras first, then adopt the oldest launch deterministically.
    for (const duplicate of tasks.slice(1)) {
      if (!duplicate.taskArn || !duplicate.taskDefinitionArn) continue;
      await this.destroy(
        encodeRef({
          taskArn: duplicate.taskArn,
          taskDefinitionArn: duplicate.taskDefinitionArn,
        }),
      );
    }

    const ref = encodeRef({
      taskArn: recovered.taskArn,
      taskDefinitionArn: recovered.taskDefinitionArn,
    });
    if (terminalTaskStatus(recovered.lastStatus)) {
      await this.destroy(ref);
      return undefined;
    }
    const privateIp = await this.waitForRunnableEndpoint(
      config.cluster,
      recovered.taskArn,
      recovered,
    );
    return {
      ref,
      ...(privateIp ? { endpoint: `http://${privateIp}:${spec.servicePort}` } : {}),
    };
  }

  async status(ref: string): Promise<"starting" | "running" | "exited" | "lost"> {
    const config = this.config();
    const taskArn = decodeRef(ref).taskArn;
    if (!taskArn) return "lost";
    const task = await this.describe(config.cluster, taskArn);
    if (!task) return "lost";
    if (["PROVISIONING", "PENDING", "ACTIVATING"].includes(task.lastStatus ?? "")) {
      return "starting";
    }
    if (task.lastStatus === "RUNNING") return "running";
    if (terminalTaskStatus(task.lastStatus)) {
      return "exited";
    }
    return "lost";
  }

  async *logs(ref: string, afterLine = 0): AsyncIterable<string> {
    const config = this.config();
    const taskArn = decodeRef(ref).taskArn;
    if (!taskArn) return;
    let nextToken: string | undefined;
    let lineNo = 0;
    do {
      let output: GetLogEventsCommandOutput;
      try {
        output = await this.cloudwatchLogs.send(
          new GetLogEventsCommand({
            logGroupName: config.logGroup,
            logStreamName: `preview/preview/${taskId(taskArn)}`,
            nextToken,
            startFromHead: true,
          }),
        );
      } catch (error) {
        if (isResourceNotFound(error)) return;
        throw error;
      }
      for (const event of output.events ?? []) {
        for (const line of event.message?.split(/\r?\n/) ?? []) {
          if (!line) continue;
          lineNo += 1;
          if (lineNo > afterLine) yield line;
        }
      }
      if (!output.nextForwardToken || output.nextForwardToken === nextToken) return;
      nextToken = output.nextForwardToken;
    } while (nextToken);
  }

  async stop(ref: string, opts: { kill?: boolean } = {}): Promise<void> {
    const config = this.config();
    const parsed = decodeRef(ref);
    if (!parsed.taskArn) return;
    await this.ecs.send(
      new StopTaskCommand({
        cluster: config.cluster,
        task: parsed.taskArn,
        reason: opts.kill
          ? "Facility preview destroy requested"
          : "Facility preview stop requested",
      }),
    );
  }

  async destroy(ref: string): Promise<void> {
    const parsed = decodeRef(ref);
    let failure: unknown;
    if (parsed.taskArn) {
      try {
        await this.stop(ref, { kill: true });
      } catch (error) {
        if (!isTaskAlreadyGone(error)) failure = error;
      }
    }
    try {
      if (parsed.taskDefinitionArn) await this.deregister(parsed.taskDefinitionArn);
    } catch (error) {
      if (!isTaskDefinitionAlreadyGone(error)) failure ??= error;
    }
    if (failure) throw failure;
  }

  private async waitForRunnableEndpoint(cluster: string, taskArn: string, initialTask?: Task) {
    let privateIp = privateIpv4(initialTask);
    if (initialTask?.lastStatus === "RUNNING" && privateIp) return privateIp;
    if (terminalTaskStatus(initialTask?.lastStatus)) {
      throw new Error(`aws_preview_task_stopped_before_running:${initialTask?.lastStatus}`);
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const task = await this.describe(cluster, taskArn);
      privateIp ??= privateIpv4(task);
      // RunTask is eventually consistent: an immediate DescribeTasks can
      // temporarily omit the task, so keep the existing bounded poll alive.
      if (task?.lastStatus === "RUNNING" && privateIp) return privateIp;
      if (terminalTaskStatus(task?.lastStatus)) {
        throw new Error(`aws_preview_task_stopped_before_running:${task?.lastStatus}`);
      }
      if (attempt < 29) await this.sleep(2_000);
    }
    // Preserve the existing reconciliation fallback for unusually slow task
    // activation. The endpoint is private even before ECS reports RUNNING.
    return privateIp;
  }

  private async describe(cluster: string, taskArn: string) {
    const output = (await this.ecs.send(
      new DescribeTasksCommand({ cluster, tasks: [taskArn] }),
    )) as DescribeTasksCommandOutput;
    return output.tasks?.[0];
  }

  private async deregister(taskDefinitionArn: string) {
    await this.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
  }

  private config(): AwsPreviewConfig {
    const cpuArchitecture = requiredEnv(this.env, "FACILITY_AWS_TASK_CPU_ARCHITECTURE");
    if (cpuArchitecture !== "X86_64" && cpuArchitecture !== "ARM64") {
      throw notConfigured("FACILITY_AWS_TASK_CPU_ARCHITECTURE");
    }
    return {
      cluster: requiredEnv(this.env, "FACILITY_AWS_ECS_CLUSTER"),
      subnets: requiredListEnv(this.env, "FACILITY_AWS_SUBNETS"),
      securityGroups: requiredListEnv(this.env, "FACILITY_AWS_PREVIEW_SECURITY_GROUPS"),
      family: requiredEnv(this.env, "FACILITY_AWS_PREVIEW_TASK_FAMILY"),
      executionRoleArn: requiredEnv(this.env, "FACILITY_AWS_PREVIEW_EXECUTION_ROLE_ARN"),
      taskRoleArn: requiredEnv(this.env, "FACILITY_AWS_PREVIEW_TASK_ROLE_ARN"),
      logGroup: requiredEnv(this.env, "FACILITY_AWS_PREVIEW_LOG_GROUP"),
      cpuArchitecture,
    };
  }
}

export function fargateResources(cpu: number, memoryMb: number) {
  const requestedCpu = Math.max(0.25, cpu);
  const requestedMemory = Math.max(512, Math.round(memoryMb));
  const twoCpuOption = {
    cpu: "2048",
    value: 2,
    memory: [4096, 5120, 6144, 7168, 8192, 9216, 10240, 11264, 12288, 13312, 14336, 15360, 16384],
  };
  const fallbackOption = {
    cpu: "4096",
    value: 4,
    memory: [8192, 16384, 24576, 30720],
  };
  const options = [
    { cpu: "256", value: 0.25, memory: [512, 1024, 2048] },
    { cpu: "512", value: 0.5, memory: [1024, 2048, 3072, 4096] },
    { cpu: "1024", value: 1, memory: [2048, 3072, 4096, 5120, 6144, 7168, 8192] },
    twoCpuOption,
    fallbackOption,
  ];
  const option = options.find((candidate) => candidate.value >= requestedCpu) ?? fallbackOption;
  const memory =
    option.memory.find((candidate) => candidate >= requestedMemory) ??
    option.memory.at(-1) ??
    30720;
  return { cpu: option.cpu, memory: String(memory) };
}

function encodeRef(ref: PreviewRef) {
  return Buffer.from(JSON.stringify(ref)).toString("base64url");
}

function decodeRef(ref: string): PreviewRef {
  try {
    const parsed = JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as PreviewRef;
    if (parsed.taskArn || parsed.taskDefinitionArn) return parsed;
  } catch {
    // Legacy ECS previews stored the raw task ARN. Preserve lifecycle cleanup
    // across this deployment instead of abandoning already-running tasks.
  }
  return { taskArn: ref };
}

function privateIpv4(
  task: { attachments?: { details?: { name?: string; value?: string }[] }[] } | undefined,
) {
  return task?.attachments
    ?.flatMap((attachment) => attachment.details ?? [])
    .find((detail) => detail.name === "privateIPv4Address")?.value;
}

function terminalTaskStatus(status: string | undefined) {
  return ["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED", "DELETED"].includes(
    status ?? "",
  );
}

function formatFailures(failures: { arn?: string; reason?: string; detail?: string }[]) {
  return `ECS RunTask failed: ${failures
    .map((failure) => [failure.arn, failure.reason, failure.detail].filter(Boolean).join(" "))
    .join("; ")}`;
}

function taskId(taskArn: string) {
  return taskArn.split("/").filter(Boolean).at(-1) ?? taskArn;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw notConfigured(name);
  return value;
}

function requiredListEnv(env: NodeJS.ProcessEnv, name: string) {
  const values =
    env[name]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (values.length === 0) throw notConfigured(name);
  return values;
}

function previewStartedBy(runId: string) {
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 19);
  return `facility-preview-${digest}`;
}

function compareCodePoints(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function notConfigured(name: string) {
  const error = new Error(`AWS preview driver is not configured; missing ${name}`);
  (error as Error & { code: string }).code = "not_configured";
  return error;
}

function isResourceNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "ResourceNotFoundException" ||
      (error as { Code?: string }).Code === "ResourceNotFoundException")
  );
}

function isTaskAlreadyGone(error: unknown) {
  if (isResourceNotFound(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  const message = (error as { message?: string }).message ?? "";
  return (
    (name === "ClientException" || name === "InvalidParameterException") &&
    /task.*(?:not found|does not exist|already (?:stopped|deleted)|is not running)/i.test(message)
  );
}

function isTaskDefinitionAlreadyGone(error: unknown) {
  if (isResourceNotFound(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  const message = (error as { message?: string }).message ?? "";
  return (
    (name === "ClientException" || name === "InvalidParameterException") &&
    /task definition.*(?:not found|does not exist|already (?:deregistered|deleted))/i.test(message)
  );
}
