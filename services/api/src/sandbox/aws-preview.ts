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
  RegisterTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandOutput,
  RunTaskCommand,
  type RunTaskCommandOutput,
  StopTaskCommand,
  type StopTaskCommandOutput,
} from "@aws-sdk/client-ecs";
import type { LaunchSpec, SandboxDriver } from "./driver.js";

type EcsCommand =
  | RegisterTaskDefinitionCommand
  | DeregisterTaskDefinitionCommand
  | RunTaskCommand
  | DescribeTasksCommand
  | StopTaskCommand;
type EcsOutput =
  | RegisterTaskDefinitionCommandOutput
  | RunTaskCommandOutput
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

type PreviewRef = { taskArn: string; taskDefinitionArn?: string };

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

    try {
      const launched = (await this.ecs.send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: taskDefinitionArn,
          launchType: "FARGATE",
          count: 1,
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
      const taskArn = launched.tasks?.[0]?.taskArn;
      if (!taskArn) throw new Error("ECS RunTask did not return a preview task ARN");
      const privateIp =
        privateIpv4(launched.tasks?.[0]) ?? (await this.waitForPrivateIp(config.cluster, taskArn));
      return {
        ref: encodeRef({ taskArn, taskDefinitionArn }),
        ...(privateIp ? { endpoint: `http://${privateIp}:${spec.servicePort}` } : {}),
      };
    } catch (error) {
      await this.deregister(taskDefinitionArn).catch(() => undefined);
      throw error;
    }
  }

  async status(ref: string): Promise<"starting" | "running" | "exited" | "lost"> {
    const config = this.config();
    const task = await this.describe(config.cluster, decodeRef(ref).taskArn);
    if (!task) return "lost";
    if (["PROVISIONING", "PENDING", "ACTIVATING"].includes(task.lastStatus ?? "")) {
      return "starting";
    }
    if (task.lastStatus === "RUNNING") return "running";
    if (
      ["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED", "DELETED"].includes(
        task.lastStatus ?? "",
      )
    ) {
      return "exited";
    }
    return "lost";
  }

  async *logs(ref: string, afterLine = 0): AsyncIterable<string> {
    const config = this.config();
    const taskArn = decodeRef(ref).taskArn;
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
    await this.stop(ref, { kill: true });
    if (parsed.taskDefinitionArn) await this.deregister(parsed.taskDefinitionArn);
  }

  private async waitForPrivateIp(cluster: string, taskArn: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const task = await this.describe(cluster, taskArn);
      const privateIp = privateIpv4(task);
      if (privateIp) return privateIp;
      if (!task || task.lastStatus === "STOPPED") return undefined;
      await this.sleep(2_000);
    }
    return undefined;
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
    if (parsed.taskArn) return parsed;
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
