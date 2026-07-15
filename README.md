<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="facility" width="360">
  </picture>
</p>

<p align="center"><em>The platform that governs your AI SDLC.</em><br>
<sub>Agents build. People decide twice. Everything gets measured.</sub></p>

<p align="center">
  <a href="https://github.com/theam/facility/actions/workflows/ci.yml"><img src="https://github.com/theam/facility/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-161B22" alt="node >= 22">
  <img src="https://img.shields.io/badge/license-MIT-FFD923" alt="MIT">
</p>

---

Wiring an AI agent into a repository is now the easy part. The second month is
where it breaks — not in the model, in the **factory around it**. Provider keys
and budgets sprawl across repo secrets, invisible in aggregate. Upgrading the
method means re-vendoring files repo by repo. Knowledge forks silently. Humans
have no inbox for the decisions agents need. And the run data that would tell
you whether any of it works evaporates.

The method is proven — this SDLC has run [The Agile Monkeys](https://theagilemonkeys.com)'
own products in production since August 2025, the system shown at
[sdlc.theagilemonkeys.com](https://sdlc.theagilemonkeys.com). What was missing
is the control plane. **Facility is that control plane** — self-hostable by any
organization on any cloud, governing identity, money, knowledge, execution, and
the two human gates across every project.

## Two things in one repo

**The platform** (this monorepo) — a control plane you self-host:

```
docker compose up            # postgres · minio · api · worker · gateway · web
```

**The installer** (`@theam/facility`) — the original CLI that vendors the SDLC
into a single repo, unchanged and still first-class:

```
npx @theam/facility init
```

The platform *productizes* the installer: kickstart renders the same proven
asset set server-side and opens a PR, then keeps the repo governed — fingerprints,
upgrades, budgets, telemetry, live sessions.

## What the platform owns

Execution stays where it belongs — GitHub repos, CI, isolated sandboxes. The
platform owns what has to be centralized to govern an operation:

| pillar | what it does |
|---|---|
| **Projects & governance** | many projects per org; kickstart a repo to a working factory in minutes; repo **fingerprints** detect drift/corruption; **upgrades** arrive as PRs; the whole method is versioned |
| **Sandboxes & sessions** | isolated cloud sandboxes for Claude Code / Codex / BYO; **watch any run live and steer a stuck agent**, on the record; driver-based (Docker local, Fargate cloud) |
| **Gateway & cost** | every model call routes through the LLM proxy — project **virtual keys**, hard **budgets**, cost by model/agent/task, and optional full request/response **envelope capture** (when object storage is configured) |
| **Harness** | skills, rules, agent contracts, guards, templates — versioned, bundled, immutable once published; define project-specific agents declaratively via the web, API, CLI, or MCP |
| **Watchtower** | outcomes, health, the canary — per project, monitor-independent, live numbers never curated |
| **Inbox** | one place for every decision an agent needs — plan gates, learning validations, budget overrides — approve/reject/steer, fully audited |
| **Knowledge & the Project Owner** | a Limina-style agent owns the project domain, maintains a validated knowledge base, and turns needs into implementation tasks; **learning mode** proposes new skills and guards nightly, human-validated |
| **Access** | WorkOS SSO for humans, scoped API keys for machines, one RBAC for web, CLI, **MCP**, and agents — the platform is safely operable from Claude Code, Cowork, and Codex |

Privileged actions are hash-chain audited; full request/response envelopes are
captured when object storage is configured (the store-everything default). Agents
never approve, never merge, never touch protected branches — the two gates (accept
the plan, sign the merge) stay human.

## Architecture

TypeScript monorepo, pnpm + Turborepo:

```
apps/web            Next.js 16 app — the TAM-50 interface
apps/docs           Docusaurus documentation, same brand
services/api        control plane: REST + OpenAPI, authN/Z, audit, webhooks, HITL, worker
services/gateway    the LLM proxy — virtual keys, budgets, metering, envelopes
packages/core       domain logic: permissions, pricing, sealed-secrets, receipts, fingerprints
packages/db         Postgres schema + migrations (Drizzle)
packages/ui         the TAM-50 design system (React)
packages/sdk        typed client generated from the OpenAPI spec
packages/mcp        the platform MCP server
packages/cli        @theam/facility — the vendored installer + platform commands
packages/harness    session protocols: Project Owner + learning mode
runner/             the sandbox agent host (Claude Code / Codex / BYO)
infra/              docker-compose (self-host) · Terraform (AWS reference)
```

Boring where it counts — Postgres, containers, S3-compatible storage; no
cloud-proprietary service in the core path. See
[docs/platform/ARCHITECTURE.md](docs/platform/ARCHITECTURE.md) for the full
topology and the decision record.

## Self-host

```bash
git clone https://github.com/theam/facility && cd facility
cp .env.example .env          # set SECRET_MASTER_KEY: openssl rand -base64 32
docker compose up -d
```

Full guide, production notes, and the AWS Terraform module:
[docs/platform/](docs/platform/) and the docs site (`pnpm --filter @facility/docs dev`).

## Repository automation authentication

`facility init --auth=<mode>` renders one authentication mode consistently into
every generated workflow and records it in `.facility.json`. The default is
`api-key`; enterprises should prefer short-lived WIF or cloud OIDC when their
provider setup supports it.

| mode | GitHub configuration | intended use |
|---|---|---|
| `wif` | `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` variables | Preferred direct-Anthropic enterprise path; short-lived GitHub OIDC exchange |
| `bedrock` | `AWS_ROLE_TO_ASSUME` secret, `AWS_REGION` variable | Amazon Bedrock through an AWS GitHub OIDC role |
| `vertex` | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` variables | Vertex AI through Google Workload Identity Federation |
| `api-key` | `ANTHROPIC_API_KEY` secret | Simple default; use a dedicated, spend-capped test-tier key |
| `oauth` | `CLAUDE_CODE_OAUTH_TOKEN` secret | Compatibility path for a Claude subscription token |

`facility doctor` reads the manifest/workflows, checks the selected mode, and
reports the three configured model tiers. Do not configure multiple modes in the
same workflow; static credentials take precedence over WIF and defeat its purpose.
For `bedrock` and `vertex`, pass provider-compatible model identifiers through the
three `--*-model` flags rather than relying on direct-Anthropic defaults.

## Verification

`pnpm verify` is the release-shaped local acceptance command: lint, typecheck,
output removal plus a cache-disabled build, direct uncached critical integration tests against isolated
test databases, remaining uncached tests, guards, and the high-severity dependency
gate. Clean `docker compose build` is an independent required CI job.

The Docker-backed sandbox E2E is intentionally a separate acceptance tier. Its
required/allowed-skip policy and local command are defined in
[docs/testing.md](docs/testing.md).

## The method

The reasoning behind the loop — why one-shot delivery, why the architect
exists, why the board only moves forward, and the fifteen production hardening
scars that shape every generated workflow — is unchanged and lives in:

- [The method](docs/method.md) — the loop, the roles, the two human gates
- [The watchtower](docs/watchtower.md) — the SDLC watching itself
- [Hardening notes](docs/hardening.md) — fifteen things production taught us
- [Platform PRD](docs/platform/PRD.md) · [Architecture](docs/platform/ARCHITECTURE.md) · [tam-os migration](docs/platform/migration-tam-os.md)

## Status

**v0.3 — private preview.** The platform is new; the method and the installer
are production-proven. The first target tenant is
[tam-os](docs/platform/migration-tam-os.md); its migration is designed to be
additive and reversible, and has been rehearsed — the production cutover is
owner-gated and not yet executed. File layout may still move.

---

<p align="center">
  <img src="assets/mark.svg" alt="" width="28"><br>
  <sub>An initiative by <a href="https://theagilemonkeys.com">The Agile Monkeys</a></sub>
</p>
