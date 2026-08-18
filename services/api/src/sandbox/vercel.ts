import { createHash } from "node:crypto";
import type { NetworkPolicy } from "@vercel/sandbox";
import type { LaunchSpec, RecoverLaunchSpec, SandboxDriver } from "./driver.js";

type VercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

type VercelCommand = {
  cmdId: string;
  exitCode: number | null;
  logs(options?: { signal?: AbortSignal }): AsyncIterable<{ data: string }>;
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
};

type VercelSandbox = {
  name: string;
  status: "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";
  tags?: Record<string, string>;
  runCommand(input: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    detached: true;
    timeoutMs: number;
  }): Promise<VercelCommand>;
  getCommand(commandId: string): Promise<VercelCommand>;
  domain(port: number): string;
  update(input: { tags: Record<string, string> }): Promise<void>;
  stop(): Promise<unknown>;
  delete(): Promise<void>;
};

type CreateSandboxInput = VercelCredentials & {
  name: string;
  image: string;
  ports?: number[];
  timeout: number;
  resources: { vcpus: number };
  networkPolicy: NetworkPolicy;
  tags: Record<string, string>;
  persistent: false;
};

type GetSandboxInput = VercelCredentials & {
  name: string;
  resume: false;
};

export type VercelSandboxClient = {
  create(input: CreateSandboxInput): Promise<VercelSandbox>;
  get(input: GetSandboxInput): Promise<VercelSandbox>;
};

type VercelSandboxRef = {
  version: 1;
  name: string;
  commandId?: string;
};

const TERMINAL_STATUSES = new Set(["stopped", "failed", "aborted"]);
const STARTING_STATUSES = new Set(["pending", "snapshotting"]);
const DEFAULT_RESTRICTED_DOMAINS = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "auth.docker.io",
  "registry-1.docker.io",
  "production.cloudflare.docker.com",
  // Supabase's official local-development stack is published here. Keep the
  // registry explicit rather than opening generic AWS or CloudFront egress.
  "public.ecr.aws",
  // Public ECR serves authenticated layer downloads from this CDN host.
  "d2glxqk2uabbnd.cloudfront.net",
  // Browser-backed repository checks install pinned Playwright builds during
  // provisioning. The repository still chooses the exact executable version.
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
  "storage.googleapis.com",
  // Next.js resolves hosted fonts while compiling. These are deliberately
  // narrower than generic Google egress and were exercised by TAM-OS's build.
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const;

export class VercelSandboxDriver implements SandboxDriver {
  readonly name = "vercel" as const;

