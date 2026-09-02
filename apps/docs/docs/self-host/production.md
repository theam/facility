---
title: Production
---

# Production deployment

The permanent 0.12 services are the control API with embedded MCP and webhooks, one worker with the
generic scheduler, PostgreSQL, the web UI, and a workspace provider. The single-host Compose file
uses Docker named volumes. A Vercel Sandbox adapter is also available for managed compute.

Use managed PostgreSQL, HTTPS, encrypted backups, and distinct web, API/MCP, and preview hostnames.
Give the worker Docker access only on a host dedicated to trusted project workspaces. Monitor disk
usage: Facility does not delete worktrees or session volumes by age.

Required secrets include `SECRET_MASTER_KEY`, GitHub App credentials, OAuth credentials, and the
engine credentials made available to workspaces. Installation and engine tokens should be
short-lived where the provider supports it.

Apply migrations before starting API or worker replicas. Do not point 0.12 at a 0.11 database; see
[the upgrade boundary](../reference/upgrade-012.md).
