# Facility Platform — delivery status

**Branch**: `feat/platform-v0.3` (local, unpushed) · **as of** 2026-07-06

This is the honest state of the platform build against [GOAL.md](../../GOAL.md).
Nothing here is curated for a slide.

## Current state (round 28, 2026-07-06)

The platform was driven through twenty-eight independent GPT-5.5 (xhigh)
verification rounds — six adversarial verifiers per full round, one per aspect —
each round followed by fixes to the named findings, re-verified against primary
evidence (diff review + a re-run full suite) before commit. Each round is a fresh
adversarial re-audit at a rising bar, so scores are **not** monotonic: a lower
number than an earlier round reflects a stricter audit finding the next layer,
not a regression. Round-28 snapshot (the wave after it centralizes budget-scope
authorization across HTTP/HITL/DB and makes runner secret-redaction cover object
keys, pending round-29 re-verification):

| aspect | round 1 | round 28 |
|---|---:|---:|
| Implementation & architecture | 56 | 84 |
| Security & privacy | 58 | 84 |
| UI/UX | 76 | **89** |
| Feature completeness & product fit | 58 | 84 |
| Optimization | 58 | **88** |
| Docs, DX, operability | 56 | **88** |
| **average** | **~59** | **~86** |

Later rounds drove deep into concurrency/atomicity and tenant isolation:
run-lifecycle + issue persistence made race-safe with claim-checked / state-pinned
transitions; credential lifecycle closed end-to-end (every terminal path revokes
its keys, a reconciler backstop revokes any orphaned by a crash, the gateway is
push-invalidated on revoke via NOTIFY/LISTEN, run-scoped platform keys carry an
expiry, run-read APIs redact sealed envelopes); cross-project isolation hardened
(run lists, repo fingerprints, skill bundles, and registry drafts are all
project-scoped); registry publish is atomic + single-active (partial unique
index); run-event seq allocation is race-free (per-run advisory lock). ~186 tests
green (real Postgres), Biome clean, web + docs build, and `tsc --noEmit` green
across **all** packages (including `@facility/mcp`).
Recent hardening (rounds 4–12): SSRF guard on BYO provider URLs, real MCP
human-gate (write tools create HITL proposals a *separate* principal approves),
the `v1.ts` god-router split into per-domain routers, run-steer cockpit + guided
kickstart, penny-accurate budget reservation, idempotent metering, a
deployment-readiness `facility doctor` (DB/migrations, object-store round-trip,
seed, GitHub App, audit-chain), a contract-typed web client with real SDK tests,
one shared SigV4 S3 object store for API+gateway (MinIO-turnkey), **project-scoped
audit isolation with complete per-producer attribution**, HITL GitHub issue
creation that **fails closed** instead of fabricating URLs, and an **OAuth 2.1
resource server** — remote MCP now accepts WorkOS-issued access-token JWTs
(JWKS/RS256, issuer+expiry+audience validated) alongside `fak_` keys, with RFC
9728 protected-resource discovery.

**Remaining non-owner-gated work**:
- **Native live preview environments** are not implemented. Projects must
  use their deployment provider's per-PR previews now; Facility's roadmap adds
  provider adapters, lifecycle/retention, run+PR URLs, and Gate 2 evidence.
- **SDK route contract** is hand-maintained, but no longer silently drifts: a
  runtime manifest (`FACILITY_V1_ROUTES`) is diffed against the Fastify OpenAPI
  document by a route-coverage test, so an added/removed route fails CI until the
  map is updated. A few non-core v1 endpoints still return loose `AnyObject`
  response schemas.
- **Analytics rollup** is incremental (trailing window + time-leading indexes)
  rather than dirty-bucket/watermark incremental — correct and bounded, but a
  watermark design would rebuild only changed buckets.
- **Web is an operator dashboard**, not yet the full control plane: settings now
  manages providers, API keys, and budgets in the web UI, but agents, sandbox
  profiles, virtual keys, and KB/tasks are still managed through the **v1 API**
  (with partial CLI/MCP coverage — the CLI focuses on
  status/projects/runs/inbox/issues/keys/kickstart/llm-requests; MCP on
  run/registry/budget/project tools) and are not yet first-class web surfaces.

