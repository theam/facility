---
title: Production hardening
---

# Production hardening

This checklist supplements the [security model](security.md). It assumes Facility agents are
trusted as maintainers of their configured repositories and focuses on protecting the instance,
tenants, credentials, persistent state, and merge boundary.

## Identity and authorization

- Use GitHub or OIDC authentication in production; `FACILITY_INSECURE_DEV=1` is refused outside
  loopback development.
- Restrict GitHub sign-in to an organization when appropriate, or enforce membership in the OIDC
  provider.
- Assign the smallest Facility role needed to human and API principals, even though agents receive
  broad project execution capability.
- Prefer project-scoped API keys for automation that needs only one project. Store plaintext only
  when the key is created and rotate it on personnel or system changes.
- Review members, roles, keys, audit events, and suspended GitHub installations regularly.

## GitHub

- Install the App only on repositories Facility may automate.
- Grant the documented permission set and alert read permissions; unavailable scanner data must be
  shown as unavailable rather than clean.
- Protect default and release branches, require current CI and review, and decide explicitly whether
  the App may bypass those rules.
- Rotate the App private key and webhook secret through a controlled overlap window.
- Monitor App audit events, installation changes, force pushes, branch-rule changes, and unexpected
  workflow edits.

## Network and origins

- Terminate TLS for web/API/MCP and preview traffic and redirect or reject plaintext traffic.
- Put previews on a registered site separate from every control-plane origin, not merely another
  subdomain of the same site.
- Preserve the original host and WebSocket upgrade semantics at the reverse proxy. Configure the
  preview-surface marker only between trusted proxy and API.
- Restrict database, queue, and provider administration to private networks or explicit operator
  identities.
- Apply egress controls only if they remain compatible with repository, package registry, engine,
  and test dependencies. Facility agents otherwise expect normal network access.

## Secrets and keys

- Generate `SECRET_MASTER_KEY` from 32 random bytes, encode it as canonical base64, and back it up
  separately from PostgreSQL.
- Store OAuth, OIDC, GitHub App, Vercel, and project values in a managed secret store rather than
  image layers, Terraform state values, or source control.
- Give API and worker only the variables they require and keep project values under the
  `FACILITY_PROJECT_<PROJECT_ID>_<NAME>` namespace.
- Rotate provider and engine credentials after a workspace compromise. Secret redaction is a log
  safeguard, not a defense against deliberate exfiltration by executable code.
- Never expose the Vercel token, GitHub App private key, database URL, or master key to a story
  workspace.

## Workspaces

- Run Docker-backed workspaces on a host dedicated to this trusted workload. The control plane
  needs Docker administration even though agents receive only a workspace-scoped daemon.
- Encrypt provider storage and snapshots, restrict operator access, and monitor retained bytes and
  snapshot counts.
- Maintain an inventory from story id to provider reference and durable volume. Do not use broad
  cleanup scripts based only on resource name patterns.
- Set a documented retention decision for done and archived stories. Facility intentionally does
  not delete them by age.
- Recover valuable branches, patches, artifacts, and local files before explicit deletion.

## Database and backups

- Use encrypted PostgreSQL storage, TLS connections, least-privilege runtime credentials, automated
  backups, and point-in-time recovery where available.
- Back up workspace volumes or snapshots according to the same recovery objective. Database-only
  backup is not an end-to-end Facility backup.
- Restore both layers into an isolated environment on a schedule and verify a retained story can
  show its conversation, wake its workspace, inspect Git state, and resume an engine session.
- Protect migration execution as an administrative job. Take a restorable backup before upgrades
  and follow the versioned database compatibility guide.

## Monitoring and response

Alert on API readiness, worker queue age, failed turns, provider errors, webhook rejection rates,
GitHub reconciliation lag, database capacity, workspace storage, preview authorization failures,
cost collection gaps, and budget thresholds.

Retain API, worker, web, migration, provider, GitHub, and identity-provider audit logs for the period
your incident process needs. Correlate with Facility's `x-request-id`, delivery id, story id, turn
id, workspace id, and provider reference. Do not put request bodies or decrypted secrets into log
aggregation merely to simplify debugging.

For a suspected compromise:

1. suspend affected workspaces without deleting evidence;
2. revoke Facility API keys, preview sessions, GitHub installation access, and provider credentials
   as required;
3. preserve database, workspace, and log evidence;
4. inspect branches, pull requests, workflows, releases, and external requests;
5. rotate exposed credentials and repair repository rules; and
6. restore or delete the workspace only after the investigation decides which state is trustworthy.

## Release and dependency controls

Run the complete repository verifier and Docker workspace acceptance tier for changes to
authentication, authorization, secrets, budgets, billing, webhooks, previews, GitHub credentials,
or workspace execution. Require unit and integration coverage for successful and denied paths.
Build immutable images, scan them, and deploy by digest or immutable tag after migrations succeed.
