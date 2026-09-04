---
title: Architecture
---

# Facility Platform — Architecture

**Status**: v1

## 1. Stance

Facility Platform is a **control plane**. Execution — code, tests, and agent sessions — happens in GitHub repositories, CI, and isolated sandboxes. The control plane owns what must be centralized to govern an AI SDLC: identity, policy, money, knowledge, telemetry, and the human gates. Two consequences drive everything below:

1. **Repository lane first.** Existing repositories may already run the SDLC through vendored GitHub workflows. The control plane must add value without breaking them: repositories keep working through the **repository lane** while Facility takes over keys (gateway), telemetry (receipts sink), assets (kickstart/upgrade/fingerprints), and adds governed **control-plane sessions** (Project Owner, learning mode, sandboxed crew). Migration is adoption, not rewrite.
2. **Self-host on anything.** Deployment = containers + Postgres + S3-compatible storage. No cloud-specific service in the core path. Cloud specifics live behind driver interfaces (sandboxes) and IaC modules (deploy).

## 2. Topology

```
                        ┌────────────────────────────────────────────┐
                        │                 Facility                    │
  humans ──────────────▶│  web (Next.js)                              │
  Claude Code/Cowork ──▶│  mcp (stdio/HTTP) ─┐                        │
  terminals ───────────▶│  cli ──────────────┼──▶ api (Fastify)       │
  GitHub ──────────────▶│  webhooks ─────────┘     │    │             │
                        │                          │    ├─ worker     │
  agent sandboxes ─────▶│  gateway (LLM proxy) ────┘    │  (pg-boss)  │
                        │        │                      │             │
                        │   Postgres ── object storage (S3/MinIO)     │
                        └────────────────────────────────────────────┘
                              │ drivers: docker | vercel | aws(dev) │
                                   ▼
                          sandboxes (runner image: Claude Code / Codex / BYO)
```

**Long-running services (containers):**

| service | role |
|---|---|
| `services/api` | control-plane REST API (OpenAPI), authN/Z, GitHub webhooks, SSE session-event streams + long-poll steering, HITL, Harness, analytics queries |
| `services/api` (worker entrypoint) | pg-boss consumers + cron: sandbox reconciliation, durable pull-request delivery, outcome collector, health monitor, canary, learning mode, fingerprint checks, budget rollups |
| `services/gateway` | LLM proxy: virtual keys, provider adapters (Anthropic/OpenAI/BYO), streaming passthrough, usage metering, budget enforcement, full audit capture |
| `apps/web` | Next.js app (TAM-50), talks only to `api` |
| `apps/docs` | Docusaurus static site |

**Per-run infrastructure:** `runner` image — a small agent-host process supervising Claude Code / Codex / BYO CLIs inside the sandbox, streaming structured events to `api`, accepting steering input, calling models only through `gateway` with a run-scoped virtual key.

**Workspace layout:**

```
apps/web            apps/docs
services/api        services/gateway
packages/core       # domain logic: permissions, pricing, fingerprints, template rendering, validation
packages/db         # drizzle schema + migrations
packages/ui         # TAM-50 design system (React)
packages/sdk        # typed client: schema.d.ts generated from OpenAPI + hand-maintained ergonomic contracts (drift-guarded against openapi.json)
packages/cli        # @theagilemonkeys/facility (v0.2 installer + platform commands + bundled templates/)
packages/mcp        # platform MCP server
packages/harness    # session protocols: PO agent, learning mode, KB validation
runner/             # sandbox agent-host + Dockerfiles
infra/              # docker-compose (self-host), terraform/aws (reference deployment), helm (later)
```

## 3. Decisions (ADR digest)

