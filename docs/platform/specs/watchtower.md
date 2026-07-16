# Spec: watchtower service + analytics rollups (services/api worker)

**Scope**: the self-observation layer, platformized per project: outcome collector, health monitor, canary, analytics rollups, issue lifecycle. Workers in `@facility/api` (pg-boss crons already registered as no-ops by the control-plane chunk — this fills them in) + a few read endpoints.

Read first: ARCHITECTURE.md §5 watchtower flow, discovery/tam-os.md (§receipts/§SDLC — outcome semantics, monitor independence), packages/cli/templates/watchtower/*.mjs (the vendored logic being centralized — port semantics faithfully), docs/hardening.md note 15.

## Rules that bind

1. **Monitor independence**: watchtower workers read the GitHub API (via installation tokens) and NEVER the platform's own telemetry for health judgments. Receipts/llm_requests inform COST panels only, clearly separated.
2. Numbers are live; no curated fields anywhere.
3. Watchtower failures are themselves platform_issues (kind canary_failure / integration_error) — silence must turn red.

## Workers

`watchtower.outcomes` (nightly per project with repos): join agent PRs (branch prefixes `claude/*`, `codex/*`, `facility/*`, configurable per project) that reached terminal state since last run. Preserve raw fate as merged or rejected, and collect GitHub evidence {merged_by + actor type, merge-commit parent count, repository merge-method policy, earliest closing issue}. Accepted = a `User` merged and the commit shape plus allowed methods prove squash; ambiguous method or missing merger evidence = NULL/unassessed, never guessed. Upsert outcomes with linked issue, issue-opened timestamp, issue→merge hours, review rounds (change-request count), and fixup commits (human commits after the first agent commit). Compute rolling acceptance = accepted/assessed; one-shot = merged with 0 change requests and 0 fixups, divided by merged outcomes. Report merged/rejected fate separately from assessed/accepted/not-accepted/unassessed evidence. Evidence-read failures raise a platform issue, preserve any prior proof, and prevent the project cursor advancing so the PR is retried. Optional per-project sink: POST the versioned summary JSON to integrations of kind webhook flagged `outcomes_sink`.

`watchtower.health` (daily per project): per facility workflow (vendored lane) — failure streaks + run counts vs budgets (source of truth: repo's `.github/facility/watchtower/budgets.json` when present — READ from repo, honoring the vendored contract — plus platform budgets for platform-lane runs); breach/streak → open/update ONE deduped platform_issue per project (kind budget_breach / run_failure, fingerprint per workflow+window); recovery → auto-resolve with a note. Platform-lane health: runs stuck >2× profile timeout, dispatch-queue depth, gateway error rate (from llm_requests status) → same issue pipeline. `GET /v1/projects/:id/health` → {status: ok|warn|red, signals[]} (the endpoint the web health badge uses).

`watchtower.canary` (weekly per project, opt-in flag): platform-lane synthetic probe — trigger the project's architect agent_def with the pinned canary input (constant text, sha256 recorded); PASS = run reaches succeeded AND produced a receipt AND posted its ack; FAIL → platform_issue kind canary_failure. For repo-lane projects with vendored canary, do NOT duplicate: instead verify the repo's canary workflow ran green this week (API check) — flag if it didn't.

`analytics.rollup` (hourly): upsert analytics_daily {project, day, agent_def, model} ← runs (count/status), llm_requests (tokens, cost_cents), outcomes (total/assessed/accepted/one-shot when day closes). Endpoint `GET /v1/analytics?projectId=&from=&to=&groupBy=day|agent|model` reading rollups (never raw scans on request path). Org overview endpoint `GET /v1/analytics/overview` → the numbers the web overview/analytics pages consume (live agents, spend MTD, 30-day outcome totals + evidence coverage, acceptance 30d, one-shot 30d, per-project rows).

`hitl.expire` (hourly, exists as stub): expire overdue proposals → ledger event expired + notify.

## Issue lifecycle polish

`platform_issues`: transitions open→acked→resolved via existing routes; auto-reopen on recurrence (fingerprint match while resolved → reopen, count++, audit). Inbox surfacing: issues of severity error create a lightweight inbox signal (not a proposal — a distinct `GET /v1/inbox` section `{proposals[], issues[]}` — adjust route response, keep backward-compatible field `items` = proposals).

## Mechanical floor

```
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && node guards/run.mjs
```

Tests (GitHub client mocked with fixtures; PG real): outcomes join math (fixture PR sets → human squash-merge acceptance, evidence coverage, issue lead time, one-shot, and fixups exact), dedupe/reopen behavior, health streak detection + budgets.json honoring + recovery auto-resolve, canary pass/fail paths (platform lane; repo-lane verify path), rollup idempotency (run twice → same rows), analytics endpoints return rollup-backed numbers, monitor-independence guard test: health worker module imports contain no receipts/llm_requests reads (static assertion on the module's query surface — keep health queries in a file that imports only octokit wrapper + platform_issues).

## Judgment criteria

Faithful ports of the vendored outcomes/health semantics (diff against templates/watchtower/*.mjs behavior, not vibes); one issue per problem (dedupe fingerprints thought through); no unbounded GitHub API scans (since-cursors persisted per project); rollups are the only thing request paths read; the independence rule holds structurally, not by comment.
