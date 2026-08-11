import type { ProviderAuthMode } from "@facility/core";
import type { FacilityDb } from "@facility/db";

export type Provider = "anthropic" | "openai";

export type GatewayConfig = {
  databaseUrl: string;
  secretMasterKey: string;
  port: number;
  s3Endpoint?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
  awsRegion?: string;
  logLevel: string;
  devAnthropicApiKey?: string;
  devOpenaiApiKey?: string;
  facilityInsecureDev: boolean;
  nodeEnv?: string;
};

export type AuthedKey = {
  id: string;
  orgId: string;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  allowedModels: string[] | null;
  budgetId: string | null;
  agentDefId: string | null;
  engine: string | null;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type RequestRecord = {
  requestId: string;
  provider: Provider;
  model: string;
  status: "ok" | "error" | "blocked_budget" | "blocked_policy" | "model_not_priced";
  statusCode: number;
  startedAt: number;
  key: AuthedKey;
  usage: Usage;
  priced: boolean;
  error?: string;
  requestBody: unknown;
  responseBody: unknown;
  budgets: BudgetState[];
  reservations?: Array<{ budget: BudgetState; estimatedCents: number }>;
  estimatedCents?: number;
  providerMayHaveCharged?: boolean;
};

export type BudgetState = {
  id: string;
  orgId: string;
  projectId: string | null;
  agentDefId: string | null;
  scope: string;
  period: "daily" | "weekly" | "monthly";
  limitCents: number;
  mode: "soft" | "hard";
  windowStart: string;
  spentCents: number;
};

export type ProviderCredential = {
  authMode: ProviderAuthMode;
  secret: string;
  baseUrl: string;
};

export type GatewayDeps = {
  db?: FacilityDb;
  envelopeStore?: EnvelopeStore;
  now?: () => Date;
};

export type EnvelopeStore = {
  putEnvelope: (input: {
    orgId: string;
    requestId: string;
    payload: unknown;
    now: Date;
  }) => Promise<string | null>;
};