| # | decision | why (alternatives rejected) |
|---|---|---|
| 1 | TypeScript everywhere, Node 24 LTS recommended (22.13+ compatibility), pnpm + Turborepo | one language and one production runtime across api/web/cli/mcp/runner; team fluency; turbo caching. Nx heavier, polyglot unnecessary. |
| 2 | Next.js 16 App Router + React 19 + Tailwind v4 for web | matches Facility's web stack; RSC for fast dashboards. |
| 3 | Fastify 5 + Zod (type-provider) + OpenAPI for api & gateway | schema-first: the SDK's schema.d.ts is generated from the emitted OpenAPI doc and the ergonomic route contracts are hand-maintained on top, guarded against drift by a route-coverage test; mature plugin ecosystem (ws, sse, rate-limit); long-lived Node servers. tRPC rejected (CLI/MCP/GitHub are non-TS-web consumers; OpenAPI is the lingua franca). NestJS rejected (ceremony without payoff). |
| 4 | Postgres 16 + Drizzle ORM | boring, portable, SQL-first migrations; JSONB for payloads; LISTEN/NOTIFY for cheap realtime. Supabase-compatible but not required. |
| 5 | pg-boss for queue + cron | the scheduler needs sub-hour cadence and event triggers; Postgres-backed means zero extra infrastructure for self-host. Redis/BullMQ rejected as a core dependency. |
| 6 | SSE for run-event streams; steering via POST + long-poll inbox | SSE and long-poll both survive proxies/load-balancers; no WebSocket surface is implemented (a bidirectional WS steering channel remains a possible future enhancement). |
| 7 | S3-compatible object storage abstraction (MinIO in dev) | transcripts/envelopes are too big for PG; S3 API is the portable denominator. |
| 8 | Stored secrets sealed at rest (libsodium sealed-box, master key from env/KMS) | provider keys, OAuth artifacts, and integration signing secrets are sealed in the DB; GitHub App and OAuth signing keys come from the deployment secret manager. |
| 9 | GitHub identity for humans; hashed API keys for machines; **per-instance MCP OAuth** | Self-hosted instances use direct GitHub OAuth; SaaS instances consume the commercial broker over OIDC. Each instance publishes its own OAuth authorization server and audience-bound MCP tokens so upstream GitHub credentials are never accepted as Facility credentials. |
| 10 | RBAC = permission-string catalog; bundled roles + custom roles | `resource:action` grants at org/project scope; custom roles are named permission sets — no policy-engine dependency (OPA rejected for v1: complexity without a customer). |
| 11 | Audit = append-only `audit_events`, hash-chained per org | tamper-evident without external infra; gateway keeps full request/response envelopes (bodies in object storage). "Store everything by default." |
| 12 | Sandbox drivers: `docker` (local/self-host), `vercel` (production managed), and `aws` (CodeBuild/Fargate development provider) behind one interface | the control plane owns one lifecycle while compute remains replaceable; Vercel supplies fast Firecracker Sandboxes, project-scoped OCI images, public preview routes, and nested Docker without adding Facility services. |
| 13 | Dual-lane execution: repository lane (compatibility) + control-plane lane (sandboxed) | existing repositories keep their vendored workflows on day one; the control-plane lane runs Project Owner/learning/crew sessions in governed sandboxes. Cutover is per trigger and human-gated. |
| 14 | HITL uses action types, resolvers, and an append-only ledger | typed actions support different approval workflows while the ledger preserves every human decision. |
| 15 | KB native storage in Postgres (entries + typed frontmatter + link graph) with git export | write-time validation and graph queries need a DB; git remains the interchange and audit format. |
| 16 | Docusaurus 3 for docs | static output fits self-hosting and the theme can share Facility's visual system. |
| 17 | The v0.2 template set ships in `packages/cli/templates` as **system template v1**, rendered server-side at kickstart | the installer's proven output is the platform's kickstart contract; fingerprints are computed from rendered output. |
| 18 | All 15 hardening notes carry over as platform invariants | SHA-pinned actions in rendered workflows, slash-command parsing, bot-refusal, message-hash canary, App-identity pushes, untrusted-text framing, secret normalization, fork gating. They are encoded in templates, webhook handlers, and guards — not prose. |
| 19 | Receipts: `facility.run.v1` is a compatible superset of the legacy receipt schema | existing repositories can keep emitting their schema for provenance-attested ingestion, while control-plane sessions emit the superset. The receipt SHA-256 detects accidental or post-production changes; authenticity comes from the separately verified GitHub Actions attestation or the Facility-owned runner, not from the self-hash. Privacy boundary preserved: metrics only, hashed actors, never prompts/bodies/tool IO. |
| 20 | Mutating MCP tools become durable HITL proposals approved by a different principal | A write call records the exact tool, arguments, permission, target scope, and requester in the proposal ledger; it performs no mutation. A separate human principal with `hitl:decide` approves or rejects it, and the API executes only an explicit allowlist with target-scope revalidation. This survives client disconnects, is fully audited, and prevents an MCP credential from approving its own request. |
| 21 | Receipt integrity: Facility-owned runner supervises telemetry | legacy collectors are digest-pinned from the default branch so agents cannot tamper with their own telemetry; in control-plane sessions the runner process, outside the agent's write reach, owns receipts and preserves the same property structurally. |

## 4. Domain model

Scoping chain: **org → project → resource**. Every table carries `org_id` (and `project_id` where applicable); every query is scope-filtered; RBAC checks scope + permission.

