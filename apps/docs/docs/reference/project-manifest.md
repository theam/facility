---
title: Project manifest
---

# `.facility.yml` reference

The primary repository's `.facility.yml` is the complete workspace environment contract. Facility
loads it from the repository default branch when it starts or prepares a story. The schema is
strict: unknown keys, duplicate YAML keys, aliases, invalid names, and wrong value types fail the
operation.

## Complete example

```yaml
version: 1
repositories:
  primary: github.com/acme/application
  related:
    - github.com/acme/contracts
environment:
  image: ghcr.io/acme/facility-runner:2026-09-01
  setup: corepack enable && pnpm install --frozen-lockfile
  seed: pnpm db:seed
  start: docker compose up -d
  ready: curl --fail --silent http://127.0.0.1:3000/health
  stop: docker compose down
  browser_test: pnpm test:e2e
  secrets:
    - ANTHROPIC_API_KEY
    - TEST_DATABASE_PASSWORD
  variables:
    - PAYMENT_PROVIDER_MODE
  services:
    app:
      port: 3000
      protocol: http
      websocket: true
    mail:
      port: 8025
      protocol: http
      websocket: false
```

## Top-level fields

| Field | Required | Contract |
| --- | --- | --- |
| `version` | No | Must be `1`; omitted values default to `1`. |
| `repositories` | Yes | Strict repository checkout object. |
| `environment` | Yes | Strict environment command and service object. |

## `repositories`

| Field | Required | Contract |
| --- | --- | --- |
| `primary` | Yes | `github.com/owner/repository`; an HTTPS prefix and `.git` suffix are accepted and normalized. |
| `related` | No | Array in the same format; defaults to `[]`. |

The primary repository owns `.facility.yml`, `.agents/`, and the story branch. Facility checks out
each connected repository under `repos/<owner>/<repository>`, fetches updates, and configures a
workspace Git identity. The primary checkout is switched to the durable story branch. Related
repositories remain available to the agent and environment.

The manifest cannot grant access to an arbitrary repository. Every listed repository must also be
connected to the Facility project and available through its GitHub App installation.

## `environment`

| Field | Required | Contract |
| --- | --- | --- |
| `image` | No | Workspace runner image, 1–500 characters. The instance default is used when omitted. |
| `setup` | No | Shell command, 1–4,000 characters. Runs when the setup checksum changes or clean setup is requested. |
| `start` | Yes | Shell command, 1–4,000 characters. Runs on every environment preparation. |
| `ready` | No | Shell command polled until it succeeds or readiness times out. |
| `stop` | No | Accepted stop command. The story lifecycle suspends provider compute and does not invoke it automatically. |
| `seed` | No | Shell command run after `setup` when setup is due. |
| `browser_test` | No | Shell command used by the browser-test operation. |
| `secrets` | No | Array of declared secret names; defaults to `[]`. |
| `variables` | No | Array of declared non-secret operator-value names; defaults to `[]`. |
| `services` | No | Named preview services; defaults to `{}`. |

Commands run from the primary repository path. They receive the declared project values and
short-lived repository credentials. Command output becomes an environment event, with supplied
secret values redacted before persistence.

The setup checksum covers the exact manifest source and the primary checkout's current HEAD. A wake
can skip `setup` when that checksum is unchanged, but it always runs `start`. `seed` is coupled to
setup so a normal wake does not repeatedly seed the environment.

Make `start` safe to repeat. It should return after bringing services up; use a detached Compose
command, process manager, or equivalent. Make `ready` fail quickly while the service is unavailable
and succeed only when a user can exercise it.

## Secrets and variables

Names must match `[A-Z][A-Z0-9_]{0,127}`. Names are stored in Git; values are not. For project
`proj_abc`, the operator supplies `API_TOKEN` as:

```text
FACILITY_PROJECT_PROJ_ABC_API_TOKEN
```

The general form is `FACILITY_PROJECT_<PROJECT_ID>_<NAME>`. Facility project ids contain lowercase
letters, digits, and underscores; Facility uppercases the id when forming the operator name. The
API and worker need the same values. Missing values fail preparation with the missing operator
names. A project cannot request undeclared control-plane variables such as `DATABASE_URL` or
another project's values.

`secrets` and `variables` use the same injection mechanism. The distinction records operator intent
and supports safe presentation; do not put a credential under `variables`.

## Services

Service names must be lowercase kebab case beginning with a letter and no more than 63 characters.
Each value is strict:

| Field | Required | Default | Contract |
| --- | --- | --- | --- |
| `port` | Yes | — | Integer from 1 through 65,535. |
| `protocol` | No | `http` | `http` or `https` for the workspace endpoint. |
| `websocket` | No | `true` | Whether the authenticated proxy accepts WebSocket upgrades. |

The preview always reaches the service in this story's live workspace. Declaring a service does not
start it and does not make it public; `start` and `ready` remain responsible for availability, and
Facility's preview handoff provides authenticated browser access.

## Browser test artifacts

When `browser_test` runs, Facility sets `FACILITY_ARTIFACT_DIR`. Write screenshots, traces, logs,
and reports beneath that directory. Facility records the resulting files as story artifacts and
returns their identifiers and URIs with the operation result.

## Validation

Run `facility doctor` for local feedback. The server parser is authoritative and loads the merged
file from the primary repository. A changed manifest affects future environment preparation; it
does not mutate historical turn records or delete an existing workspace.
