# Spec: GitHub App integration (services/api) — install, kickstart, fingerprints, upgrades, triggers

**Scope**: the platform becomes installable as a GitHub App in any org: webhook intake, repo connection, server-side kickstart (rendering the v0.2 template set), fingerprint integrity, upgrade PRs, slash-command trigger routing (compat lane), and outcome collection hooks. Lives in `@facility/api` (+ `@facility/core` template engine port) — no new service.

Read first: control-plane.md (repos, github_installations, registry template_set, platform_issues, outcomes), packages/cli/src/{init.mjs,render.mjs,detect.mjs} (the vendored installer this productizes — the RENDERED OUTPUT must stay byte-compatible), docs/hardening.md (notes 1,3,5,7,10,13,14 are binding), discovery/tam-os.md (fragile list).

## App + webhooks

Octokit (`@octokit/app`, `@octokit/webhooks`). Config env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, \n-escaped ok), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`. Endpoint `POST /webhooks/github` (raw-body HMAC verify BEFORE parse; reject unsigned in ≤1ms path; store every verified delivery in inbound_events).

Handled events (idempotent by delivery id):
- `installation[created|deleted|suspend|unsuspend]`, `installation_repositories` → upsert github_installations; orphaned repos flagged.
- `push` (default branch): if any managed path changed → enqueue `fingerprints.verify(repoId)`.
- `issues[opened,labeled]`, `issue_comment[created]` → trigger router (below).
- `pull_request[closed]` on agent branches (`claude/*`,`codex/*`,`facility/*`) → upsert the raw terminal outcome and review/fixup counts immediately. A merged row remains unassessed until the independent outcome collector obtains merger, enforced merge-method, and linked-issue evidence from GitHub.
- `workflow_run[completed]` for facility-* workflows → health signal store (platform_issues on failure streaks handled by watchtower chunk).

**Trigger router (compat lane)**: on issue_comment matching start-of-line `/architect|/builder|/codex-architect|/codex-builder` (the hardening-5 regex, ported exactly) AND sender is human (`sender.type != 'Bot'`) AND sender has write permission (check via API) AND the repo's project has a platform-native agent_def bound to that command → create platform run (trigger payload: {repo, issue, comment id — NEVER raw text; the runner fetches text at execution time as data}) and post an ack comment via App. If the repo runs vendored workflows for that command (project setting `execution_lane: repo|platform` per command), do nothing — the repo workflow handles it. Default for migrated repos: `repo` lane (zero behavior change).

## Kickstart (productized `facility init`)

`POST /v1/projects/:id/kickstart` {repoId, answers {defaultBranch, provisionCmd, checkCmds[], modules[], modelTier, board?}, mode: pr} (`projects:kickstart`):
1. Read repo tree via API; run detection (port `detect.mjs` semantics to `@facility/core/detect.ts`: package manager, workflows present, checks guess) to prefill/validate answers.
2. Render the bundled template_set (registry content = files of packages/cli/templates) with `@facility/core/render.ts` — a faithful port of `render.mjs` ({{TOKEN}} substitution, managed-block append semantics for AGENTS.md/CLAUDE.md) plus the same variable derivations init.mjs does (checks list/JSON, doctor watch list, board step, canary SHA). Byte-compat test required against the CLI's output.
3. Create branch `facility/kickstart` from default; one commit via Git Data API (trees/blobs — one commit, correct modes incl. executable scripts, symlink `.agents/skills` → `.claude/skills` as a symlink blob mode 120000); open PR with a rendered summary body listing manual steps (secrets, branch protection, App perms) — the init "what's left" section, adapted.
4. Store fingerprint manifest (path+sha256 of every rendered file, template_set version) with status `pending_merge`; on merge webhook of that PR → verify against default branch → status ok; record system_version on project.
5. HITL proposal `kickstart_review` (context: file list + PR link) so the inbox carries gate 1; approving = informational ack (the real gate is the PR merge — a human on GitHub), rejecting closes the PR via App.

`GET /v1/projects/:id/kickstart/preview` → rendered file list {path, size, sha256} + diff vs existing repo files (existing non-facility files never overwritten: same conflict rule as init.mjs — report, don't clobber).

## Fingerprints & upgrade

- `fingerprints.verify(repoId)` worker: fetch managed paths from default branch; diffManifest (core) → ok | drifted {modified/missing} | corrupted (managed file modified without a platform upgrade); update repos.fingerprint_status; on drift/corrupt → deduped platform_issue + inbox notification. Manual edits are ALLOWED to become legitimate: `POST /v1/repos/:id/fingerprints/adopt` (`projects:write`) re-baselines from the current branch and records who adopted what (audit) — drift is a signal, not a police action.
- `POST /v1/projects/:id/upgrade` {toVersion?}: render target version; three-way per file (base = manifest content hash's stored blob? we store only hashes — so: base = rendered OLD template with the project's recorded answers, ours = repo current, theirs = rendered NEW): clean-apply when repo file == old render (byte); else mark conflicted, include both in PR body under conflict markers in a `.facility/upgrade-conflicts/` copy, never overwrite the live file. PR `facility/upgrade-vX`; fingerprint updates on merge. Answers persisted per repo at kickstart (`repos.render_answers` jsonb — add column via migration).

## Outcome + push identity invariants

All platform-created commits/comments/PRs go through the App installation token (hardening 14: pushes trigger CI like anyone's). Commit author = the App bot identity (hardening 1). Never push to the default branch (create branches + PRs only) — enforce in the octokit wrapper (refuse ref == default branch on push paths) with a unit test.

## Mechanical floor

```
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && node guards/run.mjs
```

Tests (vitest; octokit fully mocked with recorded-shape fixtures — no live GitHub):
1. Webhook HMAC: valid processes, invalid 401, replayed delivery id no-ops.
2. Render byte-compat: run the REAL CLI (`packages/cli`) `init --yes` into a temp dir (fixture answers, canary bits deterministic) vs `core/render.ts` output for the same answers → byte-identical file set (this is the load-bearing test; if impossible for a file, the deviation must be listed and justified in the report).
3. Kickstart flow: tree/blob/commit/PR calls match golden sequence; symlink mode preserved; fingerprint stored pending → ok on merge webhook.
4. Trigger router: start-of-line only (prose "ask /architect" ignored), bot sender refused, non-writer refused, ambiguous two-commands errors, repo-lane command untouched, platform-lane creates run + ack.
5. Fingerprint verify: ok/drift/corrupt paths; adopt re-baselines + audits.
6. Upgrade: clean three-way applies; conflicted file lands in upgrade-conflicts copy, live file untouched.
7. Push-identity guard: attempt to push default branch throws.

## Judgment criteria

Untrusted text discipline end-to-end (issue/comment bodies never interpolated into prompts/shell/SQL — grep test); byte-compat render is real, not "similar"; all octokit writes centralized in one client wrapper with the default-branch refusal; webhook handler returns 2xx fast and defers work to pg-boss (GitHub 10s limit); every outward action (PR, comment, close) audited with target repo+number.