- **Identity**: `users`, `user_identities` (stable GitHub numeric subject), `orgs`, `org_members`, `roles`, `api_keys`, and sealed OAuth artifacts.
- **Projects**: `projects` (slug, settings, system_version, board config), `repos` (project_id, installation_id, owner/name, default_branch), `github_installations` (App install per org), `repo_fingerprints` (manifest jsonb: path+sha256+template version, status ok|drifted|corrupted, verified_at).
- **Harness** (stored in the `registry_*` tables for API compatibility): `registry_items` (kind: skill|rule|agent_contract|harness|guard|module|template_set; scope org or project or bundled), `registry_versions` (content, content_hash, status draft|active|deprecated, created_by), `bundles` (recommended sets). Bundled v1 = v0.2 crew + modules + prompts.
- **Agents & sessions**: `agent_defs` (name, engine claude-code|codex|byo, model tier, contract → Harness, harness → Harness, triggers jsonb, sandbox_profile_id, permission set), `sandbox_profiles` (image, deps, provision_cmd, env refs, resources, driver), `runs` (the compatibility storage name for session execution records: agent_def, trigger, status queued→provisioning→running→awaiting_human→succeeded|failed|canceled, receipt, GitHub issue/PR refs), `run_deliveries` (one exact-SHA-bound pull-request intent per successful builder run, retried by the existing worker), `run_events` (structured session stream: tool calls, checkpoints, logs → object storage for bulk), `steer_messages` (session steering log).
- **Money**: `provider_credentials` (org, provider, sealed secret), `virtual_keys` (project/run scope, hash, budget refs, allowed models), `llm_requests` (key, run, provider, model, tokens, cost_cents, latency, status, envelope URIs; a single table with time/attribution indexes — partitioning is a future scale step, not yet implemented), `budgets` (scope org|project|agent_def, period, limit_cents, mode soft|hard), `spend_counters` (fast-path cache for gateway enforcement).
- **HITL**: `action_types` (name, payload JSON schema, resolver_type emails|permission|team|dynamic, executor internal|webhook|none), `proposals` (action_type, payload, context_md, project, run, current_state), `proposal_events` (append-only: draft→open→review_presented→approved|rejected|cancelled|expired, executed|execution_failed). A `plan_acceptance` review context distinguishes the commit used to produce the plan (`planBaseSha`), the commit shown beside the decision (`presentedBaseSha`), and the commit admitted by the Builder freshness check. Web decisions reference a short-lived, server-created `review_presented` event; GitHub `/builder` decisions reference the immutable context stored with the published plan comment. The internal executor links an approved architect run to a newly queued builder run; Gate 2 remains GitHub review and merge.
- **Knowledge**: `kb_spaces` (project), `kb_entries` (type H|E|F|L|CR|SR|custom, number, slug, frontmatter jsonb, body md, status), `kb_links` (typed edges, bidirectionality enforced), `po_tasks` (kb trace, gh issue ref, wsjf value/time/risk/effort, board status mirror).
- **Observation**: `audit_events` (append-only, hash-chained, actor human|agent|system, action, target, payload), `platform_issues` (kind drift|budget_breach|run_failure|stuck_session|guard_failure|canary_failure|integration_error, fingerprint dedupe, state open|acked|resolved), `outcomes` (raw PR fate plus nullable evidence-backed acceptance, linked issue, human merger, verified merge method, review/fixup counts, issue-to-merge lead time), `analytics_daily` (per project × agent × model rollups with assessed and accepted counts).
- **Integrations**: `integrations` (kind github|webhook|slack|…, config, sealed secret), `inbound_events` (raw, verified, routed).

## 5. Key flows

**Kickstart (greenfield or existing repo)**: web/CLI/MCP → api: choose repo (via App installation) + answers (defaults prefilled by stack detection — port of v0.2 `detect.mjs` reading the repo via API) → `packages/core` renders template set v1 (same engine as v0.2 `render.mjs`) → api commits to branch `facility/kickstart` via App token → opens PR → stores fingerprint manifest → HITL proposal "kickstart PR ready" → human merges (gate). Platform never pushes to protected branches.

**Fingerprints & upgrade**: push webhook → if managed paths touched, recompute hashes vs manifest → mismatch ⇒ `platform_issues(kind=drift)` + inbox item. Upgrade: render latest template set vs manifest three-way (v0.2 pending `update` roadmap item, platform-side): clean apply → PR; conflict → PR with conflict report. Fingerprint updates only on merge webhook.

**Control-plane session**: trigger (slash command webhook, schedule, manual, MCP) → `runs` compatibility row → worker picks up → driver provisions a sandbox from the profile → runner boots: clones the repository (installation token, least scope), runs `provision_cmd`, launches the engine with contract + skills from the Harness, and points provider base URLs at the gateway with a session-scoped virtual key → events stream to the API (SSE fan-out to web; transcript JSONL to object storage) → agent finishes → the terminal run and exact branch/SHA delivery intent commit together → sandbox destroyed → the same worker creates or adopts only the matching draft pull request and records the outcome. Transient GitHub failures retry with capped backoff; owner, repository, base, or SHA drift blocks delivery for operator review instead of attaching the receipt to different code. A stuck session remains enterable and steerable, with every intervention audited.