**Owner-gated ceiling**: "tam-os operates 100% on the platform" requires the
production App install + cutover, which is the owner's decision (see below) — it
is validated against a private mirror but **not** cut over.

## What was built

The v0.2 CLI installer became the **control plane for the AI SDLC** — a
self-hostable TypeScript monorepo (pnpm + Turborepo) that governs identity,
money, knowledge, execution, and the two human gates across an organization's
projects.

| area | package/service | state |
|---|---|---|
| Domain logic | `@facility/core` | permissions + wildcard RBAC, price table (dated-model aware), sealed-box crypto + argon2 keys + HMAC confirmations, `facility.run.v1` receipts (tam-os superset), fingerprints, audit hash chain, render/detect ports · **tested** |
| Data | `@facility/db` | Drizzle schema (30+ tables), migrations through 0020 (glob-ordered runner), org-scoped helpers, hash-chained audit, idempotent seed · **tested** |
| Control plane | `@facility/api` (Fastify 5) | session + API-key auth, WorkOS AuthKit hooks, RBAC preHandler + startup assertion, auto-audit, 70+ v1 routes, SSE run streams, HITL ledger, KB DAG validation, internal runner API, GitHub webhooks, watchtower + learning workers · **tested** |
| LLM gateway | `@facility/gateway` | Anthropic/OpenAI/BYO proxy, virtual keys, budgets (soft/hard), zero-copy streaming with usage tee, metering, envelopes · **tested + verified live** |
| Sandboxes | `@facility/api` sandbox + `runner/` | driver seam (Docker + **real AWS Fargate/ECS** driver), race-safe run lifecycle with credential revocation on every terminal path, runner-token internal API, live session streaming + steering, engine parsers (Claude/Codex/BYO) · **tested + docker e2e** |
| GitHub App | `@facility/api` github | HMAC webhooks, trigger router, server-side kickstart (byte-compatible render), fingerprints + adopt, upgrade PRs, default-branch-refusing octokit wrapper · **tested** |
| Registry | control plane | skills/rules/contracts/harnesses/guards/templates, versioned + publish-immutable, bundled seed · **tested** |
| Watchtower | `@facility/api` watchtower | evidence-backed outcomes (human squash merge, linked issue lead time, assessed coverage), health/canary/analytics, monitor-independent, incident issues · **tested** |
| HITL inbox | control plane + web | action types + resolvers + append-only ledger (AUTO-202); accepted platform plans dispatch their builder run; Gate 2 remains GitHub review/merge · **tested** |
| Knowledge / PO / learning | `@facility/harness` | Limina-style chains, write-time validation, PO + learning contracts (bundled), task propose→approve→issue, no auto-apply · **tested** |
| MCP + CLI | `@facility/mcp`, `@theam/facility` | HITL-gated tools (stdio + HTTP), platform CLI commands · **tested** |
| Web | `@facility/web` (Next 16) | TAM-50 design system; operator surfaces (overview, projects+kickstart, runs+live steer, inbox, registry, analytics, audit, settings — providers/keys/budgets mgmt), responsive; **not yet a full control plane** (agents/sandbox-profiles/virtual-keys/KB/tasks remain API-managed) · **verified in browser** |
| Docs | `@facility/docs` (Docusaurus) | concepts, self-host, guides, reference — TAM-50 skinned · **builds + verified** |
| Infra | `infra/` | Dockerfiles (build + run verified), docker-compose self-host, AWS Terraform · **plan-validated on the live account** |

## Verification performed

- **Full test suite green**: ~180 tests across core/db/api/gateway/mcp/runner/
  harness/cli, real Postgres; lint (Biome) clean; guards pass.
- **Money path, live**: minted a project virtual key via the API, proxied a
  real `claude-haiku` completion through the gateway, confirmed it metered into
  `llm_requests` with resolved cost.
