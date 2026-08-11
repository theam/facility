export type RunBundle = {
  runId: string;
  mode: string;
  engine: "claude_code" | "codex" | "byo";
  contract: string;
  skills: Array<{ name: string; content: string }>;
  engineConfig: Record<string, unknown>;
  repo: {
    cloneUrl: string | null;
    branch: string | null;
    expectedHeadSha: string | null;
    installationTokenRef: string | null;
  };
  harness?: { files: Record<string, string> } | null;
  packageInstallCmd: string | null;
  provisionCmd: string | null;
  checkCmds: string[];
  gatewayUrls: { anthropic: string; openai: string };
  /** Older persisted bundles omit this and retain API-key behavior. */
  anthropicAuthMode?: "api_key" | "oauth";
  scope: Record<string, unknown>;
  timeoutMin: number;
  resume?: {
    sessionId: string;
    sessionStateFrom: string;
    prompt: string;
    branch?: string;
    fallbackScope?: Record<string, unknown>;
  };
};

export type RunEvent = {
  type: string;
  data?: Record<string, unknown>;
  ts?: string;
};
