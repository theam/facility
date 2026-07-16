# Spec: control plane foundation (packages/db, packages/core, services/api)

**Scope**: one coherent deliverable — the authenticated, authorized, audited control plane with its full data model, seed data, and the first resource routes. Later services (gateway, orchestrator, GitHub App handlers) build on these packages; get the seams right.

Read first: [ARCHITECTURE.md](../ARCHITECTURE.md) §2–§6, [PRD.md](../PRD.md) §4. Brand/product context is not needed for this chunk.

## Ground rules

- TypeScript strict (extend `tsconfig.base.json`; per-package tsconfig may set `noEmit:false` where a build exists). ESM only. Node 22.
- Runtime deps: choose current stable majors. Expected set: `fastify@5`, `zod@4`, `fastify-type-provider-zod`, `@fastify/swagger` + `@fastify/swagger-ui`, `@fastify/cookie`, `@fastify/rate-limit`, `drizzle-orm`, `drizzle-kit`, `postgres` (porsager), `pg-boss@10`, `argon2`, `libsodium-wrappers-sumo`, `uuidv7`, `pino`. Add nothing exotic; every dep must earn its place.
- Tests: `vitest` per package. DB tests run against the compose Postgres (`postgres://facility:facility@localhost:5461/facility`); guard with env check and a clear skip message when it's unreachable, but they must RUN in this repo's dev flow (compose is up).
- Every package: `build` (tsup, ESM, d.ts), `typecheck` (tsc --noEmit), `test` (vitest run) scripts so turbo picks them up. Services also get `dev` (tsx watch).
- Code style: Biome at root governs; run `pnpm lint` before finishing. Comments only where a contract can't speak for itself.

## packages/core (`@facility/core`)

Pure domain logic, zero I/O (no DB imports). Modules:

1. `ids.ts` — `newId(prefix)` → `<prefix>_<uuidv7-base58|hex>` (e.g. `proj_…`, `run_…`, `key_…`). Prefix table exported as const: org, user, proj, repo, run, sess, agent, sbx, key, vkey, bud, prop, act, kb, task, item, ver, bun, iss, evt, int, fp.
2. `permissions.ts` — the catalog. Format `<resource>:<action>`. Resources: org, members, roles, projects, repos, registry, agents, sandboxes, runs, sessions, keys, providers, budgets, spend, hitl, kb, tasks, issues, analytics, audit, integrations, settings. Actions: `read`, `write`, plus specials: `runs:trigger`, `runs:steer`, `sessions:read`, `hitl:decide`, `keys:issue`, `audit:read`, `registry:publish`, `projects:kickstart`. Export `ALL_PERMISSIONS`, `PermissionSchema` (zod), `can(grants: string[], needed: string)` with `*` and `<resource>:*` wildcard support.
3. `roles.ts` — bundled roles as data: `owner` (`*`), `admin` (everything except org deletion — `*` minus `org:delete`… keep simple: all resource wildcards), `maintainer` (project-level write incl. registry/agents/budgets/kickstart, no members/roles/providers), `engineer` (read + `runs:trigger`, `runs:steer`, `hitl:decide`, `kb:write`, `tasks:write`), `viewer` (all `:read`), `agent` (empty base — per-agent grants), `finance` (`analytics:read`, `spend:read`, `budgets:read`, `audit:read`).
4. `pricing.ts` — model price table (USD per 1M tokens, input/output, cache read/write where applicable) for: claude-fable-5, claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5, gpt-5.5, gpt-5.5-mini, plus `custom` passthrough. `costCents({model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?})` → integer cents (round half up). Unknown model → null cost, never throw.
5. `crypto.ts` — sealed-box helpers over libsodium: `seal(plaintext, masterKeyB64)`, `open(sealed, masterKeyB64)`; API-key hashing `hashKey(secret)` / `verifyKey(secret, hash)` (argon2id, sensible params); `generateApiKey(prefix)` → `{id, secret: '<prefix>_<40 hex>', hash, last4}`; HMAC confirmation tokens `mintConfirmation({secret, userId, clientId, toolName, argsHash, summary, ttlMs=300_000})` / `verifyConfirmation` (the tam-os MCP write-confirmation pattern).
6. `receipts.ts` — zod schema `facility.run.v1`: superset of tam-os `agent_sdlc.run.v1` (see discovery/tam-os.md §receipts): provider `claude_code|codex_cli|byo`, mode (architect|builder|review|address_review|ci_doctor|security_sweep|po|learning|custom), result, usage {input_tokens, output_tokens, cache_read?, cache_write?, cost_cents, cost_source}, activity {turns, shell_commands, file_changes, mcp_tool_calls, web_searches, tool_calls, errors}, github ctx (actor SHA-256-hashed), timing, normalized checks {name, passed|failed|skipped|unknown, platform|agent source, exit_code?}, and `checks_truncated` when the bounded receipt list omits events. Include `parseTamOsReceipt(json)` → facility receipt (compat mapping).
7. `fingerprints.ts` — `manifestFor(files: {path, content}[])` → `{version, files: [{path, sha256}], manifestHash}`; `diffManifest(expected, actual)` → `{missing, modified, extra}` (extra only within managed paths).
8. `audit.ts` — event name catalog (dot notation: `org.created`, `member.added`, `key.issued`, `run.started`, `hitl.decided`, `registry.published`, `budget.created|updated|deleted`, …) + `hashChain(prevHash, event)` → sha256 hex; zod `AuditEventSchema`.

