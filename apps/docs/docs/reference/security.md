---
title: Security
---

# Security model

Facility's trust boundary is the story workspace, not each command an agent executes. Every agent
is treated like a repository maintainer and can use the full shell, filesystem, network, Docker,
browser, Git, and GitHub capability available to that project. Do not connect a repository unless
that access is acceptable.

## Trust assumptions

Facility assumes that:

- an enabled agent may act with the practical authority of a maintainer on every repository
  connected to its project;
- repository content, issues, pull requests, comments, logs, and web pages may contain hostile or
  misleading instructions;
- the workspace may execute arbitrary repository code and access its declared project credentials;
- branch protection, required checks, and human review remain responsible for merge approval; and
- instance operators control the API, worker, database, workspace provider, GitHub App, and engine
  credentials.

Agent types do not create smaller trust domains. A reviewer, scheduled audit, and builder receive
the same credentials. Only their reviewed prompts and triggers differ.

## Enforced boundaries

Facility still enforces:

- client authentication and tenant/project authorization;
- isolation between workspace processes, networks, and volumes;
- short-lived GitHub credentials scoped to configured project repositories;
- signed, deduplicated GitHub webhooks bound to an installation and organization;
- a per-trigger author gate on GitHub-activated agents that, by default, lets only repository
  owners, members, and collaborators start a turn from issue, comment, pull request, or review
  text;
- authenticated, expiring, revocable preview sessions with membership checks on every request;
- secret redaction from persisted command events and API responses; and
- explicit confirmation and idempotency for durable workspace deletion.

Authorization uses organization membership, roles, and route permissions. Project-scoped API keys
are pinned to one project and cannot enumerate others. Organization administration rejects scoped
keys. Audit events record successful privileged mutations with actor, target, project, and request
id.

GitHub webhook signatures are verified over the raw body before JSON parsing. The installation id
must map to one active organization, and delivery ids are deduplicated within that installation.

Preview traffic uses a registered site separate from control-plane origins. One-time handoffs and
host-only preview cookies prevent untrusted application JavaScript from inheriting the Facility web
session. HTTP and WebSocket requests are authorized continuously rather than only when a preview
URL is created.

## Workspace isolation

Each story has separate provider compute, network context, and durable storage. Docker projects run
against a workspace-scoped nested daemon instead of the Facility host daemon. A workspace still
contains executable code and broad outbound network access, so do not co-host the Docker control
plane with unrelated sensitive workloads.

The Vercel provider supplies the equivalent workspace compute and retained filesystem boundary.
Provider administrators and Facility operators remain capable of accessing provider resources;
encryption and organizational access controls must account for that.

## Credentials and secrets

Workspace GitHub credentials are short-lived installation tokens restricted to repositories
connected to the project. They retain the App's full configured permission set for those
repositories. Engine and project values are injected only when named in `.facility.yml` and
resolved from project-specific operator variables.

Facility redacts supplied values from persisted command events and API responses. Redaction cannot
prevent an agent or repository process from intentionally copying a value into a file, commit,
external request, or encoded output. Connect only code and credentials appropriate for the agent
trust model, rotate them after suspected exposure, and use provider-side audit logs.

`SECRET_MASTER_KEY` encrypts stored secrets and must decode from canonical base64 to exactly 32
bytes. Protect it separately from the database backup; losing it can make encrypted data
unrecoverable, while disclosure alongside a database backup defeats that protection.

## Merge and destructive actions

Agent manifests cannot define a custom permission set. Reviewers and scheduled agents have the
same capability as builders. Their prompts define behavior, while GitHub branch protection,
required reviews, and CI remain structural controls for merge.

Facility does not use per-command receipts or approvals. It also does not merge a pull request as a
side effect of marking a story done. Configure protected branches so an installation token cannot
silently bypass the review policy you expect.

The persistent volume can contain proprietary code, uncommitted changes, dependencies, and native
engine session data. Encrypt storage, back it up according to project requirements, restrict host
access, and delete it only through the explicit lifecycle operation.

Archive, suspend, merge, and error recovery retain that volume. Permanent deletion requires an
explicit confirmation and matching idempotency key and is not recoverable through Facility. Backup
and retention policy must cover both workspace storage and PostgreSQL.

For deployment controls, key rotation, logging, backups, network policy, and incident preparation,
continue with the [hardening guide](hardening.md).
