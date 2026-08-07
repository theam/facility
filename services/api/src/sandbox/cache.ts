import { createHash, createHmac } from "node:crypto";
import type { AppConfig } from "../types.js";

const CACHE_PARTITION_DOMAIN = "facility/codebuild-cache/v1";
const SANDBOX_NAMESPACE_DOMAIN = "facility/docker-sandbox-namespace/v1";

// A cache partition is a capability, not an identifier. Derive it with the
// control-plane key so repository code cannot calculate another project's S3
// prefix from public organization/project ids.
export function sandboxCachePartition(secretMasterKey: string, orgId: string, projectId: string) {
  return createHmac("sha256", Buffer.from(secretMasterKey, "base64"))
    .update(CACHE_PARTITION_DOMAIN)
    .update("\0")
    .update(orgId)
    .update("\0")
    .update(projectId)
    .digest("hex");
}

/**
 * Stable, opaque ownership boundary for Docker sandboxes on a shared daemon.
 *
 * An explicit Facility instance id survives database moves. Local installs do
 * not require one, so their fallback binds the namespace to a credential-free
 * database endpoint and the deployment master key. Password rotation therefore
 * does not orphan live sandboxes, while two databases sharing one Docker daemon
 * cannot sweep each other's containers.
 */
export function sandboxNamespace(
  config: Pick<AppConfig, "databaseUrl" | "facilityInstanceId" | "secretMasterKey">,
) {
  const explicit = config.facilityInstanceId?.trim();
  if (explicit) {
    return createHash("sha256")
      .update(SANDBOX_NAMESPACE_DOMAIN)
      .update("\0")
      .update(explicit)
      .digest("hex")
      .slice(0, 32);
  }
  const database = new URL(config.databaseUrl);
  const databaseIdentity = `${database.protocol}//${database.hostname}:${database.port}${database.pathname}`;
  return createHmac("sha256", Buffer.from(config.secretMasterKey, "base64"))
    .update(SANDBOX_NAMESPACE_DOMAIN)
    .update("\0")
    .update(databaseIdentity)
    .digest("hex")
    .slice(0, 32);
}