  constructor(
    private readonly client: VercelSandboxClient = defaultVercelClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async launch(spec: LaunchSpec): Promise<{ ref: string; endpoint?: string }> {
    const credentials = this.credentials();
    const name = sandboxName(spec.runId);
    const runTag = runIdentity(spec.runId);
    const tags = {
      facility: "1",
      run: runTag,
      kind: spec.kind ?? "run",
    };
    const createInput: CreateSandboxInput = {
      ...credentials,
      name,
      image: vercelImage(spec.image),
      ...(spec.servicePort ? { ports: [spec.servicePort] } : {}),
      timeout: providerLeaseTimeoutMs(spec),
      resources: { vcpus: vercelVcpus(spec.cpu, spec.memoryMb) },
      networkPolicy: vercelNetworkPolicy(spec.network, spec.env),
      tags,
      // A run is an isolation boundary. Automatic filesystem restoration could
      // otherwise carry repository-controlled bytes into a later invocation.
      persistent: false,
    };

    let sandbox: VercelSandbox;
    try {
      sandbox = await this.client.create(createInput);
    } catch (error) {
      if (!isHttpStatus(error, 409)) throw error;
      const stale = await this.client.get({ ...credentials, name, resume: false });
      if (stale.tags?.facility !== "1" || stale.tags.run !== runTag) {
        throw providerError("Vercel sandbox name collision was not owned by this Facility run");
      }
      await stale.delete();
      sandbox = await this.client.create(createInput);
    }

    try {
      const command = launchCommand(spec);
      const running = await sandbox.runCommand({
        cmd: command[0],
        args: command.slice(1),
        ...(spec.kind === "preview" ? {} : { cwd: "/work" }),
        env:
          spec.kind === "preview"
            ? spec.env
            : {
                ...spec.env,
                // This trusted marker selects the provider-enforced metadata
                // boundary in the runner. Vercel microVMs do not expose the
                // kernel modules needed by the CodeBuild iptables path.
                FACILITY_SANDBOX_PROVIDER: "vercel",
              },
        detached: true,
        timeoutMs: providerLeaseTimeoutMs(spec),
      });
      // Vercel currently keeps update() pending while a detached command is
      // alive. The command id is only recovery metadata: the opaque ref below
      // already carries it, and deletion needs only the sandbox name. Never
      // hold the control-plane launch response behind this best-effort tag or
      // Facility cannot persist the ref, cancel, or reconcile a live run.
      void sandbox.update({ tags: { ...tags, command: running.cmdId } }).catch(() => undefined);
      return {
        ref: encodeRef({ version: 1, name: sandbox.name, commandId: running.cmdId }),
        ...(spec.servicePort ? { endpoint: sandbox.domain(spec.servicePort) } : {}),
      };
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  async recoverLaunch(
    spec: RecoverLaunchSpec,
  ): Promise<{ ref: string; endpoint?: string } | undefined> {
    const credentials = this.credentials();
    const name = sandboxName(spec.runId);
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.client.get({ ...credentials, name, resume: false });
    } catch (error) {
      if (isHttpStatus(error, 404)) return undefined;
      throw error;
    }
    if (
      sandbox.tags?.facility !== "1" ||
      sandbox.tags.run !== runIdentity(spec.runId) ||
      TERMINAL_STATUSES.has(sandbox.status)
    ) {
      return undefined;
    }
    const commandId = sandbox.tags.command;
    return {
      ref: encodeRef({ version: 1, name, ...(commandId ? { commandId } : {}) }),
      ...(spec.servicePort ? { endpoint: sandbox.domain(spec.servicePort) } : {}),
    };
  }

  async status(ref: string): Promise<"starting" | "running" | "exited" | "lost"> {
    const decoded = decodeRef(ref);
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.get(decoded.name);
    } catch (error) {
      if (isHttpStatus(error, 404)) return "lost";
      throw error;
    }
    if (STARTING_STATUSES.has(sandbox.status)) return "starting";
    if (TERMINAL_STATUSES.has(sandbox.status) || sandbox.status === "stopping") return "exited";
    if (!decoded.commandId) return sandbox.status === "running" ? "running" : "lost";
    try {
      const command = await sandbox.getCommand(decoded.commandId);
      if (command.exitCode !== null) return "exited";
      // getCommand reconstructs a detached SDK command with a null exit code,
      // even after the remote process has finished. A short wait is the only
      // authoritative completion probe; aborting it keeps status polling
      // bounded while the agent is still running.
      const signal = AbortSignal.timeout(250);
      try {
        await command.wait({ signal });
        return "exited";
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return "running";
        throw error;
      }
    } catch (error) {
      if (isHttpStatus(error, 404)) return "lost";
      throw error;
    }
  }

  async *logs(ref: string, afterLine = 0): AsyncIterable<string> {
    const decoded = decodeRef(ref);
    if (!decoded.commandId) return;
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.get(decoded.name);
    } catch (error) {
      if (isHttpStatus(error, 404)) return;
      throw error;
    }
    let command: VercelCommand;
    try {
      command = await sandbox.getCommand(decoded.commandId);
    } catch (error) {
      if (isHttpStatus(error, 404)) return;
      throw error;
    }
    let lineNo = 0;
    // Vercel's command log iterator tails a live command. Facility's driver
    // contract is a bounded snapshot poll, so close the stream after a short
    // collection window instead of pinning a worker job until the agent exits.
    const signal = AbortSignal.timeout(750);
    try {
      for await (const entry of command.logs({ signal })) {
        for (const line of entry.data.split(/\r?\n/)) {
          if (!line) continue;
          lineNo += 1;
          if (lineNo > afterLine) yield line;
        }
      }
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) throw error;
    }
  }

  async stop(ref: string, opts: { kill?: boolean } = {}): Promise<void> {
    const decoded = decodeRef(ref);
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.get(decoded.name);
    } catch (error) {
      if (isHttpStatus(error, 404)) return;
      throw error;
    }
    if (decoded.commandId) {
      try {
        const command = await sandbox.getCommand(decoded.commandId);
        if (command.exitCode === null) await command.kill(opts.kill ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if (!isHttpStatus(error, 404)) throw error;
      }
    }
    if (!TERMINAL_STATUSES.has(sandbox.status)) {
      try {
        await sandbox.stop();
      } catch (error) {
        if (!isHttpStatus(error, 404) && !isHttpStatus(error, 409)) throw error;
      }
    }
  }

  async destroy(ref: string): Promise<void> {
    const decoded = decodeRef(ref);
    try {
      const sandbox = await this.get(decoded.name);
      await sandbox.delete();
    } catch (error) {
      if (!isHttpStatus(error, 404)) throw error;
    }
  }

  private get(name: string) {
    return this.client.get({ ...this.credentials(), name, resume: false });
  }

  private credentials(): VercelCredentials {
    const token = stringEnv(this.env.VERCEL_OIDC_TOKEN) ?? stringEnv(this.env.VERCEL_TOKEN);
    const teamId = stringEnv(this.env.VERCEL_TEAM_ID);
    const projectId = stringEnv(this.env.VERCEL_PROJECT_ID);
    const missing: string[] = [];
    if (!token) missing.push("VERCEL_TOKEN or VERCEL_OIDC_TOKEN");
    if (!teamId) missing.push("VERCEL_TEAM_ID");
    if (!projectId) missing.push("VERCEL_PROJECT_ID");
    if (missing.length > 0) {
      const error = new Error(
        `Vercel sandbox driver is not configured; missing ${missing.join(", ")}`,
      );
      (error as Error & { code: string }).code = "not_configured";
      throw error;
    }
    if (!token || !teamId || !projectId) throw providerError("Vercel credentials are incomplete");
    return { token, teamId, projectId };
  }
}

