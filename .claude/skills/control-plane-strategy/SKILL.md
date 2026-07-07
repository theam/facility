---
name: control-plane-strategy
description: "Facility product strategy and design laws. Load BEFORE designing, building, reviewing, or specing ANY Facility surface, screen, feature, or flow — web, CLI, MCP, or API shape. Encodes the operator-grade bar (Vercel-class), the questions-first design method, the laws every surface must pass, the tam-os reference workload, and the 2026-07-07 deltas ratified on top of docs/platform/REDESIGN.md."
---

# Facility: operator-grade or it doesn't ship

**Standing docs, in order:** [GOAL.md](../../../GOAL.md) is the end state. [docs/platform/REDESIGN.md](../../../docs/platform/REDESIGN.md) is the working spec — IA, surface-by-surface targets, sequencing; still valid. **This skill is how to approach, design, and judge all of it from now on.** On conflict with older docs, this wins.

## The mission

Move AI SDLC operation **from** isolated repositories — custom configuration spread across files and code, poor or sparse visibility into the data the system produces — **to** one centralized control plane where the same work is easier and better controlled, managed **semantically** (real objects with tailored experiences, not raw config), and where centralization buys **collaboration, reusability, and governance**. GOAL.md opens with this; tam-os is the first tenant and the proof.

## The verdict (2026-07-07) and the root cause

Adrián compared the redesign branch (tam-os mirror loaded) against Vercel's dashboard:

> "Vercel is a solid platform that genuinely lets you manage your system; Facility, in its current state, feels like an extremely superficial demo… It lacks clear user flows and use cases that would let someone say: this is a control panel I can actually use."

Second demo-verdict in two days (2026-07-06 produced REDESIGN.md). The redesign fixed the IA, the wiring honesty, and the verbs. What is still missing is the **experience layer**, and the root cause is the same both times: **surfaces are built from the data model outward, not from the operator's questions inward.** A registry table becomes a list of rows; an `agent_defs` row becomes a form of raw columns. The fix is a method, not a page.

## The method: questions first

Before building or changing any surface:

1. Write the **top 3 questions** its operator brings to it, ranked. Can't write them? You don't understand the surface — operate the mirror tenant until you can.
2. **The layout IS the ranking**: #1 answered at the top, live; the rest in order.
3. Attach the **verb** next to each answer (blocked → decide; failed → open/retry; PR ready → review).
4. Everything else is one drill-down away — progressive disclosure, never a wall of everything.

**The taste benchmark is Vercel — match its altitude, never its skin (TAM-50 stays).** Its project overview answers, in order: is production healthy (status, build, who/when) → where is it (domains) → what needs me (a blocked-deploy banner *with its Cancel verb inline*) → is traffic OK (sparkline modules) → what's in flight (Active Branches: search box, status facet, per-branch preview/PR links). Its logs screen is the whole observability pattern in one screen: timeline histogram (summary) → filter rail + scannable rows (list) → click → request-lifecycle drawer (detail). Its deployment page is progressive disclosure: build logs, summary, checks all collapsed until asked.

The question sets per Facility surface:

| Surface | The operator's questions, ranked |
|---|---|
| Project overview | Does the factory need me? What is it doing right now? Is it healthy, and what did it ship lately? |
| Agents (the engine) | Is the engine running correctly? What does each agent do, and when does it run next? Did its recent sessions succeed? |
| Sessions | What's running or blocked now? What failed recently, and why? What did each produce and cost? |
| Owner | What has the PO learned and decided lately? What is it driving toward? What awaits my validation? |
| Inbox | What is waiting on **me**, riskiest/oldest first? |
| Audit / logs | Are recent operations succeeding? Is anything failing right now? What exactly happened around X? |
| Harness content | What defines this behavior, which version is live, who uses it, what changed? |

## The laws

Every surface passes **all** of them or it doesn't ship. (L8–L10 carry over from REDESIGN; restated because they stay load-bearing.)

- **L1 — Hierarchy answers questions.** The top of every screen is the live answer to its #1 question. No walls of text; no static headers where state belongs.
- **L2 — Three altitudes.** Summary → scannable list → detail inspector; every observability surface implements all three. A count is not a summary: "50 logs" says nothing; "last 30 min: 212 requests · 0 errors · 1 ongoing failure" lets someone act.
- **L3 — Every list is a workspace.** Text search + facet filters + status glyphs + humanized time; pagination or infinite scroll past ~40 rows. An unboundedly growing list without search doesn't ship. Today only audit passes; the harness list filters by kind pills only, fleet/sessions/issues have no search at all.
- **L4 — Semantic controls.** Any value the system already knows is picked, never typed: provider/model from the provider registry plus a model catalog; schedules from a builder that speaks human ("every 5 days at 06:00 · next in 4h") and stores cron; permissions from a matrix; triggers from a catalog. Raw strings survive only behind an "advanced" escape hatch. Violations to purge: free-text model (components/harness/agent-editor.tsx:112), cron string input with placeholder `0 6 * * *` (:123), space-separated permissions (:135).
- **L5 — Type-specific experiences.** An agent, a skill, a rule, a guard, a sandbox profile are different concepts; each gets a tailored reader and editor. One `<textarea rows={24}>` for every kind (components/harness/item-editor.tsx:166) is banned. Implementation indirections — an agent's prompt living in a referenced contract item — are hidden by the UI, never homework for the user.
- **L6 — Show the engine.** Agents are the heart of the platform; render them as a running system: description, health glyph derived from recent sessions, last run and its outcome, next run in words — **and the pipeline view**: trigger → agent → output → consumer as a live, clickable diagram (feedback source → Feedback agent → assessed issue → Architect → plan → Builder → PR → Reviewer → merge). If the loop is only explained in docs, the product has failed to explain it.
- **L7 — Human language in the chrome.** Cron, IDs, and raw JSON live one layer down, on demand. Timestamps humanize; statuses are words plus glyphs.
- **L8 — Verbs where the answers are; UI verb = SDK verb.** MCP/CLI parity by construction (REDESIGN §6.1).
- **L9 — Never claim what isn't wired.** Every label is backed by a mechanism or it doesn't ship (REDESIGN §1.6).
- **L10 — Live-first.** No surface that says "now" may require F5 (REDESIGN §6.3).