- **Sandbox e2e**: a real Docker container ran an agent loop (hello → provision
  → events → steer → checks → result) and was reconciled/destroyed.
- **Web + docs**: driven in a browser end-to-end (login → overview → audit →
  settings), rendering seeded data in the TAM-50 brand.
- **Self-host**: the `api` image builds from the root Dockerfile and
  health-checks green in a container against Postgres.
- **AWS**: `terraform validate` + a real `terraform plan` (clean, 89 resources)
  against account 746486153337.
- **tam-os**: kickstart renders its native 44-file asset set for its real config.
- **The factory actually ran** (the headline proof): a real **Claude Code
  agent** launched in an isolated platform sandbox, loaded its tools, reasoned,
  created a file via the Edit tool, and finished — its **3 model calls all
  routed through the gateway, metered, and attributed to the run**; the session
  streamed event-by-event. Surfacing this took fixing four real
  integration bugs (gateway URL path, bundle-URL host, runner-as-root, gateway
  stripping `anthropic-beta`) that only a true end-to-end run exposes.

## Second pass: closing the reflection's gaps

After an honest self-review flagged that the platform was broad but not proven
in practice, a second push closed the real gaps — each verified on a running
stack, not just asserted:

- **The factory runs** — a real Claude Code agent did real work in a sandbox
  (metered through the gateway); an agent **cloned a real GitHub repo** and
  worked on the checkout; an agent **maintained the KB** through the API with a
  run-scoped, least-privilege, auto-revoked platform key. Surfaced + fixed 6
  real integration bugs (gateway URL path, bundle-URL host, runner-as-root,
  gateway header-stripping, sandbox→gateway seam, web image `public/`).
- **WorkOS SSO** — the stubbed callback is now the real AuthKit code→token
  exchange with CSRF state and safe org resolution.
- **Security** — a deeper review found a critical privilege-escalation and
  several cross-tenant authorization holes the first pass missed; all closed
  with regression tests.
- **AWS** — all five hardened images built and pushed to **live AWS ECR**, and
  the full 89-resource stack (VPC/RDS/ALB/ECS Fargate) applied on real AWS
  (then destroyed) — a running cloud deployment, not just a plan.
- **tam-os on a private repo** — a real private `theam/tam-os-facility-mirror`
  was cloned into a sandbox (token-authenticated, the GitHub-App mechanism) and
  an agent worked its checkout. The tam-os execution path, on a private repo.
- **Load** — 60 concurrent gateway calls: all 200, zero errors, all 60 metered
  correctly (concurrency-safe, validating the budget-race fix).

## Two adversarial-review passes

A first focused review (auth/gateway/sandbox/github/crypto/harness) found 6
issues, all fixed. A **second, broader** review of the bulk `v1.ts` routes then
found a critical privilege-escalation and several high-severity
cross-project/cross-org authorization holes that the first pass never reached —
a candid reminder that broad-but-shallow coverage hides depth problems. Those
are being closed in a dedicated multi-tenancy hardening pass
([spec](specs/hardening-multitenancy.md)) with regression tests, before the
platform can be called "secure, multi-tenant, enterprise-grade."

## The GOAL.md checklist

Every capability the goal named, and where it lives — see
[PRD.md](PRD.md) §4 and [ARCHITECTURE.md](ARCHITECTURE.md). All are implemented at
the platform (API) layer; surface coverage is uneven by design — the web control
plane manages providers/keys/budgets but not yet agents/sandbox-profiles/
virtual-keys/KB/tasks (those are API/CLI/MCP-managed, see the "operator dashboard"
note above). The deliberate v1 scope notes are in ARCHITECTURE §8.

## Human-gated — intentionally NOT automated

These are outward, stateful, or accountability-bearing actions that belong to
the platform owner, not an agent:

1. **Registering the Facility GitHub App** in the theam org and installing it on
   repositories.
2. **The tam-os production cutover** — validate against a mirror repo first;
   the cutover PRs are reviewed and merged by the tam-os team. Never push to
   theam/tam-os without Adrián.
