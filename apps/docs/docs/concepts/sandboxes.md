---
title: Sandboxes & sessions
---

# Sandboxes & sessions

Platform-lane agents execute in **disposable, isolated sandboxes** — never on
the control plane, never on your laptop.

## Profiles

A sandbox profile declares the world an agent wakes up in: base image,
dependencies, provision command, resource limits, network posture. Profiles
are versioned and reusable; the seeded default profile runs the platform's
runner image with your project's provision command. The provisioned-site rule
is enforced: if provisioning fails, the agent never starts — a partial
environment produces hedging, not work.

Facility also seeds an **Analysis runner** profile for agents that never ship
repository changes (`architect`, `codex-architect`, `review`, and
`security-sweep`). It keeps the repository's dependency-install phase so tools
can resolve imports and types, but skips service/database/browser provisioning
and disables nested Docker. Builder and repair agents stay on the full default
profile. These are ordinary profile assignments: operators can replace them
without changing agent or runner code. The deploy seed moves unchanged legacy
analysis agents from the managed Default profile once; later operator
assignments are preserved.

The optional `setup.provisioning` capability controls repository setup depth:

- `full` runs dependency installation and provisioning (also the legacy default
  when the key is absent or invalid in persisted data).
- `deps_only` installs dependencies but skips the repository provision command.
- `none` skips both phases.

Command overrides remain strings (`package_install_cmd` and `provision_cmd`). A
profile write is rejected when it configures a command for a phase its
`provisioning` depth disables.

:::note The runner image & driver
A **platform-lane** run (Claude Code, Codex) needs a sandbox profile whose
**driver matches the deployment** and that can run the Facility runner:

- **docker** (local/self-host) — the profile's image entrypoint must be the
  runner. Build it with `docker build -f runner/Dockerfile -t facility-runner:dev .` and set
  `FACILITY_RUNNER_IMAGE` (default `facility-runner:dev`). A bare base image like
  `node:24-trixie` only supports **BYO-command** runs.
- **vercel** (production managed path) — Facility boots the runner from the
  configured project's Vercel Container Registry, starts its lifecycle command
  inside an ephemeral Sandbox, and stores only an opaque sandbox/command
  reference. `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and a scoped `VERCEL_TOKEN`
  (or workload `VERCEL_OIDC_TOKEN`) bind every lookup to one project. Restricted
  profiles use the Vercel firewall; preview profiles expose only their declared
  port through a `*.vercel.run` route. Set `FACILITY_SANDBOX_DRIVER=vercel` and
  make `FACILITY_RUNNER_IMAGE` a runner image pushed to that project's VCR.
- **aws** (CodeBuild) — each run starts a private CodeBuild job using the runner
  image fixed in the deployed CodeBuild project. Profile image overrides are
  deliberately ignored: an editable image cannot inherit the project's AWS
  service role before the sandbox boundary exists. Privileged mode lets
  provisioning launch nested Docker services such as local Supabase. Nested
  Docker is rootless and reachable by agent commands only through a restricted
  API proxy; the runner credential and raw daemon socket use separate UIDs. Set
  `FACILITY_SANDBOX_DRIVER=aws` so the seeded default profile uses that driver.

  An AWS profile's optional `setup.cmd` replaces Facility's lifecycle runner.
  It runs as the unprivileged sandbox UID and keeps the run-scoped lifecycle
  token so it can report events and its final result. Treat `sandboxes:*` as a
  trusted lifecycle-administration permission; repository/model children do not
  receive that token.

`facility doctor` **fails** its `sandbox_runner` check when no profile matches
the deployment's driver (a docker profile can't launch on an aws stack, or vice
versa), so a false-ready deployment surfaces before the first run. For the docker
driver the check also probes the Docker daemon (fails if unreachable) and **warns**
when the configured runner image isn't present locally — the first run would pull
it, which fails for a local-only tag or an unreachable registry. The probe runs in
the **api** task, so give the **worker** (which actually launches sandboxes) the
same Docker socket access; the api-side probe is a readiness proxy for the worker,
exactly as the object-store check is.
:::

## Drivers

Execution is driver-based: local Docker for development and self-hosting,
Vercel Sandbox as the production managed path, and AWS CodeBuild as an optional
development provider. The control plane sees one contract: launch, recover,
status, logs, stop, destroy. Provider tokens never enter the sandbox command.

Vercel previews reuse that same adapter. The preview command and port produce a
short-lived `*.vercel.run` origin, while Facility keeps its existing session
handoff and isolated reverse-proxy origin. That preserves one preview access
model without a preview scheduler, warm pool, or another service.

AWS preview environments remain the deliberate exception to that backend:
they need a private inbound service endpoint, which CodeBuild does not expose.
The AWS module therefore registers an immutable, unprivileged ECS Fargate task
definition for each preview image while agent runs remain on privileged CodeBuild.
Endpoint discovery and the ECS `RUNNING` check share one bounded launch window;
unusually slow tasks remain `provisioning` and converge through the existing
lifecycle reconciler instead of creating another scheduler or warm-pool service.

## What's inside (and what isn't)

Inside the sandbox: the repo checkout, the agent CLI (Claude Code, Codex, or
your own), the operating contract, the project's skills, and a **run-scoped
virtual key** whose only power is calling models through the gateway. Not
inside: provider API keys or subscription tokens, GitHub App credentials,
platform secrets. The
runner authenticates back to the platform with a one-time token and fetches
exactly what the run needs.

## Live sessions & steering

Every run streams structured events — status, tool use, checks, output — to
the platform. Open any run to watch it live or replay it later. When an agent
is stuck, an engineer can **steer**: send it a message from the run view, on
the record. The message is recorded in the transcript and audit log and
delivered to the run's steering inbox (`STEERING.md`), which the agent picks up
as it works — for the non-interactive Claude/Codex CLIs that means between turns,
not mid-token. Diagnosing a wedged session no longer means SSH and guesswork.