Unit-test every module (pricing math, wildcard `can`, seal/open roundtrip, confirmation expiry/tamper, manifest diff, hash chain determinism, receipt compat parse with a realistic tam-os fixture).

## packages/db (`@facility/db`)

Drizzle schema + migrations + typed query helpers. Postgres 16. Conventions: snake_case columns, `text` PKs from `newId`, `timestamptz` `created_at`/`updated_at` defaults, `org_id` on every tenant table + composite indexes starting with `org_id`, jsonb for payload-ish columns, enums as pg text with zod validation at the edge (no pg enums — migration pain).

Tables (columns beyond the obvious id/org_id/timestamps):

- `users` (workos_user_id unique nullable, email unique, name, avatar_url, status active|disabled)
- `orgs` (name, slug unique, settings jsonb: {default_model_policy, retention_days, telemetry_opt_in})
- `org_members` (user_id, role_id, unique(org_id, user_id))
- `roles` (org_id NULLABLE — null = bundled, name, description, permissions text[]; unique(org_id, name)); seed bundled roles from `@facility/core` roles.ts in migration 0001 seed step (idempotent upsert by name where org_id is null)
- `api_keys` (name, prefix, last4, hash, scope_type org|project, project_id nullable, role_id, created_by, last_used_at, revoked_at)
- `github_installations` (installation_id bigint unique, account_login, target_type, suspended_at)
- `projects` (name, slug unique per org, description, system_version text, settings jsonb {default_branch, provision_cmd, check_cmds text[], board {org, number}}, status active|archived)
- `repos` (project_id, installation_id FK nullable, owner, name, default_branch, unique(owner,name), fingerprint_status ok|drifted|corrupted|unknown, fingerprint jsonb, fingerprint_verified_at)
- `registry_items` (scope bundled|org|project, project_id nullable, kind skill|rule|agent_contract|harness|guard|module|template_set|standard_section, name, description, latest_version int; unique(org_id, project_id, kind, name))
- `registry_versions` (item_id, version int, content text, content_hash, changelog, status draft|active|deprecated, created_by; unique(item_id, version))
- `bundles` (name, description, scope bundled|org) + `bundle_items` (bundle_id, item_id, version_pin nullable)
- `agent_defs` (project_id, name, engine claude_code|codex|byo, model jsonb {primary, effort?, fallbacks?}, contract_item_id, harness_item_id nullable, triggers jsonb [{type: slash_command|schedule|webhook|manual, config}], sandbox_profile_id, permissions text[], enabled bool)
- `sandbox_profiles` (org_id, project_id nullable, name, driver docker|aws, image, setup jsonb {deps?, provision_cmd?, env_refs?}, resources jsonb {cpu, memory_mb, timeout_min}, network jsonb {egress: all|restricted})
- `runs` (project_id, agent_def_id, mode, engine, status queued|provisioning|running|awaiting_human|succeeded|failed|canceled, trigger jsonb, sandbox jsonb {driver, ref}, receipt jsonb nullable, gh jsonb {issue?, pr?}, error text, queued_at/started_at/ended_at, created_by principal)
- `run_events` (run_id, seq bigint, ts, type, data jsonb; PK (run_id, seq)) — hot path table, index (run_id, seq)
- `steer_messages` (run_id, author_user_id, body text, delivered_at nullable)
- `provider_credentials` (org_id, provider anthropic|openai|byo, name, base_url nullable, sealed_secret text, created_by; unique(org_id, provider, name))
- `virtual_keys` (project_id, run_id nullable, name, prefix, last4, hash, allowed_models text[] nullable, budget_id nullable, revoked_at, expires_at nullable)
- `llm_requests` (org_id, project_id, run_id nullable, virtual_key_id, provider, model, status ok|error|blocked_budget|blocked_policy, input_tokens int, output_tokens int, cache_read int, cache_write int, cost_cents int nullable, latency_ms int, request_uri text nullable, response_uri text nullable, error text nullable, created_at) — index (org_id, project_id, created_at); document monthly partitioning as a scale note, single table for now
- `budgets` (scope org|project|agent_def, project_id nullable, agent_def_id nullable, period daily|weekly|monthly, limit_cents int, mode soft|hard, enabled)
- `spend_counters` (budget_id, window_start date, spent_cents bigint; unique(budget_id, window_start))
- `action_types` (org_id, name unique per org, payload_schema jsonb, resolver jsonb {type: emails|permission|team|dynamic, config}, executor jsonb {type: internal|webhook|none, config}, default_ttl_hours)
- `proposals` (org_id, project_id nullable, run_id nullable, action_type_id, payload jsonb, context_md text, state draft|open|approved|rejected|cancelled|expired, decided_by nullable, decided_at nullable, expires_at)
- `proposal_events` (proposal_id, seq, ts, type draft|open|approved|rejected|cancelled|expired|executed|execution_failed, actor, data jsonb; PK (proposal_id, seq)) — append-only
- `kb_spaces` (project_id unique, charter_md text, active_md text, config jsonb {artifact_types: [{prefix, name, required_links, schema}], protected: bool})
- `kb_entries` (space_id, type text, number int, slug, frontmatter jsonb, body_md text, status text nullable, supersedes text nullable; unique(space_id, type, number))
- `kb_links` (space_id, from_entry, to_entry, created_at; PK (space_id, from_entry, to_entry))
- `po_tasks` (project_id, kb_entry_id nullable, title, body_md, wsjf jsonb {value, time, risk, effort, score}, gh jsonb {repo, issue_number, url} nullable, status draft|proposed|created|in_progress|done|rejected)
- `platform_issues` (org_id, project_id nullable, kind drift|budget_breach|run_failure|stuck_session|guard_failure|canary_failure|integration_error|learning, severity info|warn|error, fingerprint text, title, body_md, state open|acked|resolved, first_seen, last_seen, count int; unique(org_id, fingerprint))
- `audit_events` (org_id, seq bigserial, actor jsonb {type: user|key|agent|system, id, name}, action text, target jsonb {type, id}, payload jsonb, ip, user_agent, prev_hash, hash; index (org_id, seq)) — INSERT only; no update/delete helpers exported
- `outcomes` (org_id, project_id, repo, pr_number, agent_lane, opened_at, terminal_at, raw fate merged|closed, accepted nullable boolean, issue_number/opened_at, merged_by + merger_type, merge_method, review_rounds int, fixup_commits int, hours_to_terminal legacy numeric, hours_issue_to_merge numeric; unique(org_id, repo, pr_number))
- `integrations` (org_id, project_id nullable, kind github|webhook|slack, name, config jsonb, sealed_secret nullable, enabled)
- `inbound_events` (integration_id, received_at, verified bool, event_type, payload jsonb, processed_at nullable, error nullable)

