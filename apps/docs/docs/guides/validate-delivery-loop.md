---
title: Validate the complete delivery loop
---

# Validate the complete delivery loop

A healthy API and a successful webhook delivery prove connectivity, not the
product experience. Before treating a Facility environment as ready, exercise
one disposable repository exactly as a user would: kickstart, request a plan,
approve it, receive a builder pull request, run the repository agents, merge,
and inspect the evidence.

Use a private, disposable repository with representative build and test
commands. Do not use a production repository for this acceptance run.

## 1. Prove platform readiness

Log the CLI into the environment, then run the platform doctor and project
health checks:

```bash
facility login --url https://api.facility.example.com --key "$FACILITY_API_KEY"
facility doctor --platform
facility health <project>
facility audit verify
```

Do not continue past a `FAIL` for a surface included in the release. A
headless, API-key-only acceptance environment may record `auth_config` and
`preview_protection` as explicitly out of scope when the web service and native
previews are disabled. That exception validates the API delivery loop only; it
must not be used to claim that browser login or protected previews are ready.
Confirm that at least one credential is configured for every model provider
used by the selected agents:

```bash
facility providers list
```

The GitHub App's **Advanced → Recent deliveries** page must show a successful
`installation` or `installation_repositories` delivery. Create a test issue and
confirm that its `issues` delivery also receives a `2xx` response.

## 2. Kickstart and choose one execution owner

Connect the repository and preview the generated assets. The following example
uses Facility sandboxes for architect and builder runs:

```bash
facility repos connect <project> --repo <owner/repository> --branch main
facility kickstart <project> \
  --repo <owner/repository> \
  --provision "pnpm install --frozen-lockfile" \
  --checks "pnpm lint,pnpm typecheck,pnpm test" \
  --execution-lane '{"architect":"platform","builder":"platform"}'
```

Use `repo` instead of `platform` for a role that should execute in GitHub
Actions. A command must have exactly one owner. The generated repository
workflows stay installed as a fallback, but their matching jobs are gated off
when the platform owns that role. This prevents one slash command from creating
two plans or two builder branches.

Review and merge the kickstart pull request. Then verify the recorded baseline:

```bash
facility repos list <project>
facility repos verify <repo-id>
```

The result must be `ok`. A missing or modified managed asset must instead be
reported as drift, including managed skill symlinks.

## 3. Exercise both human gates

Open a small, testable GitHub issue and comment `/architect` or
`/codex-architect`, matching the configured lane. Facility should acknowledge
the command with one live progress comment. It shows the request context, run
ID, current phase, and a checklist while the agent works. Facility updates that
same comment at execution milestones and replaces it with the terminal result;
it must not leave users with only a static queue acknowledgement.

The initial lifecycle checklist is only a fallback while the sandbox starts.
The agent must then publish its own task-specific context and checkbox list in
that same comment, and update it as its actual steps start and finish. A
governed agent run that never publishes task-specific progress is invalid; a
synthetic lifecycle checklist alone is not sufficient acceptance evidence.

When the architect finishes, the final plan and both next actions must be
available directly in GitHub:

- comment `/builder` (or `/codex-builder`) to approve the displayed plan and
  start implementation with that exact plan bound into the builder run;
- comment `/architect <feedback>` (or `/codex-architect <feedback>`) to request
  another planning pass.

The CLI remains an equivalent operator path, not a requirement for the normal
GitHub experience:

```bash
facility sessions watch <architect-run-id>
facility inbox --state open
facility inbox decide <proposal-id> approve --note "validated plan and acceptance criteria"
```

The architect run must receive the issue title, body, and command comment as
untrusted request data. It must receive the repository's provision command and
checks, produce a concrete plan, and stop without changing the repository.
Approval must dispatch the matching builder with the exact approved plan in its
immutable run scope.

Watch the builder:

```bash
facility sessions watch <builder-run-id>
```

The builder must clone the intended repository, provision it, implement the
request on a non-protected branch, and run every configured check. Before it
finishes, it must pass its semantic branch, Conventional Commit message, PR
title, and complete PR body to the runner-owned `facility-delivery write`
command. The command creates the exact machine-readable receipt and validates
it immediately. A Stop hook blocks completion while repository changes exist
without a valid receipt and returns the validation error to the agent so it can
correct the values. Facility excludes that transport file from the diff,
creates a GitHub-signed commit with the App, and opens the bot-authored PR using
the agent's exact title and description. The platform never substitutes a
generic title or body. A missing or invalid delivery receipt, failed engine,
provision command, configured check, signed commit, branch publication, or PR
creation must make the run fail; an agent's self-reported success is not enough.

If a builder is interrupted or its model connection closes, Facility stores a
bounded resume checkpoint alongside the Claude session. The checkpoint contains
the worktree delta from the admitted base (including binary changes), untracked
files, managed progress and delivery artifacts, and the local branch—but never
the Git database, dependencies, or clone credentials. A resumed run verifies the
same base commit, restores that checkpoint before package installation and
provisioning, and re-injects the bounded original governed scope and approved
plan even when Claude's conversation was compacted. Nested resumes continue
carrying that original scope instead of replacing it with the previous `resume`
instruction.

