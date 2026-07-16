# Facility Platform — Product Requirements

**Status**: v1 draft · owner: platform crew · source: GOAL.md, sdlc.theagilemonkeys.com, docs/method.md
**One-liner**: The self-hostable platform that governs an organization's entire AI SDLC — "Vercel for the AI software factory."

## 1. Problem

Facility v0.2 installs the AI SDLC as vendored files: workflows, guards, skills, prompts, telemetry scripts spread across every repo, org secrets, and side systems. It works — tam-os runs on it in production — but it does not scale as an operation:

- No single place to see projects, agents, outcomes, costs, or incidents across an organization.
- Provider keys, budgets, and model access are managed per-repo, per-secret, invisible in aggregate.
- Upgrading the method means re-vendoring files repo by repo, with no integrity guarantee.
- Knowledge (skills, rules, standards, harnesses) forks silently per repo instead of versioning centrally.
- Humans have no inbox: plan gates, HITL validations, and stuck sessions live scattered in GitHub threads.
- Every run's data (transcripts, receipts, outcomes) evaporates or lands in ad-hoc sinks.

The method is proven. The factory needs a control plane.

## 2. Product definition

Facility Platform is the **control plane for the AI SDLC**. Execution stays where it belongs — GitHub repos, CI, isolated sandboxes — while the platform owns **governance**: identity, policy, money, knowledge, telemetry, and the human gates.

Deployable by any organization on any cloud (containers + Postgres + object storage). tam-os is tenant #1 and must operate 100% on it.

**Non-goals (v1)**: replacing GitHub as the SCM; a hosted multi-tenant SaaS offering (single-org self-host first, multi-org data model from day one); replacing CI providers; building our own model inference.

## 3. Personas

- **Platform owner** (CTO/staff eng): installs Facility, sets org policy, budgets, roles; owns upgrades.
- **Project lead**: kickstarts projects, tunes agents/skills, owns the standard, reviews analytics.
- **Engineer**: works the loop daily — accepts plans, reviews PRs, answers HITL requests, steers stuck sessions.
- **Agent** (machine persona): architect/builder/reviewer/addresser/doctor/sweep/Project Owner/learning agents — first-class, least-privilege principals whose every action is attributed and audited.
- **Finance/compliance viewer**: reads cost attribution, audit trails, and outcomes; changes nothing.

## 4. Pillars and requirements

### P1 — Projects & governance
- Manage many projects per organization; each project maps to ≥1 GitHub repo.
- Project kickstart: greenfield or existing repo → platform renders and PRs the full asset set (workflows, guards, skills, STANDARD.md, `.facility.json`, identifiers) — the v0.2 installer productized, server-side.
- Repo **fingerprints**: platform keeps a manifest (path + SHA-256 + system version) of managed files; drift/corruption is detected on push webhooks and surfaced; **upgrade** regenerates assets to the latest system version via PR (three-way aware).
- System **versioning & templating**: the whole method (workflows+guards+skills+prompts) is a versioned template set; orgs can pin, preview diffs, and roll forward per project.
- Governance of all AI SDLC resources: standards, guards, budgets, model policy, sandbox policy — declared centrally, enforced at kickstart/upgrade and at runtime (proxy, orchestrator).

### P2 — Execution: sandboxes & sessions
- Isolated cloud sandboxes for Claude Code agents, Codex agents, and bring-your-own providers; driver-based (local Docker for dev/self-host, AWS driver for cloud; interface open for k8s).
- Sandbox configuration management: base images, dependencies, runtime config, provision command, resource limits — as reusable, versioned **sandbox profiles** with good defaults.
- **Live session access**: engineers can open any running (or recorded) agent session from the platform — structured transcript streaming, and steering input to unstick a session. Recorded sessions are replayable.
- **Live PR previews**: every implementation PR must expose an isolated environment for fast human validation. In the current product this is supplied by the project's deployment provider; native Facility provisioning, lifecycle management, and Gate 2 evidence are a roadmap requirement.
- All platform-run agents (PO, learning mode, platform-triggered crew) execute in these sandboxes — never on the control plane.

### P3 — Money: keys, budgets, cost
- **LLM gateway**: all model calls route through the platform proxy — Anthropic, OpenAI, BYO endpoints — for auditing, observability, and centralized access.
- Project-level **virtual keys** (issued/revoked by the platform; provider keys stored sealed, never exposed to repos or sandboxes).
- Budgets: org and project caps (soft warn / hard stop), enforced at the gateway; spend visible in near-real-time.
- Cost attribution by **model, agent, task/run** — every request tagged with run context; receipts (tokens, cost, duration) stored per run.

