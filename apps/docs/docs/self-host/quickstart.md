---
title: Quickstart
---

# Self-host quickstart

Facility is containers + Postgres + S3-compatible storage. Nothing else.

## Development / evaluation

With Node.js 22 or newer, pnpm 11, and Docker running:

```bash
git clone https://github.com/theam/facility.git
cd facility
corepack enable
pnpm dev
```

The command creates `.env` when needed and fills only blank required development
values; it never replaces configured values. It then starts Postgres and MinIO,
installs the workspace, migrates and seeds the database, and launches every
development process — including the **worker** for run dispatch, watchtower, and
learning jobs. Shared runtime packages are built before database setup, so a
clean clone does not depend on old build artifacts. It is safe to rerun. Ctrl-C
stops the foreground processes while the Docker infrastructure stays available
for the next launch. Because the command seeds development data, it refuses a
non-local `DATABASE_URL`.

To delegate the whole setup to Claude Code or Codex, paste this prompt:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing any existing `.env` values, wait for
> the services to be ready, then report their local URLs.

Open `http://localhost:3400`, sign in with **dev sign in** (enabled by
`FACILITY_INSECURE_DEV=1` — refused in production builds), and you're in the
seeded organization.

For a production-like check, issue an owner/admin API key and run:

```bash
facility doctor --url http://localhost:4400 --key fak_...
```

The command calls `/v1/admin/doctor` and prints the deployment checklist:
database and migrations, object-store envelope write/read round trip, seed
essentials, the `sandbox_runner` profile (driver + runner image, plus Docker
daemon reachability for the docker driver), production `auth_config`, GitHub App
configuration, and audit hash-chain verification.

## What's running

| service | port | role |
|---|---|---|
| `web` | 3400 | the app |
| `api` | 4400 | control plane (REST + OpenAPI at `/docs` in dev) |
| `gateway` | 4410 | LLM proxy — point `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` here |
| `docs` | 3500 | documentation site |
| worker | — | queues + crons (same image as api) |
| postgres | 5461 | the database |
| minio | 9000 | envelope/transcript storage |

The compose stack uses MinIO for envelopes and auto-creates the configured
bucket (`S3_BUCKET`, default `facility`) during startup. API and gateway sign
object-store requests with AWS SigV4, so the same settings work with MinIO,
AWS S3, R2, and other S3-compatible endpoints.

## First real steps

1. **Providers** — add your Anthropic/OpenAI keys (sealed at rest) from the web
   **Settings → providers** page, or via the v1 API (`POST /v1/providers`); there
   is not yet a dedicated CLI command.
2. **GitHub App** — create your own App installation (see
   [Production](production)) so kickstart and triggers work against your org.
3. **Kickstart** — connect a repo and open the kickstart PR.