Provide: `createDb(connectionString)` → drizzle instance; `migrate()` runner; `withOrg(db, orgId)` helper namespace exposing scoped query builders for the hot tables (enforces org filter — the tenancy seam); seed script (`pnpm --filter @facility/db seed`) creating: bundled roles, a dev org `the-agile-monkeys`, dev user, bundled registry items loaded from `packages/cli/templates` (kind template_set v1 named `facility-standard`, plus each skill/prompt/guard as items — read files at seed time, content_hash sha256), a default sandbox profile (docker, the Facility runner image from `FACILITY_RUNNER_IMAGE`, default `facility-runner:dev`), default action_types (`plan_acceptance`, `learning_validation`, `kickstart_review`, `budget_override`).

Migrations: drizzle-kit generated SQL committed under `packages/db/migrations/`. Deterministic, reviewed files.

Tests: schema round-trip (insert/select typed rows for ~6 core tables), tenancy helper refuses cross-org reads, audit insert computes chain correctly vs `@facility/core` hashChain, seed idempotency (run twice, same counts).

## services/api (`@facility/api`)

Fastify 5 app factory (`buildApp(config)`) + `dev`/`start` entrypoints + worker entrypoint (`worker.ts`) that just boots pg-boss and registers no-op queue handlers for now (`runs.dispatch`, `watchtower.outcomes`, `watchtower.health`, `learning.nightly`, `fingerprints.verify` — handlers land in later chunks; register with TODO handlers that log and complete).