### P4 — Knowledge: registry & learning
- Enterprise-wide + project-scoped registry: **skills, rules, harnesses, agent definitions**, versioned with content hashes; bundled recommended set (the v0.2 crew + modules) ships with the platform.
- Creation of new agents for project-specific use cases: define contract (prompt), harness, model tier, triggers, permissions — from the UI/CLI/MCP.
- **Project Owner agent**: Limina-style harness that owns the project domain — maintains the knowledge base, generates implementation tasks (the tam-os / automation-expert workflow, native).
- **Learning mode**: nightly per-project agent that mines what happened (runs, reviews, failures) and proposes new skills/rules/KB entries — every proposal lands in the HITL inbox for human validation before activation.
- Knowledge base + task management surfaces in the product (browse, edit, approve, trace task → PR → outcome).

### P5 — Observation: analytics, audit, issues
- Comprehensive analytics with **per-project separation** and org rollups: acceptance rate (**human squash-merged / assessed terminal agent PRs**), evidence coverage, one-shot rate (**merged with no change requests or human fixups / merged agent PRs**), human fixups, issue-to-merge lead time, run outcomes, costs — live numbers, never curated.
- The watchtower, platformized: outcome collection, health monitoring with budgets, canary flights — per project, visible centrally, still independent of the telemetry it monitors.
- **Issue visibility**: everything that goes wrong across the lifecycle (failed runs, drifted repos, budget breaches, stuck sessions, guard failures) is a first-class platform issue with state.
- **Audit everything**: append-only audit log of every platform action (human and agent), every LLM request/response envelope, every webhook, every config change. Store by default; the data is an asset for mining.

### P6 — Humans: gates & inbox
- **HITL inbox** per engineer: plan acceptances, learning-mode validations, blocked runs, doctor escalations, PO task approvals — approve / reject / steer, fully audited, with notifications.
- The two gates stay human: plan acceptance in Facility (or `/builder` in the repo lane), then live-preview validation, PR review, and squash merge in GitHub. The platform makes gates cheap to exercise, never optional.

### P7 — Access: identity & interfaces
- AuthN: **WorkOS SSO** (AuthKit, the tam-os approach) for humans; hashed API keys for machines.
- AuthZ: bundled roles (owner, admin, maintainer, engineer, viewer) + **custom roles** from a permission catalog; org- and project-scoped grants.
- **GitHub App**: installed in the org's environment; webhooks drive triggers, kickstart/upgrade PRs, fingerprint checks; App identity for pushes (hardening note 14).
- **AI-operable**: a first-class **MCP server** and **CLI** expose the same governed API, so the platform is safely manageable from Claude Code, Cowork, Codex, etc. RBAC applies identically to humans, agents, MCP, and CLI.
- Fully responsive on mobile — the inbox, analytics, and session views must work from a phone.

### P8 — Data sources
- Integrations that can **trigger issue creation and implementation workflows** (v1: GitHub webhooks + generic inbound webhook/API with signed payloads; the integration surface is a first-class extension point).

## 5. Experience principles

1. **Feel in control**: every screen answers "what is running, what does it cost, what needs me?" The inbox is the home page.
2. **Two gates, one glance**: gate actions are one tap, with the evidence (plan, diff, receipts) inline.
3. **Defaults that ship**: kickstart a greenfield repo to a working factory in minutes with zero required configuration; every default is the production-proven tam-os/v0.2 shape.
4. **Numbers, never adjectives**: live metrics straight from the pipeline (site rule), agent yellow marks agent work and nothing else.
5. **Nothing hidden**: any resource can be inspected as its underlying config/JSON; the UI is a lens, not a wrapper.

## 6. Release criteria (v1 "achieved")

1. Monorepo with control-plane API, web app, LLM gateway, sandbox orchestrator, GitHub App integration, MCP server, CLI, registry, analytics/watchtower, HITL inbox, PO+learning harnesses — implemented, tested, documented.
2. TAM-50 visual identity throughout; responsive; docs site (Docusaurus) in the same brand.
3. Self-host path: `docker compose up` brings the platform up with good defaults; Terraform module proves AWS deployment.
4. tam-os imported as tenant #1: its real SDLC configuration represented natively (agents, workflows, skills, budgets, KB), validated end-to-end against a mirror repo, with a prepared production cutover (human-gated).
5. Security review passed: sealed secrets, RBAC enforced on every route, audit coverage, sandbox isolation, hardening notes carried over.
