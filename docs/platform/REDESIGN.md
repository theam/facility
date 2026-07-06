# Facility redesign: from governance demo to daily control plane

**Date:** 2026-07-06 · **Input:** GOAL.md + Adrián's product feedback + a full audit of the current implementation (web surfaces read first-hand; backend/API, runner, and end-to-end flows traced against source). Every claim below carries a file reference.

> **Implementation status (2026-07-06, branch `feat/redesign-control-plane`).**
> Landed with a green floor per commit: **P0** close-the-loop backend — PR outcome hook + `contents:write` push tokens + run↔outcome linkage, repo discovery, `gh_issues` read-mirror + direct trigger (0a6042e); session identity, raw transcripts to the object store, honest STEERING.md, generic agent scheduler, PO on claude_code (1c19dd6); dispatch-loss backstop (8ddcea9). **P1** the IA flip — project world + thin org shell, switcher, ⌘K, last-used landing, voice purge, kickstart repo picker, renames w/ redirects (e045841). **P2** daily loop — `GET /v1/outcomes`, audit time/prefix/project filters, inbox PR-review queue, audit drawer + chain verify (3966be3). **P4 slices** — harness item draft→publish editor, project agents editor incl. grantable permissions (4f1c7f6), Owner surface: KB reader + conversation UI + activity (7ba9c17), members management (ae48974), org fleet view (6142666), kickstart discard-draft (b54d057). **P3** interactive layer — real `--resume` (the runner persists `~/.claude` to the object store and restores it in the fresh sandbox), interrupt via the steer channel (graceful, resumable), PO conversations as resume-chained runs with replies extracted at finishRun; migration 0017 (7fcc1b7, merged).
> Verification: independent GPT-5.5 xhigh rounds; UX round 1 scored IA 84 / voice 80 / verbs 58 / honesty 72 (verb+honesty findings dominated by the then-unmerged P3 routes). **Open follow-ups:** harness item creation + test-run + where-used/diffs, KB in-place editing + validation UI, issue stage filters + PR mirror, CLI/MCP parity for the new verbs, roles editor + sandbox-profile UI, md rendering for KB/harness content, per-project SSE channel (LiveRefresh polls today). **Owner-gated:** GitHub App install, tam-os cutover + the §0 week-long dogfood, branch push/PR.

---

## 0. Verdict

The feedback is right, and the audit says it's actually sharper than "the UI is superfluous":

1. **The web app is a governance exhibit, not a workplace.** It proves the system exists (metrics, lists, taglines) instead of being where the work happens. Today the CLI is a materially fuller control plane than the web: `facility runs watch` consumes the SSE stream, `inbox decide`, `issues ack/resolve`, `kickstart` preview→confirm all exist in `packages/cli/src/platform.mjs` — while the web's project page has **zero actions** (apps/web/app/(app)/projects/[projectId]/page.tsx) and the registry page has **zero verbs** (apps/web/app/(app)/registry/page.tsx).

2. **Worse: the loop the platform governs doesn't close on the platform's own lane.** On the platform-native path (sandbox → runner → engine), no PR is ever pushed, opened, or recorded. `createPullRequest` is called only from kickstart/upgrade (services/api/src/github/kickstart.ts:164,362), the runner's repo token is clone-only (services/api/src/routes/internal.ts:237), and `runs.gh` is written once at trigger time and never updated with an outcome (services/api/src/github/router.ts:76). ARCHITECTURE.md §5 claims "outcome hooks (PR opened, comment posted)" — that code does not exist. PRs only happen on the **repo lane** (vendored GitHub Actions, agent runs `gh pr create` itself — packages/cli/templates/workflows/facility-crew.yml:243), which is also the default lane (kickstart.ts:154). So the lane with sandboxes, receipts, steering and governance cannot ship, and the lane that ships bypasses most of the platform.

So this is two builds, not one:

- **Close the loop** on the platform lane (backend): PR outcomes, working steering, sessions, scheduling, issue awareness.
- **Rebuild the product around the closed loop** (web): project-in-focus IA, work-shaped objects, verbs everywhere.

**The bar (definition of done for this whole effort):** a TAM engineer operates tam-os for a full week from Facility — triages the inbox, watches and steers sessions, triggers architect/builder on issues, tunes the harness, reads the PO's knowledge base — and opens GitHub only to review diffs. Until that's true, it's a demo. Every design decision below is tested against that bar.

