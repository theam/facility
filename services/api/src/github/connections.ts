import { createPrivateKey } from "node:crypto";
import { open, seal } from "@facility/core";
import { type FacilityDb, githubConnections, githubInstallations } from "@facility/db";
import { App } from "@octokit/app";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { AppConfig } from "../types.js";

export const ConnectionSecrets = z.object({
  privateKey: z.string().min(1).max(20_000),
  webhookSecret: z.string().min(32).max(256),
});
type Scope = { id: string; orgId: string; appId: number };
export type ConnectionSecretsValue = z.infer<typeof ConnectionSecrets>;

export function validatePrivateKey(privateKey: string) {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw new ApiError(
      400,
      "invalid_private_key",
      "Provide a valid RSA private key for the GitHub App",
    );
  }
}

export async function sealConnection(scope: Scope, secrets: ConnectionSecretsValue, key: string) {
  validatePrivateKey(secrets.privateKey);
  return seal(
    JSON.stringify({
      id: scope.id,
      orgId: scope.orgId,
      appId: scope.appId,
      ...ConnectionSecrets.parse(secrets),
    }),
    key,
  );
}

export async function openConnection(scope: Scope & { credentials: string }, key: string) {
  try {
    const decoded = JSON.parse(await open(scope.credentials, key));
    if (decoded.id !== scope.id || decoded.orgId !== scope.orgId || decoded.appId !== scope.appId)
      throw new Error();
    return ConnectionSecrets.parse(decoded);
  } catch {
    throw new ApiError(
      409,
      "github_connection_unavailable",
      "GitHub connection credentials are unavailable",
    );
  }
}

/** Look up on every use: disabled/rotated connections must not fall back to another App. */
export async function installationConfig(
  db: FacilityDb,
  config: AppConfig,
  installationId: number,
): Promise<AppConfig> {
  const installation = (
    await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1)
  )[0];
  if (!installation || installation.suspendedAt)
    throw new ApiError(
      409,
      "github_installation_unavailable",
      "GitHub installation is unavailable",
    );
  if (!installation.connectionId) return config;
  const connection = (
    await db
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.id, installation.connectionId),
          eq(githubConnections.orgId, installation.orgId),
        ),
      )
      .limit(1)
  )[0];
  if (!connection || connection.disabledAt)
    throw new ApiError(409, "github_connection_disabled", "GitHub connection is disabled");
  const secrets = await openConnection(connection, config.secretMasterKey);
  return {
    ...config,
    githubAppId: String(connection.appId),
    githubAppSlug: connection.slug,
    githubAppPrivateKey: secrets.privateKey,
    githubAppWebhookSecret: secrets.webhookSecret,
  };
}

/** No arbitrary API hosts; credentials are sent only to GitHub's App API. */
export async function inspectInstallation(
  appId: number,
  privateKey: string,
  installationId: number,
) {
  validatePrivateKey(privateKey);
  try {
    const app = new App({ appId, privateKey });
    const identity = (await app.octokit.request("GET /app")).data;
    const installation = (
      await app.octokit.request("GET /app/installations/{installation_id}", {
        installation_id: installationId,
      })
    ).data;
    if (
      identity?.id !== appId ||
      installation.app_id !== appId ||
      installation.id !== installationId ||
      installation.suspended_at ||
      !installation.account ||
      !("login" in installation.account) ||
      !identity.slug
    )
      throw new Error();
    return {
      slug: identity.slug,
      installationId,
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      targetType: installation.target_type,
    };
  } catch {
    throw new ApiError(
      400,
      "github_connection_validation_failed",
      "GitHub could not verify the App key and active installation",
    );
  }
}
