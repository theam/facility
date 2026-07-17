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
learning jobs, plus the documentation site. Shared runtime packages are built
before database setup, so a clean clone does not depend on old build artifacts.
It is safe to rerun. Ctrl-C stops the foreground processes while the Docker
infrastructure stays available for the next launch. Because the command seeds
development data, it refuses a non-local `DATABASE_URL`. The HTTP MCP server is
not part of source-watch mode; run its built binary directly or use the full
compose stack below.

To delegate the whole setup to Claude Code or Codex, paste this prompt:

> Set up and launch Facility from this repository. Run `pnpm dev`, fix
> prerequisite errors without replacing any existing `.env` values, wait for
> the services to be ready, then report their local URLs.

To exercise the complete production-shaped stack instead of source-watch mode,
run `SECRET_MASTER_KEY="$(openssl rand -base64 32)" docker compose up -d --wait`.
That stack builds the runner image, migrates and seeds once, and starts the API,
worker, gateway, MCP server, and optional web application together.

Open `http://localhost:3400`, sign in with **dev sign in** (enabled by
`FACILITY_INSECURE_DEV=1` — refused in production builds), and you're in the
seeded organization.

For a production-like check, issue an owner/admin API key and run:

```bash
node packages/cli/bin/facility.mjs doctor --url http://localhost:4400 --key fak_...
```

The command calls `/v1/admin/doctor` and prints the deployment checklist:
database and migrations, worker scheduler heartbeat, object-store envelope write/read round trip, seed
essentials, the `sandbox_runner` profile (driver + runner image, plus Docker
daemon reachability for the docker driver), production `auth_config`, GitHub App
configuration, and audit hash-chain verification.

## Service endpoints

| service | `pnpm dev` | full compose | role |
|---|---:|---:|---|
| `web` | 3400 | 3400 | optional operator app |
| `api` | 4400 | 4400 | control plane (REST + OpenAPI at `/docs` in dev) |
| `gateway` | 4410 | 4410 | LLM proxy — point `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` here |
| `docs` | 3500 | — | documentation site |
| `mcp` | — | 4420 | streamable HTTP MCP (`/mcp`, `/healthz`, `/readyz`) |
| worker | no port | no port | queues + crons (same image as API) |
| postgres | 5461 | internal only | database |
| minio | 9000 | internal only | envelope/transcript storage |

The compose stack uses MinIO for envelopes and auto-creates the configured
bucket (`S3_BUCKET`, default `facility`) during startup. API and gateway sign
object-store requests with AWS SigV4, so the same settings work with MinIO,
AWS S3, R2, and other S3-compatible endpoints.

## First real steps

1. **Providers** — add your Anthropic/OpenAI keys (sealed at rest) with
   `facility providers create --provider openai --name primary --secret …` or
   `POST /v1/providers`.
2. **GitHub App** — create your own App installation (see
   [Production](production)) so kickstart and triggers work against your org.
3. **Kickstart** — connect a repo and open the kickstart PR.

The web application is optional. The complete operating surface is available
through the CLI, REST/OpenAPI + TypeScript SDK, and MCP; see the three reference
pages for exact commands and contracts.