**What Facility must beat:** GitHub + local Claude Code/Codex. It cannot win by re-rendering GitHub data with fewer features, and it cannot win against a local terminal on control. It wins on the four things neither has:

- **Fleet view** — every agent, every project, one screen, live.
- **Governed sessions you can enter** — cloud-isolated runs with local-terminal-grade steerability. This is the moat; nothing else on the list justifies switching by itself.
- **The Project Owner layer** — a maintained KB + task generation that GitHub simply doesn't have.
- **Receipts built in** — cost, audit, outcomes attributed per run/issue/agent without anyone doing bookkeeping.

---

## 1. Why it reads as a demo — root causes

Fixing symptoms one page at a time won't work; these five causes generated all of them.

### 1.1 It was built API-first, and the web was scoped as an "operator dashboard"

STATUS.md says it itself: agents, sandbox profiles, virtual keys, KB and tasks are "managed through the v1 API," not the web. The result is a large, well-tested API surface (78+ routes, typed SDK, MCP, CLI) with a thin viewing layer on top. Entities with full backend CRUD and **no web surface at all**: agent defs, sandbox profiles, virtual keys, the entire KB (`kb-tasks.ts` — spaces, entries, links, validate), the entire task layer (with `transition`/`propose` verbs), roles, members-write, registry lifecycle (create/version/publish/deprecate), llm-request drill-down, audit verify, doctor. The gap is mostly UI, which is good news — but it means the web needs to be *designed*, not patched.

### 1.2 Marketing register in tool chrome

Every page opens with a static epigram where the working state should be:

| Page | h1 |
|---|---|
| overview | "The factory floor." |
| projects | "Everything governed, per project." |
| runs | "Every run leaves a receipt." |
| registry | "The knowledge, versioned." |
| inbox | "People decide twice." |
| audit | "Everything, attributable." |
| analytics | "Numbers straight from the pipeline." |
| kickstart | "Project to pull request." |

Beyond being off-register, they violate the brand's own law. brand/BRAND.md: *"numbers must be live, not curated"*, *"measurement language over adjectives"*, sensei = *"open with the failure mode."* A static tagline is curated prose sitting in the page's most valuable region, identical on every visit, answering no operational question. The brand vocabulary (gates, receipts, watchtower, canary, the ratchet) is genuinely good — **as labels on live things**, not as poetry above them.

### 1.3 Entity-global IA instead of project-in-focus

The nav is 8 flat org-global sections (components/shell/nav.tsx:8-17): overview, projects, runs, inbox, registry, analytics, audit, settings. There is no project-scoped navigation anywhere — a project is one flat page with 4 metrics, 12 run rows, and a read-only settings card. Everything meaningful in this SDLC happens *within a project*, and the current IA makes the human do the join ("which of these runs are mine?"). Meanwhile "All runs" fetches every run across every project to compute overview numbers client-side.

### 1.4 Read-mostly surfaces; verbs live elsewhere

Full verb inventory of the app: kickstart wizard (4 calls), run cockpit (cancel/retry/steer), inbox (decide/ack/resolve), settings (keys/providers/budgets CRUD). That's it. Project page: 0 verbs. Registry: 0. Audit: 0 (100-row cap, no filters, no pagination, and it never calls the `GET /v1/audit/verify` endpoint its own subtitle advertises). Analytics: 0, and it ignores the purpose-built `/v1/analytics` endpoints to recompute stats client-side from raw runs.

### 1.5 The platform models infra objects, not work objects

Engineers think in **issues, sessions, the Owner, PRs**. The platform models **runs, proposals, registry rows**. Concretely:

- **GitHub issues are not stored at all** — no table, no sync; the platform only reacts to comment webhooks (services/api/src/github/processor.ts:176-207). There is nothing to build an issues surface on.
- **Sessions don't exist as a concept** — a run is a one-shot `claude -p … --output-format stream-json` (runner/src/index.ts:146-166); no session ID is ever captured, so nothing can be resumed. The transcript is a lossy derivative (tool inputs truncated to 500 chars, runner/src/parsers.ts:44; no raw JSONL persisted anywhere, contradicting ARCHITECTURE §5's "transcript JSONL to object storage").
- **The Owner has no continuity a human can join** — PO and learning agents are ordinary batch runs with a KB file bundle mounted (packages/harness/src/session.ts:15-24); continuity is re-derived from CHARTER/ACTIVE each run. No conversation object exists.
- **Runs and PRs are not linked** — outcomes are correlated by branch-name prefix heuristics (`^(claude|codex|facility)/`, services/api/src/watchtower/outcomes.ts:21), with no FK to the run that produced them.

