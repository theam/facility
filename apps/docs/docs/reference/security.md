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

## Dependency security floors

The workspace pins minimum patched versions for transitive dependencies in
`pnpm-workspace.yaml`, with the resolved graph committed in `pnpm-lock.yaml`.
Network dependency floors include `fast-uri` 3.1.7/4.1.4, `ip-address` 10.5.1,
and `undici` 7.29.1 on the affected 7.x line. These address malformed URI
authorities, IPv6 special-use classification and compressed WebSocket error
handling. They do not establish that every dependency advisory is exploitable
through a Facility route, or replace application authorization and egress policy.

The all-severity audit remains part of `pnpm verify`; the refresh does not add
audit exceptions or change existing exceptions. For deployment and verification,
see [release and dependency controls](hardening.md#release-and-dependency-controls).

The docs SVG optimizer `@svgr/plugin-svgo` 8.1.0 declares an unused `deepmerge`
dependency affected by GHSA-gcqx-w48m-w2h4. A version-scoped override removes
that dependency edge rather than ignoring the advisory. Installed-consumer
tests compile and render an SVG through the actual docs webpack loader, verify
custom optimization options and reject malformed input. Reassess the override
when updating SVGR; the all-severity audit remains unchanged.

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

During native turns, the worker renews GitHub credentials before expiry while rechecking execution
and repository scope. Git reads a private turn-local credential file. GitHub CLI uses the same
current credentials through a helper and a private configuration directory, including when a
child shell resets PATH. The GitHub App signing key stays in the control plane.

Native engine processes do not receive a fixed `GH_TOKEN` or `GITHUB_TOKEN`: use Git or `gh api`
for authenticated repository operations. Arbitrary applications that retain their own token copy
cannot observe a later renewal. Project preparation retains its original injected values.
Temporary credential files have owner-only access and are removed when the turn ends. If the
worker crashes, any retained token still expires at GitHub; a resumed turn gets a new credential
session without replacing local files or commits. Renewal errors are reported without secret
values; unavailable or revoked credentials never grant broader repository access.

Facility redacts supplied values from persisted command events and API responses. Redaction cannot
prevent an agent or repository process from intentionally copying a value into a file, commit,
external request, or encoded output. Connect only code and credentials appropriate for the agent
trust model, rotate them after suspected exposure, and use provider-side audit logs.

`SECRET_MASTER_KEY` encrypts stored secrets and must decode from canonical base64 to exactly 32
bytes. Protect it separately from the database backup; losing it can make encrypted data
unrecoverable, while disclosure alongside a database backup defeats that protection.

## Dependency security updates

The reviewed dependency floors include Next.js 16.4.1, MCP SDK 1.31.0, sharp 0.35.5
with bundled librsvg 2.63.2, and shell-quote 1.11.0. Keep the lockfile and transitive
overrides together when upgrading; run `pnpm verify`, including the full-severity
dependency audit and the installed-consumer regression tests. These package updates
do not change database schemas, permissions, or credentials.

External clients using the SDK's HTTP OAuth support must retain the `issuer` field
passed to `saveTokens()` and `saveClientInformation()`. Pre-registered credentials
must identify their issuer; bundled providers must configure `expectedIssuer`.
Credentials stored before issuer binding need to be bound to their known issuer or
cleared for a new sign-in. Facility's SDK-based MCP server and stdio clients are
outside the affected OAuth-client path. See the
[upstream OAuth advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h) for the
client migration requirements.

## Merge and destructive actions

Agent manifests cannot define a custom permission set. Reviewers and scheduled agents have the
same capability as builders. Their prompts define behavior, while GitHub branch protection,
required reviews, and CI remain structural controls for merge.

Optional project workflow policies gate native turns on a current approved plan with exact agent
configuration and full connected repository scope. These are admission gates, not per-command
permissions: agents retain the same native capabilities once admitted. Policy configuration and
final delivery acceptance require interactive, session-bound confirmations with current authority;
MCP can request a human review link but cannot confirm one. Completion rechecks required acceptance
at its protected source-close boundary. Existing projects remain ungated until configured.

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

### Runner Go toolchain security floor

The runner rebuilds its pinned Docker, containerd, RootlessKit, Buildx, Compose,
runc and GitHub CLI sources with Go 1.26.9. That patch release contains the
October 2026 standard-library security fixes. Every source build also replaces
`golang.org/x/net` with v0.60.0, including the Docker CLI and runc builds that
otherwise use their vendored copies. The image build checks the compiler and
effective x/net version embedded in each resulting binary.

These compiler and module checks preserve workspace permissions, retention
behavior and existing scanner exceptions. The release
image scanner and Docker-backed workspace acceptance tier remain required.

References: [Go security release history](https://go.dev/doc/devel/release) and
[x/net v0.60.0](https://pkg.go.dev/golang.org/x/net@v0.60.0).

### Runner container and distribution security fixes

The runner builds containerd 2.3.6 from a checksum-pinned source commit and
replaces the containerd module embedded in Docker Engine, Buildx and Compose
with the same patch release. Its executable build audit rejects a missing,
older or substituted module in any of those binaries. Updating only the
standalone containerd executable would leave the embedded copies unchanged.

The reviewed Debian security refresh invalidates the cached package layer.
The image build requires Chromium and chromium-common at least
155.0.8059.79-1~deb13u1 and libexpat1 at least 2.9.0-1~deb13u1, failing when
the configured package repositories cannot provide those fixes. Scanner
exceptions, workspace permissions and persistence behavior are unchanged.

References: [containerd checkpoint restore advisory](https://github.com/containerd/containerd/security/advisories/GHSA-p7v4-vr35-mj6f)
and [containerd 2.3.6 release](https://github.com/containerd/containerd/releases/tag/v2.3.6).