Config from env (zod-validated, single `config.ts`): `DATABASE_URL`, `SECRET_MASTER_KEY` (32-byte b64), `PORT=4400`, `PUBLIC_URL`, `WORKOS_API_KEY?`, `WORKOS_CLIENT_ID?`, `WORKOS_COOKIE_PASSWORD?`, `FACILITY_INSECURE_DEV?` (enables dev-login; MUST refuse to enable when NODE_ENV=production), `S3_*` (endpoint, key, secret, bucket — used later), `LOG_LEVEL`.

Plugins/middleware, in order: request-id (uuidv7), pino logger, cookie, rate-limit (per-key/user), CORS (explicit allowlist from config), auth resolver, RBAC guard, OpenAPI (swagger at `/docs/json`, UI at `/docs` — dev only).

**Auth resolver** (`plugins/auth.ts`): resolves `request.principal` from (in order): (1) `Authorization: Bearer fak_…` API key → lookup by prefix, argon2 verify, load role → principal {type:'key', orgId, projectId?, permissions}; (2) session cookie `facility_session` (signed, httpOnly) → principal {type:'user', userId, orgId, permissions} — session minted by auth routes; (3) none → 401 on protected routes. WorkOS AuthKit integration: `GET /auth/login` → redirect to WorkOS authorization URL (when configured), `GET /auth/callback` → exchange code, upsert user by workos_user_id/email, ensure org membership (org resolved by WorkOS organization or default org), set session cookie, redirect to web. `POST /auth/dev-login {email}` → only when FACILITY_INSECURE_DEV — upserts user, member of dev org as owner. `POST /auth/logout`. Session = sealed JSON {userId, orgId, exp} via core.crypto seal with masterKey (7d, sliding renewal in resolver when <3d left).