### 1.6 (Compounding) The UI promises things the system doesn't do

This is the credibility killer for daily users:

- The steer input says *"delivered to the agent"* and the runner marks it `applied: true` — but the message is appended to a `STEERING.md` file that **the agent is never told exists** (`composedPrompt` never mentions it, runner/src/index.ts:526-531). Platform-lane steering is currently theater.
- The audit page claims events "can be verified for tamper evidence" — the verify endpoint exists and is never called.
- Cockpit "phases" are derived by string-matching event text (`haystack.includes("provision")`, components/run/cockpit.tsx:55-78) rather than typed lifecycle events.
- The kickstart wizard's sidebar pre-explains the error you're expected to hit ("retry after the webhook lands").

**Rule going forward: a control plane never claims more than the system does.** Every label is either backed by a wired mechanism or it doesn't ship.

---

## 2. Close the loop first (platform work the product depends on)

No amount of UI makes a control plane out of a loop that doesn't close. These are the backend blockers, roughly in dependency order. Most are small relative to what's already built.

**P0.1 — PR outcome hook.** Builder-mode platform runs must end in a pushed branch + opened PR, recorded on the run. Grant the runner a scoped contents+PR write token at result time (or have `finishRun` push/open via App identity — respecting docs/hardening.md's App-identity-push rule), write the PR URL into `runs.gh`, and add `runId` to `outcomes` so run ↔ PR ↔ outcome is a stored relationship, not a branch-prefix guess.

**P0.2 — Honest steering, then real steering.** Interim (one line): make `composedPrompt` instruct the agent to check `STEERING.md` between tasks. Real: inject steer messages into the engine loop itself — feasible via stream-json stdin input or the Claude Agent SDK's streaming input mode (see P3). Until then, downgrade UI copy to what it does ("left as a note the agent may read").

**P0.3 — Session identity + raw transcripts.** Capture the engine session ID from the stream-json `init`/`result` events and persist it on the run; ship the raw stream-json/JSONL to the object store (the envelope infra already exists in the gateway for LLM bodies — same pattern). This unlocks resume (`claude --resume <id>` in a re-provisioned workspace), replay, and honest audit. Cheap now, impossible to retrofit onto past runs later.

**P0.4 — A real scheduler for agent defs.** `agent_defs.triggers` accepts `{type:"schedule", cron}` and the seeded PO agent declares `0 6 * * *` — but no code ever reads it; only a hardcoded `learning.nightly` job exists (services/api/src/worker.ts:78 vs. packages/db/src/seed.ts). A user creating a scheduled agent today gets a row that silently never runs. Add a generic cron evaluator in the worker that dispatches any enabled agent def with a schedule trigger. This is exactly the "agents that run periodically, edit the period" requirement — the data model already promises it.

**P0.5 — Repo listing.** There is no way to enumerate repos an installation can access — no octokit `listReposAccessibleToInstallation` anywhere; connect is an optimistic typed-name insert (services/api/src/routes/v1/projects-repos.ts:197-256). Add `GET /v1/github/installations` + `GET /v1/github/installations/:id/repos`. This single endpoint unblocks the kickstart redesign.

**P0.6 — GitHub issue mirror + direct trigger API.** Store issues per connected repo (webhooks already deliver them; add a backfill sync via the App). Add `POST /v1/projects/:id/issues/:number/trigger {agent}` that dispatches a run with the issue as scope — **not** by posting a synthetic comment: hardening rule "bots never summon agents" means an App-authored comment must not be a trigger path. The platform dispatches directly and posts the acknowledgment comment as a side effect.

**P0.7 — Notification fan-out.** The inbox is pull-only. Add an outbound sink layer (the watchtower already has webhook sinks for outcomes — generalize it): proposal created / run blocked / PR opened → Slack webhook + web push. Without push, the inbox loses to ambient GitHub notifications and nobody forms the habit.

---

## 3. The product model: an org shell around project worlds

Adopt the Vercel structure wholesale — it's the right shape for "many projects, one in focus":

```
┌────────────────────────────────────────────────────────────────┐
│ facility.   [project: tam-os ▾]                    ⌘K   adrián │
├──────────────┬─────────────────────────────────────────────────┤
│ PROJECT      │                                                 │
│  Overview    │   The selected project is a world.              │
│  Issues      │   Everything inside is scoped to it.            │
│  Sessions    │                                                 │
│  Owner       │   Overview = live status board (§4b)            │
│  Harness     │   Issues = the work, verbs attached (§4c)       │
│  Settings    │   Sessions = runs, enterable (§4f)              │
│              │   Owner = KB + PO conversation (§4e)            │
│ ORG          │   Harness = the system's definition (§4d)       │
│  Inbox   (3) │                                                 │
│  Audit       │   Org level is thin: portfolio, inbox,          │
│  Analytics   │   audit, analytics, admin.                      │
│  Settings    │                                                 │
└──────────────┴─────────────────────────────────────────────────┘
```

- **Project switcher** in the top bar (recent + search). The projects *grid* survives only as the switcher's zero-state / portfolio page — it is a router, not a destination.
- **Renames.** *Registry* → **Harness** (it defines how well the factory implements/verifies/researches — say so; "registry" describes the storage mechanism, not the meaning). *Runs* → **Sessions** (name the thing engineers operate; a "run" is the execution record of a session). Keep "run receipts" as the receipt vocabulary.
- **Harness exists at both levels**: org harness = the enterprise baseline (bundles, shared skills/rules/contracts); project harness = pins + overrides + project-specific agents. Same UI, scoped.
- **Inbox and audit stay org-level** but default to filters ("mine", "this project") and are deep-linkable per project.
- **⌘K command palette** over everything: jump (project/issue/session), and verbs ("trigger architect on #142", "approve proposal…", "open PR"). Engineers live on keyboards; this is also the cheapest way to make every API verb reachable before its dedicated surface exists.

**Two-tier design weight.** Flow surfaces (Overview, Issues, Sessions, Inbox) are the daily loop — they get the design investment, live data, keyboard paths. Admin surfaces (settings, roles, profiles, providers) are visited monthly — plain, dense, fast forms. The current app inverts this: ornate chrome everywhere, verbs nowhere. That inversion is *why* it feels simultaneously polished and useless.

---

## 4. Surface by surface

Each: what exists (evidence) → target → what it needs.

### 4a. Kickstart — one screen, pick don't type

**Today:** 4-step wizard mirroring the API call sequence (create project row → connect repo row → preview → PR). Asks greenfield-vs-existing up front, makes you type a slug, makes you type `owner/name` free-text, and its sidebar pre-explains the installation error you'll probably hit (projects/new/page.tsx:296-531). Abandoning the wizard mid-way leaves an orphan project row.

**Target:** one screen. A **repo picker** listing what the GitHub App can already see (search-as-you-type, grouped by org), with a second tab "Create new repository" (name field, org select — creation via the existing `createInOrg` path). Below the picker: name/slug auto-derived and editable inline, detection running immediately on selection (the preview endpoint already detects package manager, checks, workflows). One confirm: "Open kickstart PR". Project row is created *at confirm*, not before. Success state: PR link + a "what happens next" checklist (merge the PR, agents that will activate, first canary). If the App isn't installed anywhere: a single install CTA with the GitHub App deep link — not an error message after the fact. Greenfield/brownfield stops being a question the user answers; it's a tab distinction the system infers.

**Needs:** P0.5 (repo listing); kickstart-preview against a repo before project creation (or transactional create-on-confirm); UI rebuild.

### 4b. Project Overview — a status board, not a stats card

**Today:** 4 metrics (runs count, spend, system version), 12 recent run rows, read-only settings card. Zero actions, no repos shown, no health — even though `GET /v1/projects/:id/health` (status + signals) already exists and nothing calls it.

**Target:** the answer to *"what is the factory doing right now, and does it need me?"* — in order of attention:

1. **Needs you** — open gates, blocked/awaiting-human sessions, error-severity watchtower issues, with inline decide/open actions.
2. **Running now** — live sessions with their latest activity line (the data already streams; the cockpit's `latestMeaningful` event, surfaced at list level) + the issue each is working.
3. **The Owner** — last PO session summary, next scheduled run, KB entries awaiting validation.
4. **System health** — projectHealth signals: workflow failure streaks, canary state, fingerprint drift, queue depth.
5. **Recent outcomes** — merged/closed agent PRs with links, one-shot/fixup annotations (the outcomes table has this).
6. **Spend snapshot** — MTD vs. budget bar, per-agent breakdown, link to receipts.

Live by default (extend the existing per-run SSE pattern with a per-project event channel, or 15s revalidation). A status board you have to refresh is a report.

**Needs:** mostly UI over existing APIs (health, issues, outcomes need small list endpoints); P0.1 for outcome links; P0.4 for "next scheduled".

### 4c. Issues — the work, with verbs

**Today:** nothing. GitHub issues aren't stored (§1.5); the platform's "issues" API is watchtower alerts (a different concept — keep it, but never let the two share a name in the UI).

**Target:** the project's work list, mirrored from GitHub, enriched with what GitHub can't show: per issue — pipeline stage (triaged → planned → building → in review → merged, derived from linked sessions/PRs), the sessions it triggered with status/cost, the architect's plan output, the resulting PR + review state. Verbs on the row and in the detail: **run architect**, **run builder**, **start manual session** (§4f), open in GitHub. Filters by stage/label/assignee. This is a *join surface* — the issue body renders read-only with a prominent GitHub link; we do not rebuild the tracker (comments, editing stay on GitHub).

**Needs:** P0.6 (mirror + trigger API); P0.1 (PR linkage) to derive stages; UI.

### 4d. Harness — the system's definition, editable end to end

**Today:** a read-only filtered name list ("registry"). No item detail, no content view, no version history, no create/publish — although the API supports the full lifecycle (create item, draft version, publish with one-active-version enforcement, deprecate). Agent defs have CRUD but two killer gaps: the **prompt** lives in a referenced registry item (edited elsewhere), and **`permissions` is not editable via the API at all** (absent from create/patch schemas, services/api/src/routes/v1/agents-sandboxes.ts:39-78). Schedules are stored but never honored (P0.4).

**Target:** the place you tune how well the factory works. Tabs: **Agents · Skills · Rules & guards · Workflows · Sandboxes**.

- Every item: rendered content (markdown, not raw rows), version history with diffs, draft → publish flow (existing API), where-used (which projects/agents pin it), provenance (human edit vs. learning-agent proposal).
- **Agent detail is the flagship**: prompt/contract editor (editing the underlying registry item's next draft inline — the indirection is an implementation detail the UI must hide), permission matrix, model + engine, sandbox profile, triggers incl. **schedule with a cron/period picker**, enabled toggle, and **"test run"** (dispatch against a scratch scope, watch it in the cockpit).
- Editing never breaks the ratchet: an "edit" is always a new draft version; publish supersedes atomically (the backend already guarantees this — expose it, don't re-invent mutation).
- Org level shows the baseline + bundles; project level shows effective config (pins/overrides) with "differs from org baseline" markers.

**Needs:** permissions-editability API fix; P0.4 scheduler; bundle API routes (tables exist with no HTTP surface); substantial UI.

### 4e. Owner — a knowledge base you can read, an agent you can talk to

**Today:** the full KB API exists (spaces, typed entries S/D/T/V, link graph, validation) with **zero** web presence. The PO agent is a stateless nightly batch run (whose schedule doesn't actually fire — P0.4) with no conversation concept.

**Target — two panes:**

1. **The knowledge base, readable like Notion:** tree by chain type (Signals / Decisions / Tasks / Verifications), rendered markdown, link graph navigation (backlinks), charter + active always pinned, full-text search. Direct editing allowed (API exists) with attribution and validation-on-save; entries authored by the PO and pending human validation are visibly badged and decidable inline (the `kb_amendment` proposal flow already exists end-to-end).
2. **The conversation:** a persistent chat with the Project Owner. This is how steering happens — "stop prioritizing X", "you got Y wrong", "investigate Z" — and the PO responds, amends the KB (as proposals or direct writes per its permissions), and its behavior changes because the KB *is* its memory (CHARTER/ACTIVE re-read every session). Technically this is a new object — `conversations` — backed by a resumable engine session in a sandbox (Claude Agent SDK is the natural fit: session persistence, streaming input, resume; see §10 Q1 — the seeded PO is currently codex/gpt-5.5, so either the PO standardizes on an engine with session semantics or the conversation layer needs an engine-agnostic protocol). Between turns the sandbox can hibernate; the conversation transcript is itself a session with receipts and audit like any other.

Plus an **activity feed**: every PO run, what it read, what it changed, what it proposed — the "what is the agentic project owner doing" question answered at a glance.

**Needs:** P0.3/P3 session infrastructure; conversations model; KB UI (pure frontend over existing API); P0.4 so the PO actually runs on schedule.

### 4f. Sessions — the moat

**Today:** the cockpit is the app's best surface (true SSE + fallback, phases, platform-vs-self-reported checks, cancel/retry, steer input) — good bones, wrong depth: lossy transcript, steering theater (§1.6), no resume, no PR artifact (never recorded), phases by string-matching.

**Target:** every agent session — issue-triggered, scheduled, or manual — is **observable, enterable, and resumable**:

- **List** (per project; org-wide fleet view at org level): status, issue, agent, engine, duration, cost, artifact — live.
- **Cockpit v2:** full-fidelity transcript (raw stream, rendered per event type with tool-call detail), phase rail from typed lifecycle events, checks with output, **artifacts** (PR/branch/issue links — P0.1), receipts (cost, tokens, per-call gateway drill-down via the existing llm-requests envelope API), and **"audit slice"** — the run's audit events filtered in one click.
- **Take over:** steer that demonstrably reaches the agent (P0.2), **interrupt-and-redirect** (stop the current turn, inject new instructions, continue — not just kill), and **resume** a terminal session (re-provision workspace, `--resume` the persisted session ID). Every human intervention is a first-class logged event on the timeline (steer events already are — keep that property).
- **Start a session from an issue** in "manual steer" mode: it runs in the isolated sandbox with governance (keys, budget, audit) but you drive it like a local session. This single feature is the reason to stop running agents on laptops.
- **Open locally:** `facility session attach <id>` from the CLI for people who want the terminal — same session, same audit.

**Needs:** P0.1/P0.2/P0.3 + the interactive bridge (Agent SDK streaming input or stdin protocol); this is the largest platform investment and the highest-value one.

### 4g. Inbox — everything waiting on *you*, and it comes to you

**Today:** solid bones — proposals + watchtower issues, arm-then-confirm decisions, expiry, a real ledger. But pull-only, org-global with no filters, and it misses the two most common review moments: a PR ready for review and a new KB entry to validate.

**Target:** one queue of *everything waiting on a specific human*: HITL proposals (all 7 action types, each with a purpose-built card — a `kb_amendment` renders as a KB diff, a `task_creation` as the would-be issue), **PR-ready-to-review** items (from P0.1 outcomes, with review deep link), **KB validations**, blocked sessions. Filters: mine / project / type. Each item: inline context, decide (existing arm-confirm pattern — keep it), or deep-link to the artifact. **Push** via Slack/web push (P0.7) with per-user routing preferences. Inbox zero must be reachable and mean something.

**Needs:** P0.1, P0.7, card renderers per action type; the decide machinery already exists.

### 4h. Audit — from wall of rows to forensic tool

**Today:** flat 100-row table, no filters, no pagination, no detail, verify endpoint unused — while the backend is genuinely complete: keyset pagination, actor/action filters, project scoping, full payloads in the list response, and a real hash chain with a verify walk (services/api/src/routes/v1/issues-audit-analytics.ts:151-303).

**Target:** filter bar (time, actor, action prefix, project, target type), infinite scroll on the existing cursor, **row → detail drawer** with the full payload pretty-printed and prev/hash lineage, a **verify-chain** button surfacing `{ok, firstBreakSeq}`, and contextual entry points everywhere ("audit slice" from a session, key, proposal, member). One API nicety: `from/to` currently means *seq*, not time — add timestamp filtering.

**Needs:** almost pure UI; one small API addition.

### 4i. Analytics — folded in, not a destination

**Today:** a standalone page that ignores the purpose-built `analytics_daily` rollup endpoints and recomputes success rates client-side from all runs.

**Target:** kill the top-level page. Org overview gets the portfolio view (spend/outcomes per project, from `/v1/analytics`); project overview gets its own (§4b); Sessions/Issues get cost-per-issue and cost-per-agent columns (llm_requests already attributes task/agent). Deep analysis is a data-mining concern — the API and `facility llm-requests` already serve it; a dashboards product can come much later, if ever.

### 4j. Settings — finish the admin plane

**Today:** keys/providers/budgets are real; members list is read-only ("v1" note), roles have zero UI (fetched only to fill a dropdown), virtual keys and sandbox profiles have none.

**Target (plain, dense forms — this is the admin tier):** members invite/role-change/remove (API exists), a roles editor with a permission matrix, sandbox profiles (org), virtual keys + repo management at project level, budget scopes surfaced where they apply (org/project/agent). Plus one page GOAL demands that costs almost nothing: **"Manage Facility from your tools"** — copyable MCP config + CLI setup + key issuance in one place, making the MCP/CLI parity a visible feature instead of a secret.

---

## 5. Voice: tool register, everywhere

Concrete rules (they operationalize brand law, which the current app violates — §1.2):

1. **Page titles are nouns** ("tam-os", "Sessions", "Inbox"), the line under them is **live state** ("3 running · 1 blocked · 2 PRs waiting"), not philosophy.
2. Taglines and method lines live on the login screen, the docs site, and the README. Nowhere else. (Login already does this well.)
3. Empty states are onramps with a verb: "No sessions yet — trigger `/architect` on an issue or start one here →". (A few already do this; make it the standard.)
4. Never label a mechanism the system doesn't have (§1.6). The steer placeholder, the audit subtitle, and "applied: true" all get fixed by P0 work or reworded until then.
5. Keep the domain vocabulary — gates, receipts, canary, watchtower, the ratchet — as **names of live features**. "Receipt" on a session's cost panel: good. "Every run leaves a receipt." as a headline: cut.

---

## 6. Beyond the feedback — my additions

1. **UI verb = API verb, always.** Every new surface action lands in the typed SDK route map first, then the UI consumes it — MCP tools and CLI commands inherit it nearly for free (the pattern already exists and is the platform's best architectural property). This keeps GOAL's "manage via MCP/CLI from Cowork/Claude Code/Codex" true *by construction* forever.
2. **Issues-first, sessions-attached.** The unit of engineer attention is the issue; sessions hang off it. An orphan session list (today's "runs") is an infra view — keep it one level down and at org level for fleet ops.
3. **Live-first.** LISTEN/NOTIFY → SSE already works per run; generalize to project/org channels. No surface that claims "now" may require F5.
4. **Every entity links to its primary artifact.** Issue → GitHub issue; session → PR/branch; KB entry → its page; LLM call → envelope; anything → its audit slice. Facility wins as the *join*, never by hiding the source of truth.
5. **Trust cues in the chrome.** The project header shows lane (repo/platform), canary state, and fingerprint status as small live glyphs. Confidence in the factory is itself a product feature — and it's honest advertising for the governance layer.
6. **Mobile = triage.** The responsive requirement is real but scoped: inbox decisions, watching a session, sending a steer. Not skill editing on a phone.
7. **Typed lifecycle events.** Replace string-matched phases with explicit `phase` events from the runner. Small, kills a whole class of UI lies.
8. **Empty-state onboarding replaces any tour.** The system teaches itself at the moment of need or not at all.

## 7. What stays (do not churn)

- **TAM-50 visual system** — verifiers scored UI taste 84-88; the problem is IA/voice/verbs, not aesthetics. Same components, redistributed.
- **Cockpit bones** (SSE + fallback, platform-vs-self-reported checks distinction — that distinction is *excellent* and should spread to more surfaces).
- **HITL ledger + arm-confirm pattern**, the audit hash chain, gateway metering/budgets, registry immutable versioning (as the engine under Harness editing), the honest `Offline` failure state, the CLI.
- **Security posture.** New capabilities open real surfaces: session attach = remote input to a privileged agent (authz + full logging, already implied by design); repo picker must respect installation scoping; direct issue-trigger keeps the userCanWrite check the comment path has; App-authored comments must never trigger runs (hardening.md).

---

## 8. GOAL.md capability map

| GOAL capability | Today | Lands in |
|---|---|---|
| Manage projects | list + thin detail | Project world (§3, §4b) |
| Analytics w/ project separation | page ignores rollup API | folded into overviews (§4i) |
| Sandboxes: Claude/Codex/BYO | ✅ real (docker + Fargate) | Sessions (§4f) |
| Skill/knowledge mgmt (rules, harnesses, skills) | API ✅, web ✗ | Harness (§4d) |
| Create agents for project use cases | API partial (permissions not settable) | Harness agents (§4d) |
| Versioning/templating of the system | ✅ registry + fingerprints | Harness + project settings |
| Kickstart generating repo assets | ✅ backend, wizard UX wrong | Kickstart (§4a) |
| Governance of resources | ✅ core strength | everywhere (verbs + gates) |
| WorkOS SSO | ✅ | — |
| Upgrades + fingerprint integrity | ✅ backend, no web trigger | project settings + trust cues |
| Visibility into SDLC issues | watchtower ✅ / GH issues ✗ | Overview + Issues (§4b, §4c) |
| Cost mgmt (keys, budgets, attribution) | ✅ strong | receipts in context |
| LLM proxy/audit/observability | ✅ gateway + envelopes | Session receipts, audit |
| Multi-source triggers → issues | generic inbound exists | Issues (§4c) later |
| **Access agent sessions to steer/diagnose** | ✗ (steering theater, no resume) | **Sessions (§4f) — the moat** |
| GitHub App | ✅ | repo picker (P0.5) |
| HITL inbox | ✅ pull-only | Inbox v2 (§4g) |
| MCP/CLI manageability | ✅ near-parity | §6.1 rule + settings page |
| Roles/authz | API ✅, UI ✗ | Settings (§4j) |
| Store everything / data-mine | mostly (raw transcripts missing) | P0.3 |
| Learning mode nightly + validation | ✅ wired (fixed cron) | Inbox + Harness provenance |
| PO agent (Limina-like) + KB | API ✅, schedule ✗, web ✗, no conversation | Owner (§4e) |

---

## 9. Sequencing

Four phases, each independently shippable, each with a hard DoD. P0 is backend and runs in parallel with P1.

**P0 — Close the loop** (platform): PR outcome hook · honest steering · session IDs + raw transcripts · agent-def scheduler · repo listing · issue mirror + direct trigger · notification sinks.
*DoD: a `/builder` platform-lane run on the mirror repo ends in an open PR linked on the run; a steer message provably alters agent behavior; the PO fires at 06:00 without a human.*

**P1 — The flip** (web): project-in-focus shell + switcher + ⌘K · voice purge · project Overview status board (live) · kickstart rebuild on the repo picker.
*DoD: pick tam-os → one screen answers "what's running, what's blocked, what needs me" without a reload; kickstarting a repo takes one screen and zero typed identifiers.*

**P2 — The daily loop** (web): Issues surface with trigger verbs · Inbox v2 with PR/KB items + Slack push · audit filters/detail/verify · receipts in context.
*DoD: triage → trigger architect → approve plan gate → watch builder → get pinged → open PR, all from Facility.*

**P3 — The moat** (platform+web): interactive sessions — attach/interrupt/redirect/resume, manual session from issue, full-fidelity transcripts, logged interventions, `facility session attach`.
*DoD: an engineer runs a real tam-os issue end-to-end from a browser session they steered at least once, and would choose it again over their laptop.*

**P4 — The brain** (web+platform): Harness editing (agents/skills/rules/schedules, diffs, where-used, test-run) · Owner surfaces (KB reader, PO conversation, activity) · learning-mode review polish.
*DoD: change the builder's prompt and schedule from the browser; ask the PO to deprioritize something in chat and watch the KB change (through its gate).*

Then the gate that already governs everything else: **tam-os cutover** (owner-gated) — the week-long dogfood of §0 is the acceptance test.

**Anti-goals for the whole effort:** don't rebuild GitHub (mirror + verbs + deep links only) · don't add features to the old IA while the flip is in flight · don't spend another cycle polishing chrome ahead of verbs · don't ship a label a mechanism doesn't back.

---

## 10. Decisions (Adrián, 2026-07-06)

1. **Conversation/attach engine: Claude.** The PO runs on Claude (Agent SDK semantics for the interactive layer: session persistence, streaming input, resume). Batch runs (architect/builder/learning) keep the headless engine protocol, engine per agent def.
2. **Issue mirror scope: strict read-mirror + verbs.** All issue authoring stays in GitHub (the PO's gated `task_creation` remains the one creation path).
3. **Notifications: in-platform Inbox only.** No Slack/email/web-push integrations — the Facility Inbox is the notification center (P0.7 is re-scoped to inbox item sources + unread/badge affordances instead of outbound sinks).
4. **Renames confirmed.** Registry → **Harness**, Runs → **Sessions** across UI/docs/CLI aliases; API routes stay stable.
5. **Org landing: last-used project**, Vercel-style. Thin portfolio remains reachable via the switcher.