## The reference workload — design for this, always

Facility's model user builds and operates what tam-os runs in production. The cast, as a pipeline:

| Agent | Trigger | Does | Produces → consumed by |
|---|---|---|---|
| Feedback | schedule/event from a **configured feedback source** (managed credentials: "data comes from here, use this key") | validates feedback in a sandbox, first assessment of the fix | assessed issue → Architect / Builder |
| Project Owner | transcripts + data sources feeding it continuously; human conversation | **decides** — owns direction and the KB; not a chatbot with documents attached | tasks/issues through gates → Architect / Builder |
| Architect | issue, pre-work | reads repo + sources, experiments in a sandbox before deciding | plan on the issue → Builder |
| Builder | issue with context — or a **direct human instruction, no issue required** | implements via Claude Code / Codex | branch + PR → Reviewer / humans |
| PR Reviewer | PR opened | reviews the diff | review state → humans / Builder |
| Security Auditor | schedule | audits, finds vulnerabilities | issues → back into the loop |

Skills and rules (the harness) define how they behave — versioned, governed, reusable assets. And the platform must answer, **in product**, the measurement questions this pipeline exists for: one-shot success rate · human review coverage · issue→deploy time · how released work performs · cost and ROI per agent. The data largely exists (outcomes one-shot/fixup flags, llm_requests attribution, analytics_daily rollups) and is currently rendered nowhere — the analytics route literally redirects away.

**The bar (extends REDESIGN §0):** a TAM engineer operates tam-os for a week from Facility, opening GitHub only to review diffs — **and every agent in the cast above can be created, understood, and operated from the product by someone who never read the code.** Event-driven agents included.

## Ratified deltas on REDESIGN.md (2026-07-07 — build these)

REDESIGN's surface targets stand. These extend them:

1. **The agent is the flagship object.** Merge the project Agents tab and the harness into one "system definition" area (REDESIGN §4d), fronted by agents. Agent detail: prompt edited inline (draft→publish machinery hidden underneath), engine + model picker fed by a catalog, schedule builder, **trigger catalog including events** — the schema already has `integrations`, `inbound_events`, and `issue`/`manual` trigger types; the UI exposes cron only — permission matrix, health + session history on the agent. **In-product creation with a test-run into the cockpit** (today: "created via the API/CLI for now", apps/web/app/(app)/projects/[projectId]/agents/page.tsx:36).
2. **New surface: the pipeline view (L6).** The execution-loop diagram as a tab of the agents area, plus a compact module on the project overview.
3. **Integrations UI.** The `integrations` table (feedback/transcript/data sources with sealed credentials) has zero surface today; it becomes the semantic backbone the agent editor's trigger and source pickers reference.
4. **Every list to L3.** Harness, sessions, fleet, issues: search + facets + status + pagination.
5. **Observability to L2.** The sessions list gains a health strip (last-24h outcomes); audit gains a summary strip/timeline above its existing filters; both keep drawers as the third altitude. Vercel's logs screen is the pattern.
6. **Measurement lands in product.** Per-agent success/one-shot/cost on agent detail and overview; the portfolio answers "is the factory paying off" from analytics_daily + outcomes.
7. **Schedules speak human everywhere** — "every day at 06:00 UTC · next in 4h" — stored as cron, edited in the builder (L4).

Sequencing: fold into REDESIGN §9's remaining phases. Deltas 4/5/7 are retrofits on shipped surfaces and come first; deltas 1/2/3/6 are the heart of the remaining P4 work.

## Working rules

- **Questions-first artifact.** Every surface lane/PR states its ranked questions and verbs up front; review rejects a surface that can't.
- **Dogfood the mirror.** Validate every surface against the tam-os mirror tenant (web :3400, dev sign-in, project `tam-os`: 6 real agents, 341 issues, KB, receipts). A screen that confuses on that data fails, whatever it looks like empty.
- **Fix the surface before feeding it.** No new features on a surface that violates the laws (extends "don't add features to the old IA").
- **Two-tier design weight still applies** (REDESIGN §3): flow surfaces get the investment; admin surfaces are plain, dense, fast forms.
- **DoD per surface:** laws L1–L10 pass · the question set is answered on mirror data · no dead labels · the verbs exist in SDK/MCP/CLI.

## Anti-patterns — reject on sight

Wall of text · unbounded list without search · raw cron/model/permission strings in a form · "N items" as a summary · one editor for every type · information without its verb · a diagram that lives in docs but could be live in product · asking the user to understand the data model (registry indirection, infra vocabulary) · polish on chrome ahead of answers to questions.