const defaultVercelClient: VercelSandboxClient = {
  async create(input) {
    const { Sandbox } = await import("@vercel/sandbox");
    return (await Sandbox.create({
      ...input,
      signal: AbortSignal.timeout(90_000),
    })) as unknown as VercelSandbox;
  },
  async get(input) {
    const { Sandbox } = await import("@vercel/sandbox");
    return (await Sandbox.get({
      ...input,
      signal: AbortSignal.timeout(15_000),
    })) as unknown as VercelSandbox;
  },
};

function launchCommand(spec: LaunchSpec): [string, ...string[]] {
  if (spec.kind === "preview") {
    if (!spec.cmd?.[0]) {
      const error = new Error("Vercel previews require an explicit startup command");
      (error as Error & { code: string }).code = "not_configured";
      throw error;
    }
    return spec.cmd as [string, ...string[]];
  }
  return ["/app/codebuild-runner.sh", ...(spec.cmd ?? [])];
}

function vercelImage(image: string) {
  // Vercel's managed images are already mutable aliases. Sending `:latest`
  // through the custom VCR path can trigger an unnecessary image compilation;
  // use the managed alias directly while preserving explicit custom tags.
  if (
    /^vercel\/sandbox\/(?:universal|node:(?:22|24|26)|python:3\.14|ubuntu|arch):latest$/.test(image)
  ) {
    return image.slice(0, -":latest".length);
  }
  return image;
}

function sandboxName(runId: string) {
  return `facility-${runIdentity(runId)}`;
}

function runIdentity(runId: string) {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

function timeoutMs(timeoutMin: number) {
  return Math.min(300, Math.max(1, Math.ceil(timeoutMin))) * 60_000;
}

function providerLeaseTimeoutMs(spec: LaunchSpec) {
  return spec.kind === "preview" ? timeoutMs(spec.timeoutMin) : timeoutMs(300);
}

function vercelVcpus(cpu: number, memoryMb: number) {
  const requested = Math.max(Math.ceil(cpu), Math.ceil(memoryMb / 2048), 1);
  return [1, 2, 4, 8].find((candidate) => candidate >= requested) ?? 8;
}

function vercelNetworkPolicy(
  network: Record<string, unknown> | undefined,
  env: Record<string, string>,
): NetworkPolicy {
  const egress = stringEnv(typeof network?.egress === "string" ? network.egress : undefined);
  if (egress === "unrestricted") {
    return {
      allow: ["*"],
      subnets: { deny: ["100.100.100.200/32", "169.254.0.0/16"] },
    };
  }
  if (egress === "none" || egress === "disabled") return "deny-all";

  const configured = ["allow", "allowed_domains", "vercel_allow_domains"].flatMap((key) => {
    const value = network?.[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw providerError(`Vercel restricted network field "${key}" must be a string array`);
    }
    return value as string[];
  });
  const callbackDomains = [env.FACILITY_API_URL, env.FACILITY_GATEWAY_URL]
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return new URL(value).hostname;
      } catch {
        throw providerError("Vercel sandbox callback URLs must be valid URLs");
      }
    });
  const allow = [...DEFAULT_RESTRICTED_DOMAINS, ...configured, ...callbackDomains]
    .map(normalizeDomain)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  return {
    allow,
    subnets: { deny: ["100.100.100.200/32", "169.254.0.0/16"] },
  };
}

function normalizeDomain(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "*" || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(normalized)) {
    throw providerError(`Invalid Vercel sandbox allowlist domain: ${value}`);
  }
  return normalized;
}

function encodeRef(ref: VercelSandboxRef) {
  return `v1.${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
}

function decodeRef(value: string): VercelSandboxRef {
  try {
    if (!value.startsWith("v1.")) throw new Error("version");
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      parsed.version !== 1 ||
      typeof parsed.name !== "string" ||
      !/^facility-[a-f0-9]{32}$/.test(parsed.name) ||
      (parsed.commandId !== undefined &&
        (typeof parsed.commandId !== "string" || parsed.commandId.length > 200))
    ) {
      throw new Error("shape");
    }
    return {
      version: 1,
      name: parsed.name,
      ...(parsed.commandId ? { commandId: parsed.commandId as string } : {}),
    };
  } catch {
    const error = new Error("Invalid Vercel sandbox reference");
    (error as Error & { code: string }).code = "invalid_ref";
    throw error;
  }
}

function isHttpStatus(error: unknown, status: number) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return (
    candidate.status === status ||
    candidate.statusCode === status ||
    candidate.response?.status === status
  );
}

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    ["AbortError", "TimeoutError"].includes(String((error as { name?: string }).name))
  );
}

function providerError(message: string) {
  const error = new Error(message);
  (error as Error & { code: string }).code = "invalid_provider_config";
  return error;
}

function stringEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