**RBAC guard**: route registration declares `{permission: 'projects:read'}` in route config; guard resolves org scope from principal + `:projectId` param when present (verify project belongs to principal org, 404 otherwise), checks `can()`, 403 with `{error, needed}` on failure. Routes without declared permission → only auth routes/health allowed (enforce via a startup assertion that walks the route table — no accidentally-open routes).

**Audit**: `request.audit(action, target, payload?)` decorator → inserts audit event with hash chain (per-org advisory lock or serialized insert via `SELECT … FOR UPDATE` on last event; correctness over throughput here); auto-audit fires on success (2xx) for every **protected, non-GET route that declares an `auditAction`** (the hash-chained `audit_events` log); auth events audited explicitly. Webhook deliveries and runner-lifecycle writes are recorded in their own event logs (`inbound_events`, `run_events`), not the audit chain.

**Routes v1** (all under `/v1`, OpenAPI-schema'd with zod, consistent error envelope `{error: {code, message, details?}}`):

- `GET /health` (public) → {ok, version, db: ok|down}
- `GET /v1/me` → principal + org + permissions
- Orgs: `GET /v1/org` (current), `PATCH /v1/org` (settings; `org:write`)
- Members: `GET/POST/DELETE /v1/members` (+ role change `PATCH /v1/members/:userId`) — `members:read/write`
- Roles: `GET /v1/roles` (bundled + org), `POST/PATCH/DELETE /v1/roles/:roleId` (custom only; bundled immutable → 400) — `roles:*`
- API keys: `GET /v1/keys`, `POST /v1/keys` (returns secret ONCE), `DELETE /v1/keys/:keyId` (revoke) — `keys:issue`; audit `key.issued`/`key.revoked`
- Projects: full CRUD `/v1/projects`, `/v1/projects/:projectId` — list supports `?status=`; create seeds settings defaults; `projects:read/write`
- Repos: `GET/POST/DELETE /v1/projects/:projectId/repos` — `repos:*`
- Registry: `GET /v1/registry/items?kind=&scope=&projectId=`, `GET /v1/registry/items/:itemId` (+versions), `POST /v1/registry/items` (create draft v1), `POST /v1/registry/items/:itemId/versions` (new draft), `POST /v1/registry/versions/:versionId/publish` (`registry:publish`, draft→active, bumps item.latest_version), `POST …/deprecate`. Content immutable once active (400 on edit attempts).
- Agent defs: CRUD under `/v1/projects/:projectId/agents` — `agents:*`; validate contract/harness refs exist
- Sandbox profiles: CRUD `/v1/sandbox-profiles` (org) + project override list — `sandboxes:*`
- Runs (control only, execution comes later): `POST /v1/projects/:projectId/runs` (`runs:trigger`) → creates queued run + enqueues `runs.dispatch`; `GET /v1/projects/:projectId/runs?status=`, `GET /v1/runs/:runId`, `POST /v1/runs/:runId/cancel`, `GET /v1/runs/:runId/events?afterSeq=` (paged JSON now; SSE `GET /v1/runs/:runId/stream` streaming run_events + heartbeats), `POST /v1/runs/:runId/steer {body}` (`runs:steer`) → insert steer_message + audit
- Providers: `GET /v1/providers` (never returns secrets — name/provider/base_url/created only), `POST /v1/providers` (seals secret), `DELETE` — `providers:write`
- Virtual keys: `POST /v1/projects/:projectId/virtual-keys` (returns secret once), list, revoke — `keys:issue`
- Budgets: CRUD `/v1/budgets` (org/project/agent scopes) — `budgets:*`; `GET /v1/spend?projectId=&from=&to=&groupBy=model|agent|day` → aggregates from llm_requests (`spend:read`)
- HITL: `GET /v1/inbox?state=open` (resolver-aware later; v1 = org-wide filtered by permission), `GET /v1/proposals/:proposalId` (+events), `POST /v1/proposals` (agent/key principals; validates payload against action_type schema), `POST /v1/proposals/:proposalId/decide {approve|reject, note}` (`hitl:decide`) → ledger event + state change + audit; expiry sweep in worker (pg-boss cron)
- Issues: `GET /v1/issues?state=&kind=`, `POST /v1/issues/:issueId/ack|resolve` — `issues` under `projects:read`/`projects:write`… no: use `issues:read`? Keep catalog exact: use `analytics:read` for list? NO — add `issues:read`/`issues:write` to the permission catalog in core.
- Audit: `GET /v1/audit?from=&to=&actor=&action=` (`audit:read`), paged, ordered by seq; `GET /v1/audit/verify?from=&to=` → recompute chain, report first break (tamper evidence)
- KB (storage now, harness later): `GET/PUT /v1/projects/:projectId/kb/space` (charter/active/config), `GET /v1/projects/:projectId/kb/entries?type=`, `GET /v1/kb/entries/:entryId`, `POST /v1/projects/:projectId/kb/entries` (validates: type registered in space config, number = next per type, required parent links exist — the DAG rule — and writes bidirectional kb_links), `PATCH /v1/kb/entries/:entryId` (revalidates), `POST /v1/projects/:projectId/kb/validate` → full-space validation report — `kb:read/write`
- Tasks: CRUD `/v1/projects/:projectId/tasks` + `POST /v1/tasks/:taskId/transition` — `tasks:*`

**SSE**: implement a tiny SSE helper (reply.raw, heartbeat every 15s, close on client abort); stream run_events by polling afterSeq every 500ms for now (LISTEN/NOTIFY optimization noted as TODO, structure the code so the poller is swappable).

**OpenAPI → SDK**: `packages/sdk` generated: script `pnpm --filter @facility/api openapi` writes `packages/sdk/openapi.json`; then `openapi-typescript` generates `packages/sdk/src/schema.d.ts`; hand-write a thin typed client `FacilityClient` (fetch-based, base URL + key/cookie, typed by the generated paths, SSE helper for streams). Keep the client small and pleasant.

## Mechanical floor (run all; all must pass)

```
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm -r --filter '@facility/*' build
pnpm typecheck
pnpm --filter @facility/db migrate && pnpm --filter @facility/db seed
pnpm test          # includes api integration tests below
pnpm lint
node guards/run.mjs
```

API integration tests (vitest, real Postgres, app via `buildApp`): dev-login → me; RBAC deny (viewer key cannot POST project; 403 with needed permission); API key issue → use → revoke → 401; project CRUD; registry draft→publish→immutable; run create → events page → SSE first chunk; HITL propose (schema-validated) → decide → ledger order; audit chain verify endpoint detects a manually corrupted row (test tampers a row directly); KB entry DAG rule (creating E-type without parent H fails; with parent succeeds and links are bidirectional); budgets spend aggregation over inserted llm_requests fixtures; startup assertion catches an undeclared-permission route (add a temp route in test).

## Judgment criteria (my review applies these)

- Tenancy: no route can read/write outside principal org (I will grep for raw `db.` usage in routes — hot-table access goes through the scoped helpers).
- No secret ever serialized in a response, log, or audit payload (grep for sealed_secret/hash fields in serializers; providers route returns metadata only).
- Bundled roles/permissions come from `@facility/core` — no string literals sprinkled in routes.
- Audit coverage: every protected, non-GET route with a declared `auditAction` is auto-audited into the hash chain on success; chain verified in tests.
- Error envelope consistent; zod schemas on every body/query/response; OpenAPI builds without warnings.
- No dead abstractions: no repository-pattern ceremony beyond the scoped helpers; Fastify idioms, not a framework-on-a-framework.
- pg-boss worker boots clean and registers crons: `hitl.expire` (hourly), placeholders for watchtower/learning as no-op logs.