The pull request is Gate 2. Confirm that review and receipt workflows complete,
inspect their comments and artifacts, and merge only after a human accepts the
result.

## 4. Exercise the operational agents

Run these on disposable branches or through `workflow_dispatch` where the
generated workflow supports it:

- **Review:** open a pull request with a real code change and confirm the review
  reports evidence without approving or merging. Its run context must retain
  the original request, accepted architect plan, builder run identity, and
  signed receipt even after newer review runs exist on the branch. A re-review
  after a repair must also receive the successful repair run and the review
  feedback that authorized it, so it evaluates the full governed chain rather
  than mistaking an accepted correction for unrelated scope.
- **Address review:** leave an actionable review comment, invoke the generated
  address-review flow, and confirm its signed correction lands on that exact PR
  branch without opening a second branch or pull request.
- **Doctor:** make a normal CI check fail in a safely repairable source file.
  Confirm the doctor either repairs and verifies the failure on that same PR
  branch or stops at its documented security boundary.
- **Security sweep:** dispatch the sweep and confirm it remains read-only,
  produces a receipt, and files findings as issues rather than modifying code.

Fork-originated runs must not receive repository secrets. Bot-authored slash
commands must not recursively trigger agents.

## 5. Prove skills, metering, and improvement governance

Create a small test skill, publish it, and start another disposable run:

```bash
facility registry create \
  --scope project \
  --project <project-id> \
  --kind skill \
  --name validation-skill \
  --content-file ./validation-skill.md
facility registry get <item-id>
facility registry publish <version-id>
```

The published skill must be materialized into both `.agents/skills` and
`.claude/skills` in the sandbox. Project-scoped skills override an organization
skill of the same name; skills from another project must never appear. Plain
Markdown skill content is accepted: Facility adds valid skill-package
frontmatter when it materializes a registry skill, while preserving content
that already supplies frontmatter.

Finally, inspect the control-plane evidence:

```bash
facility outcomes --project <project-id> --state all
facility spend --project <project-id> --group-by agent
facility analytics overview --project <project-id>
facility audit verify
facility inbox --state open
```

Provider calls must be attributed to the run and project, receipts must bind
the engine, checks, commit, and terminal status, and the audit chain must remain
valid. Recurring evidence may create a draft learning proposal, but it must not
silently rewrite a contract, skill, rule, or guard. When the agent identifies a
candidate, verify that the run created an `open` inbox item bound to the learning
run; proposal prose only in the final response is not submission. The learning
key intentionally lacks `kb:write`: its human-gated proposal is the durable
conclusion, while approval owns the mutation. The improvement loop is complete
only when a human reviews the evidence, approves the proposal, and the new
immutable registry version passes its canary before activation.

The nightly packet uses a rolling 30-day window but is also deterministically
bounded before it reaches the model. It must never recursively embed an older
learning packet. When a high-volume collection is sampled, the packet records
the retained and total record counts in `evidenceWarnings`; silent truncation is
not acceptable.

Projects created through the API receive a valid default knowledge space before
their harness-backed agents are enabled. The nightly learning scheduler also
idempotently provisions that space for older projects before dispatch. Learning
runs may read that context, but they intentionally do not checkpoint directly
to it: an `open`, run-bound proposal is their durable conclusion and keeps the
mutation behind human approval.

The runner injects `harness/` recovery notes and managed skill packages into the
sandbox clone. It also requires the agent to maintain the task-specific
`.agent-sdlc/progress.md` checklist. These exact control-plane files are excluded
from delivery diffs; otherwise a read-only review or learning run would be
reported as having changed product code. The checklist is still read and
published by Facility, and ordinary repository files remain subject to the
no-change guard.

## Acceptance record

Capture these results with the deployment release record:

| capability | required evidence |
|---|---|
| control plane | doctor has no in-scope `FAIL`; any headless-only exceptions recorded; audit chain valid |
| GitHub ingress | signed installation and issue deliveries return `2xx` |
| kickstart | governed PR merged; fingerprint verification `ok` |
| routing | one slash command creates one owned run, never two lanes |
| architect | agent-authored task checklist updates in place; final plan and GitHub approve/feedback commands visible; issue context present; no repository changes; Gate 1 opened |
| builder | GitHub approval binds the displayed plan; separate task-specific live checklist; provision and checks pass; PR opened |
| Gate 2 | review/receipt checks visible; human merge |
| operational agents | review, repair boundary, and read-only sweep observed |
| skills | published scoped skill appears in a subsequent sandbox only |
| cost and evidence | attributed provider request, receipt, outcome, analytics |
| improvement | agent checklist, run-bound open proposals, clean product diff, human approval and canary |

Keep the repository and environment until the acceptance record is reviewed.
Delete them afterward according to your organization's retention policy.
