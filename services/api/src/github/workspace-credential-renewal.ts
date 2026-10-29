import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";
import {
  credentialHelperSource,
  installCredentialFilesSource,
  removeCredentialFilesSource,
  updateCredentialFilesSource,
} from "./workspace-credential-files.js";
import {
  GithubWorkspaceCredentialError,
  type GithubWorkspaceCredentials,
} from "./workspace-credentials.js";

const RENEW_BEFORE_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const OPERATION_TIMEOUT_MS = 20_000;

type Installed = { root: string; bin: string; helper: string; originalPath: string };
type Dependencies = {
  issue: () => Promise<GithubWorkspaceCredentials>;
  authorized: () => Promise<boolean>;
  rememberSecrets: (values: string[]) => void;
  report: (state: "renewed" | "retrying" | "revoked" | "cleanup_failed") => Promise<void>;
  revoked: () => void;
};

/** Renew in the control plane; the workspace never receives the App signing key. */
export class WorkspaceCredentialRenewal {
  private installed?: Installed;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private closed = false;
  private current: GithubWorkspaceCredentials;
  private readonly repositories: string[];
  private readonly primaryRepository: string | undefined;

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly workspace: WorkspaceLocator,
    private readonly turnId: string,
    initial: GithubWorkspaceCredentials,
    private readonly dependencies: Dependencies,
  ) {
    if (!/^turn_[a-zA-Z0-9_-]+$/.test(turnId)) throw new Error("Invalid credential turn identity");
    this.current = initial;
    this.repositories = repositoryNames(initial);
    const primary = initial.repositories.find((repo) => repo.role === "primary");
    this.primaryRepository = primary ? `${primary.owner}/${primary.name}`.toLowerCase() : undefined;
  }

  async start(): Promise<Record<string, string>> {
    if (!(await bounded(this.dependencies.authorized()))) {
      throw new GithubWorkspaceCredentialError(
        "github_credentials_revoked",
        "Execution is no longer authorized",
      );
    }
    const payload = this.payload(this.current);
    const result = await this.runtime.exec(this.workspace, {
      resume: false,
      command: "node",
      args: ["-e", installCredentialFilesSource],
      env: {
        FACILITY_CREDENTIAL_TURN: this.turnId,
        FACILITY_CREDENTIAL_PAYLOAD: payload,
        FACILITY_CREDENTIAL_HELPER: credentialHelperSource,
      },
      timeoutMs: OPERATION_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      throw new GithubWorkspaceCredentialError(
        "github_credentials_install_failed",
        "Could not prepare renewable GitHub credentials",
      );
    try {
      const value = JSON.parse(result.stdout) as Installed;
      if (
        ![value.root, value.bin, value.helper, value.originalPath].every(
          (v) => typeof v === "string" && v.length > 0,
        )
      )
        throw new Error();
      this.installed = value;
    } catch {
      throw new GithubWorkspaceCredentialError(
        "github_credentials_install_failed",
        "Workspace credential setup returned invalid metadata",
      );
    }
    this.schedule();
    return this.environment(this.current.environment);
  }

  environment(environment: Record<string, string>, engine = false): Record<string, string> {
    if (!this.installed) throw new Error("Credential helpers are not installed");
    return {
      ...environment,
      // Native children can reset PATH; gh also reads a renewable private config.
      ...(engine ? { GH_TOKEN: "", GITHUB_TOKEN: "" } : {}),
      GH_CONFIG_DIR: `${this.installed.root}/gh`,
      PATH: `${this.installed.bin}:${environment.PATH ?? this.installed.originalPath}`,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      // Reset cached helpers before installing the current turn's scoped reader.
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: this.installed.helper,
      GIT_CONFIG_KEY_2: "credential.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
    };
  }

  /** Single-flight renewal; also exposed for deterministic lifecycle integration checks. */
  renew(): Promise<void> {
    if (this.closed || !this.installed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async stop() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
    if (this.installed) {
      try {
        const result = await this.runtime.exec(this.workspace, {
          resume: false,
          command: "node",
          args: ["-e", removeCredentialFilesSource],
          env: { FACILITY_CREDENTIAL_ROOT: this.installed.root },
          timeoutMs: OPERATION_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) throw new Error();
      } catch {
        await this.report("cleanup_failed");
      }
    }
  }

  private async refresh() {
    try {
      if (!(await bounded(this.dependencies.authorized()))) {
        await this.revoke();
        return;
      }
      const credential = await bounded(this.dependencies.issue());
      const payload = this.payload(credential);
      // Issuance may outlive cancellation or an authorization change.
      if (this.closed) return;
      if (!(await bounded(this.dependencies.authorized()))) {
        await this.revoke();
        return;
      }
      if (this.closed || !this.installed) return;
      const result = await this.runtime.exec(this.workspace, {
        resume: false,
        command: "node",
        args: ["-e", updateCredentialFilesSource],
        env: {
          FACILITY_CREDENTIAL_ROOT: this.installed.root,
          FACILITY_CREDENTIAL_PAYLOAD: payload,
        },
        timeoutMs: OPERATION_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) throw new Error();
      this.current = credential;
      await this.report("renewed");
      this.schedule();
    } catch (error) {
      if (this.closed) return;
      if (
        error instanceof GithubWorkspaceCredentialError &&
        [
          "github_installation_unavailable",
          "github_installation_missing",
          "project_repositories_missing",
          "github_credential_scope_changed",
        ].includes(error.code)
      ) {
        await this.revoke();
        return;
      }
      // Never persist raw provider/runtime exceptions or credential-bearing output.
      await this.report("retrying");
      this.schedule(RETRY_MS);
    }
  }

  private async revoke() {
    this.closed = true;
    clearTimeout(this.timer);
    this.dependencies.revoked();
    await this.report("revoked");
    if (this.installed) {
      try {
        const result = await this.runtime.exec(this.workspace, {
          resume: false,
          command: "node",
          args: ["-e", removeCredentialFilesSource],
          env: { FACILITY_CREDENTIAL_ROOT: this.installed.root },
          timeoutMs: OPERATION_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) throw new Error();
      } catch {
        await this.report("cleanup_failed");
      }
    }
  }

  private payload(credential: GithubWorkspaceCredentials) {
    const expiresAt = credential.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + RENEW_BEFORE_MS) {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub returned insufficient credential lifetime",
      );
    }
    if (JSON.stringify(repositoryNames(credential)) !== JSON.stringify(this.repositories)) {
      throw new GithubWorkspaceCredentialError(
        "github_credential_scope_changed",
        "Project repository scope changed during execution",
      );
    }
    let tokens: Record<string, unknown>;
    try {
      tokens = JSON.parse(credential.environment.FACILITY_GITHUB_CREDENTIALS ?? "null");
    } catch {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub credential map is invalid",
      );
    }
    if (
      !tokens ||
      typeof tokens !== "object" ||
      Array.isArray(tokens) ||
      JSON.stringify(Object.keys(tokens).sort()) !== JSON.stringify(this.repositories)
    ) {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub credential map does not match execution scope",
      );
    }
    const values = Object.values(tokens);
    if (
      !values.every(
        (value) => typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value),
      )
    ) {
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub credential map contains invalid credentials",
      );
    }
    const primary = credential.repositories.find((repo) => repo.role === "primary");
    if (!primary)
      throw new GithubWorkspaceCredentialError(
        "github_token_invalid",
        "GitHub primary repository is missing",
      );
    if (`${primary.owner}/${primary.name}`.toLowerCase() !== this.primaryRepository) {
      throw new GithubWorkspaceCredentialError(
        "github_credential_scope_changed",
        "Primary repository changed during execution",
      );
    }
    this.dependencies.rememberSecrets(values as string[]);
    return JSON.stringify({
      expiresAt,
      tokens,
      user: credential.gitIdentity.name,
      primary: `${primary.owner}/${primary.name}`.toLowerCase(),
    });
  }

  private schedule(
    delay = Math.max(1_000, this.current.expiresAt.getTime() - Date.now() - RENEW_BEFORE_MS),
  ) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.renew();
    }, delay);
    this.timer.unref();
  }

  private async report(state: Parameters<Dependencies["report"]>[0]) {
    try {
      await bounded(this.dependencies.report(state));
    } catch {
      /* Reporting must not disable renewal or leak provider errors. */
    }
  }
}

function repositoryNames(credential: GithubWorkspaceCredentials) {
  return credential.repositories.map((repo) => `${repo.owner}/${repo.name}`.toLowerCase()).sort();
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("GitHub credential renewal timed out")),
          OPERATION_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
