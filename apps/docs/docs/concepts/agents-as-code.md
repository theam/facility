---
title: Agents as code
---

# Agents as code

Facility reads every agent from `.agents/*.md` in the primary repository. Frontmatter is strict:
unknown fields fail validation, names match filenames, engines are `claude_code` or `codex`, models
are explicit, and at least one trigger is required.

The Markdown body is the agent prompt. The frontmatter is execution configuration. Keeping both in
one reviewed file makes a model change, schedule change, or prompt change visible in Git history.

Discovery uses the primary repository's optional project `developmentBranch`, with the connected
GitHub default as fallback. The same source supplies skills and `.facility.yml`, new story bases,
and configuration PR bases. See the [development source contract](../reference/project-manifest.md#development-source).
Changing this setting does not replace queued/running turns' captured agent manifests or move
existing story branches.

Supported triggers are:

- `manual`, used by trusted internal or direct API dispatch;
- `mcp`, used by the embedded MCP server;
- `ui`, used by the web application;
- `github`, with an event, optional action list, and optional labels; and
- `schedule`, with a named cron expression and IANA timezone.

An agent runs only when its manifest is enabled and declares the matching trigger type. MCP and UI
still call the same story service and dispatcher; the distinct values make the activation source
reviewable without creating separate orchestration paths.

`permissions`, `sandbox`, and `tools` are invalid fields. Facility has one access policy for every
agent: full access to the story workspace and GitHub App installation capabilities for all project
repositories.

This uniform policy also applies to `pr-reviewer`, `ci-doctor`, `security-audit`, and custom agents.
Use the prompt to constrain their task and GitHub branch protection to constrain merge. Do not
assume a read-oriented agent has read-only credentials.

The catalog is loaded from a specific Git commit and cached with content hashes. A turn snapshots
the parsed manifest, so later repository edits do not rewrite execution history.

Refreshes check repository access and the current branch commit. Concurrent reads of the same
commit reuse a complete snapshot scoped to that project, repository, and GitHub installation.
Only agent manifests and `SKILL.md` files are downloaded. A failed or incomplete refresh preserves
the last valid catalog; successfully reading a commit that removes definitions removes them from
the catalog.

The default kickstart catalog includes `architect`, `builder`, `pr-reviewer`,
`ci-doctor`, and `security-audit`. They are ordinary manifests rather than built-in runtime roles.
You can edit, disable, or replace them and add more `.md` files using the same schema.

For a human decision, an agent can include an [author decision brief](../reference/decision-brief.md)
with its complete plan. The shared format supports summary, comparison and diagram views without
another model call. It works with any configured role; the brief grants no execution authority.

## Automatic delivery review

Install or configure `pr-reviewer` in the project's canonical catalog. The automatic cycle is off
until a project and repository configuration writer confirms a workflow policy in Settings.
Choose the Builder and Reviewer, require plan approval for that Builder, hold after failure, and
require human delivery acceptance. The story's approved plan must select both exact manifests and
all connected repositories.

### When a cycle starts

Register the complete set of required PRs in the story delivery panel. A cycle starts only when a
turn of the configured Builder ends its response with the published heads of exactly that
registered set:

```text
<facility-delivery-heads>
[{"repository":"example/app","number":10,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
</facility-delivery-heads>
```

Other Builder turns, such as answers or partial work, leave the story as it is. Facility compares
the declaration against GitHub and the retained primary checkout, pins each PR's base and head,
waits for exact-head CI and uses the exact preview generation when the project requires it. A
project can also require named checks and a PR label. Facility reads GitHub before taking the
story lock and retries outages, timeouts and rate limits until the cycle deadline; missing or
invalid evidence stops the cycle for a person.

### The read-only Reviewer

The Reviewer runs like the Builder, as a native turn in the story workspace, with a fresh
context for each review. It explores the code beyond the diff: it reads the checkouts, runs
`git diff`, `git log` and `gh pr view`, and follows consumers, tests and security boundaries.
Reading is enforced in layers:

- **The engine.** Claude Code receives reading tools only; every other tool, including edits and
  other commands, is denied. Codex runs in its read-only sandbox.
- **Credentials.** The turn receives a GitHub token limited to read permissions and none of the
  project's other secrets; it keeps only its engine credentials.
- **The workspace.** Facility records each checkout's HEAD, branch and status before the turn. If
  anything changed afterwards, it restores the checkout and stops the cycle for a person.

The Reviewer ends its final response with one `<facility-review>` block that accounts for the
plan's acceptance criteria and lists findings with priority, location, evidence, impact and fix.
Facility then leaves the report on each required pull request as a comment review of the exact
reviewed head. It never approves or requests changes, so it cannot satisfy or block branch
protection. The story's review panel links to each published review, or says why GitHub
refused it.

### Correction and decision

A result with only suggestions goes to human review. P0 and P1 findings block, and P2 findings
block when they demonstrate an acceptance, correctness, security or data defect. Blockers within
the approved plan start a single correction in the original Builder session, which updates the
same PRs with fast-forward pushes. A second review then verifies the new candidate, the earlier
findings and regressions. The cycle stops for a person on a finding outside the approved plan,
missing evidence, failed work, changed heads, bases or authorization, a change by the Reviewer,
or blockers that persist after the second review. Dismissing that stop releases messages the
cycle held. A fresh cycle needs a new approved plan decision and a new human Builder turn.

The cycle runs at most two reviews and one correction within its time limit, which covers
waiting for CI and every cycle turn. It has no budget of its own: each of its turns counts
against the project budget and its per-turn limit like any other agent turn. Acceptance stays unavailable, in the story,
Attention and the backlog, while the cycle's Builder or Reviewer is working. The story workflow
panel and `facility_get_story_workflow` show the same phase, rounds, reports and pending decision.

### Pull requests outside Facility

With the cycle on, the cycle reviews the pull requests of Facility stories and their Builder
corrects them; Facility does not also run the Reviewer's GitHub trigger on them. Pull requests
opened by people or other tools keep the Reviewer's GitHub review, which is left on the pull
request and has no Builder to correct it. Without the cycle, the Reviewer's GitHub triggers work
as before.

### Migrate an existing catalog

`facility init` and kickstart install five standard manifests in new repositories, including
`pr-reviewer` with GitHub triggers for opened and updated pull requests. `facility doctor`
reports an existing `.agents/address-review.md`. In a reviewed repository change, move its
review-thread instructions to the existing Builder, preserve its PRs, and remove the manifest. For
existing feedback, send the current PR and review threads to the Builder in the same story.
Check GitHub workflows separately, so that a GitHub Action does not review the same story pull
requests a second time.

## Installed skills

Facility inventories valid project skills found at `.agents/skills/**/SKILL.md` and
`.claude/skills/**/SKILL.md`. Each skill needs YAML frontmatter with a non-empty `name` and
`description`; other frontmatter belongs to the client that consumes the skill and is left intact.
The skill body and supporting files remain in the repository.

Use the Agents page, `GET /v1/projects/:projectId/project-skills`, or the
`facility_list_skills` MCP tool to inspect the installed name, description, path, source location,
content hash, and repository commit. Facility does not install, distribute, resolve, or upgrade a
separate catalog. It projects repository state so operators and MCP clients can see the capabilities
available to a project.

A malformed optional skill is omitted from the inventory and does not make executable agents
unavailable. Agent manifests remain strict because they control dispatch.

Facility can propose an agent change from the UI or API. It writes the manifest on a branch and
opens a pull request against the primary repository. The catalog changes only after the repository
contains the new commit. Concurrent edits use the expected commit SHA to avoid silently
overwriting a newer manifest.

See the [agent manifest reference](../reference/agent-manifest.md) for the full schema and examples.