**Gateway request**: sandbox/proxy client → `POST /v1/{provider}/…` with virtual key → key lookup (cache) → budget check (hard-stop ⇒ 402 envelope) → model policy check → forward to provider with org's sealed credential → stream back; tee usage (tokens from provider usage blocks; cost from `packages/core` price table) → `llm_requests` + spend counters + envelopes to storage. p99 overhead target ≤ 20ms + provider latency, backpressure-safe streaming.

**Watchtower**: repository-lane instruments remain vendored and read the GitHub
API directly rather than Facility telemetry. The platform worker runs per
project: outcomes collect independent GitHub evidence into `outcomes`; health
combines GitHub workflow and budget evidence with control-plane run, gateway,
and dispatch state into `platform_issues`; repository-lane canaries verify the
GitHub workflow, while platform-lane canaries dispatch a pinned control-plane
run and count it as passing only when independent GitHub canary evidence
corroborates its success.

**Learning mode**: nightly cron per enabled project → sandbox session with the learning harness: reads the day's sessions/reviews/failures (via API, read-only key) → drafts proposals (new skill/rule/KB entries/guard candidates — the ratchet) → each proposal = HITL item with diff preview → human approves ⇒ Harness version created (draft→active) / KB entry committed; rejects ⇒ recorded, feeds next night's context.

**PO agent**: scheduled/event-triggered sandbox session with a recovery protocol (recover from KB `ACTIVE` + charter → work → validate → write) → maintains `kb_entries` through api (frontmatter schema, bidirectional links, DAG creation order) → emits `po_tasks` → GitHub issues in service repos with `## KB trace` + board placement (Projects v2 GraphQL) → HITL for anything crossing a gate.

## 6. Security model

- **Tenancy**: org-scoped rows + mandatory scope filters in the data layer (repository pattern helpers, tested); no cross-org query paths.
- **AuthN**: GitHub OAuth or the SaaS OIDC broker → Facility server session; API keys remain argon2id-hashed, prefix-searchable, revocable, and last-used tracked.
- **AuthZ**: permission catalog enforced in one middleware; deny-by-default; route declares required permission; resource loaders re-check scope. Agents/sessions get least-privilege machine principals (e.g., Project Owner: `kb:write`, `tasks:write`, nothing else).
- **Secrets**: provider keys, OAuth artifacts, and integration signing secrets are sealed at rest; GitHub App and OAuth signing credentials are read from the deployment secret manager and never returned by APIs.
- **Sandboxes**: no provider keys inside — only run-scoped virtual keys (revoked at run end) and short-lived installation tokens scoped to the target repo; egress note in profile; resource limits; destroyed after run.
- **GitHub**: webhook HMAC verification; App identity for pushes/comments (hardening 14); fork-origin gating (hardening 7); rendered workflows keep SHA-pinning, slash-command line-start parsing, bot refusal, canary message-hash (hardening 3/5/10/13/15); repo-originated text handled as data end-to-end — the api never interpolates it into shell, prompts fence it with run-ID sentinels (hardening 4).
- **Audit**: hash-chained `audit_events`; gateway envelopes; steer messages; HITL ledger — everything attributable to a principal.
- **Privacy**: transcripts/envelopes are stored by default but access-controlled per project + permission (the envelope transcript needs `audit:read`); expired by the object store's lifecycle policy (a per-org `retention_days` setting is recorded, app-enforced per-org expiry is a follow-up); telemetry is off by default for self-hosters and requires consent.

## 7. Deployment

- **Self-host quickstart**: `docker compose up` → postgres, minio, api, worker, gateway, web, and MCP. An administrator binds the dedicated org, owner, GitHub account, and installation with `facility instance bootstrap`; login never auto-creates tenancy.
- **AWS reference deployment**: Terraform — VPC, RDS Postgres, S3, ECS Fargate services (api/worker/gateway/web/MCP), unprivileged Fargate preview tasks, ALB, ECR, privileged CodeBuild runner jobs, KMS for master key, CloudWatch logs.
- **Any-cloud claim**: everything is containers + PG + S3-API; drivers isolate compute specifics; helm chart is a documented follow-up with the k8s Job driver.

## 8. What stays deliberately simple (v1)

Single-region; no microservice mesh (3 services); no Kafka (PG outbox + pg-boss); no OPA (permission strings); no bespoke metrics stack (analytics from our own tables; optional webhook sinks); no plugin marketplace (Harness versions + bundles suffice); Codex/BYO engines run through the same runner protocol rather than bespoke integrations.
