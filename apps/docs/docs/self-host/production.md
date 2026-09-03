---
title: Production
---

# Production deployment

The permanent 0.12 services are the control API with embedded MCP and webhooks, one worker with the
generic scheduler and GitHub reconciliation, PostgreSQL, the web UI, and a workspace provider. Cost
accounting, budgets, observability, audit events, analytics summaries, and pipeline state live in
those services. They do not require sidecars or separate control-plane applications.

The single-host Compose file uses Docker named volumes. The [AWS reference deployment](aws.md)
runs the control plane on ECS and RDS while Vercel Sandbox runs and retains story workspaces.

Use managed PostgreSQL, HTTPS, encrypted backups, and distinct web, API/MCP, and preview hostnames.
Give the worker Docker access only on a host dedicated to trusted project workspaces. Monitor disk
usage: Facility does not delete worktrees or session volumes by age.

Required secrets include `SECRET_MASTER_KEY`, GitHub App credentials, OAuth credentials, and the
engine credentials made available to workspaces. Installation and engine tokens should be
short-lived where the provider supports it.

Repositories list required engine and project secret names under `environment.secrets` in
`.facility.yml`. Put each value in the API and worker secret environment as
`FACILITY_PROJECT_<PROJECT_ID>_<NAME>`. For example, project `proj_abc` can declare
`ANTHROPIC_API_KEY` and receive it from `FACILITY_PROJECT_PROJ_ABC_ANTHROPIC_API_KEY`. Facility
never resolves a repository declaration directly against the control process environment, so a
project cannot request `DATABASE_URL`, `SECRET_MASTER_KEY`, or another project's credential.
Rotating or removing a value affects the next turn and does not delete the stored worktree or native
session files.

Apply migrations before starting API or worker replicas. Do not point 0.12 at a 0.11 database; see
[the upgrade boundary](../reference/upgrade-012.md).