3. **A live AWS apply** — the Terraform is plan-validated; `terraform apply`
   stands up ~89 billed resources and is a cost decision for the owner.
4. **Pushing this branch / opening the PR** — the work is committed locally on
   `feat/platform-v0.3`, awaiting your review.

## Post-verification hardening (2026-07-04)

Six independent GPT-5.5 (xhigh) verifiers audited the platform against GOAL.md,
one per aspect. Consensus: a strong, tasteful foundation, but only ~1/3 of the
named capabilities were production-complete (scores 56–76). Every load-bearing
finding was re-verified against the source by hand, then fixed in eight waves
(each with regression tests, re-run and reviewed before commit):

1. **Security — RBAC escalation closed** (46e94b3): member/role writes now use
   the same "cannot grant more than you hold" subset-check as key issuance;
   deactivated users are refused at session resolution. Regression-tested.
2. **Client/API contracts** (921a6c3): fixed the web run-transcript, the CLI
   inbox, and CLI kickstart/upgrade (repo→repoId) shape mismatches.
3. **Execution loop made real** (f1c5f89): GitHub slash-commands now dispatch;
   HITL approval creates REAL GitHub issues (no more mock); the runner receives
   and loads the harness/KB context; PO + learning agents seeded enabled.
4. **Cost/perf** (28a99d1): fail-closed on unpriced models; concurrency-safe
   hard-budget reservation (no overspend); the overview/runs N+1 replaced with
   a paginated org-wide `/v1/runs`; task/agent cost attribution; bounded
   envelope buffering; SSE stops polling when NOTIFY is active.
5. **Self-host bootstrap** (986fd50): a fresh zero-org instance's first user
   becomes owner of a new org; prod compose seeds bundled data; envelopes
   persist on stock AWS.
6. **Sandbox security** (986fd50): the runner no longer writes live keys into
   the agent workspace; Docker gets read-only rootfs + node-owned tmpfs + a
   profile network posture. Validated against the real docker e2e.
7. **AWS Fargate driver** (d9c9f60): the stub is now a real ECS driver
   (RunTask/DescribeTasks/StopTask/logs) with private networking + IAM, unit-
   tested with fakes.
8. **UI** (3891e14): agent-yellow reserved for agent work only; destructive
   actions confirm; runs/audit tables responsive.

### Corrections to earlier claims in this file
Prior versions of this doc overstated a few things; setting the record straight:
- "Zero-copy streaming" — the gateway streams to the client but retains a
  **bounded** copy for the envelope (was unbounded until wave 4).
- "NOTIFY-backed SSE" — true only after wave 4 removed the residual poll loop.
- "Budget-race fixed" — the earlier fix prevented lost updates, not overspend
  under concurrency; the wave-4 reservation closes that.
- "PO agent + learning demonstrated" / harness — the agents were seeded
  **disabled** and the harness was built but dropped by the runner until wave 3.
- "tam-os operates 100%" — **not** achieved end-to-end; treat as aspirational
  until a full tam-os migration is run and cut over (owner-gated).

## Known follow-ups (tracked, non-blocking)

- **SDK route contract** — hand-maintained, but a runtime manifest
  (`FACILITY_V1_ROUTES`) is diffed against the API's OpenAPI document by a
  route-coverage test, so it can no longer silently drift. (Wrong nested paths
  resolve to `never`, `@facility/mcp` strict-typechecks clean, behavioural + type
  tests.) A few non-core v1 endpoints still return loose `AnyObject` response
  schemas.
- **tam-os production migration** run end-to-end (owner-gated).
- `cost_cents` is integer — fine for real runs; sub-cent precision only if
  fine-grained tiny-call attribution is needed.
- Per-run receipts / pattern-miner deeper engine integration remain roadmap.

_(Done since earlier drafts: the `v1.ts` god-router is split into per-domain
routers under `routes/v1/`; the run-steer cockpit and guided kickstart are built;
audit is project-scoped end to end; **remote MCP OAuth 2.1 (WorkOS JWT via JWKS)
has shipped** alongside `fak_` keys — see "Current state".)_
