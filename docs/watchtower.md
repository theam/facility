# The watchtower

An agent pipeline fails politely. A broken trigger doesn't page anyone — work
just stops arriving. A review lane with a permissions bug reviews nothing,
green. A telemetry bug can fail successful runs for a week while the dashboard
under-reports. We know because each of those happened to the production system
facility is extracted from, and **nothing caught them** — silence looks
identical to health. The watchtower is the layer built after that lesson: the
SDLC observes, measures, and hardens itself.

Design rule number one: **the monitor must not depend on what it monitors.**
Everything below reads the GitHub API directly — never telemetry the facility
itself writes — and the watchtower workflow is not in its own watchlist.
Design rule number two: the watchtower is **locked by a guard**
(`guards/watchtower-locked.mjs`) — a disabled schedule or a drifted canary
hash fails `node guards/run.mjs`, because a watchtower that quietly rotted is
worse than none: it keeps vouching.

## The instruments

| instrument | cadence | what it does |
|---|---|---|
| **outcomes** | nightly | joins every terminal agent PR to its linked issue, human merger, merge-commit shape plus allowed methods, review rounds, and human fixup commits. Fate is merged or rejected; accepted means human squash-merged; one-shot means merged with zero change requests and zero human fixup commits; lead time is issue creation → merge. Ambiguous merge-method evidence is reported unassessed, never guessed. Keeps acceptance / coverage / one-shot / fixup numbers on the `facility-watchtower` dashboard issue — a metric, not an anecdote. |
| **health** | daily | failure streaks and run budgets per facility workflow (budgets: `.github/facility/watchtower/budgets.json`, a *reviewed file*, not a dashboard setting). Manages a single incident issue — opens it, updates it, closes it on recovery — and **goes red itself** when the facility is unhealthy, so the Actions tab is the at-a-glance signal. |
| **canary** | weekly | a synthetic `/architect` flight through the REAL pipeline: trigger → authorization → crew run → reply. Monitors tell you a workflow ran; only the canary proves the whole chain still works before a human hits the breakage. On the production system its *first* flight caught a real authorization bug. |

All numbers are computed from the API on schedule and published where the
team already lives (issues, the Actions tab) — no dashboard product to stand
up, and nothing curated for a slide. An optional `WATCHTOWER_WEBHOOK_URL`
repo variable POSTs each outcomes summary as JSON to the sink of your choice
(PostHog, your warehouse, a spreadsheet glue script).

## How the canary is authorized

The canary is the one bot allowed to summon the crew, and it earns that with
the narrowest authorization in the system — **the message is authorized, not
the sender**:

1. The probe must be posted with a GitHub App token (`CANARY_APP_ID` /
   `CANARY_APP_PRIVATE_KEY`): comments posted with the workflow's own
   `GITHUB_TOKEN` trigger no workflows at all, so a GITHUB_TOKEN canary would
   test nothing (hardening note 14).
2. `facility-crew.yml` admits that bot login only for an `issue_comment` on
   an `agent-canary`-labeled issue, resolving to `/architect` (never
   `/builder`), whose body is **byte-identical — SHA-256, CR-stripped — to
   the pinned probe** in `.github/facility/watchtower/canary.mjs`.
3. The hash in the crew workflow is generated from that same constant at
   `init` time and held in sync by the `watchtower-locked` guard.

A leaked canary App key can therefore at worst replay one fixed, read-only,
bounded-cost probe — never run attacker-chosen instructions. Without the App
secrets, the canary skips with a notice; everything else works.

## Budgets

`budgets.json` caps daily failures and weekly runs per workflow. Breach turns
the daily health run red and lands in the incident issue. Budgets live in the
repo so a budget change is a reviewed diff with an author and a reason —
"costs will run away" is answered with a file, not a promise.

## What this is not (yet)

The production system this generalizes also captures **per-run receipts**
(tokens, cost, duration, check outcomes, digest-verified collector) and mines
failure patterns into proposed guards weekly. Both need deeper engine
integration than a vendored script should assume; they are the next
watchtower instruments on the roadmap. The join that matters most — *was the
work accepted?* — ships today, because it needs nothing but the GitHub API
and honesty.
