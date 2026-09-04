---
title: Agent manifest
---

# `.agents/*.md` reference

Every Markdown file directly under `.agents/` defines one agent. YAML frontmatter configures
execution and the non-empty Markdown body is the prompt. Facility loads all `.md` files as one
catalog at an exact commit of the primary repository.

## Complete example

```markdown
---
name: ci-doctor
description: Diagnoses and repairs failing checks on the current story pull request.
engine: codex
model: gpt-5.6-sol
options:
  reasoning_effort: high
enabled: true
triggers:
  - type: manual
  - type: mcp
  - type: ui
  - type: github
    name: failed-workflow
    event: workflow_run
    actions: [completed]
  - type: schedule
    name: daily-ci-check
    cron: "0 8 * * 1-5"
    timezone: Europe/Madrid
---

# CI doctor

Inspect the current pull request, reproduce its failing checks in the story workspace, make the
smallest justified repair, and leave the branch ready for review. Do not merge the pull request.
```

The file must be named `.agents/ci-doctor.md`. Newlines are normalized and the canonical source is
hashed with SHA-256. A turn stores that hash, the source commit, engine, model, options, and trigger.

## Frontmatter

| Field | Required | Contract |
| --- | --- | --- |
| `name` | Yes | Lowercase kebab case, 1–64 characters, and identical to the filename without `.md`. |
| `description` | Yes | 1–240 characters for human and client discovery. |
| `engine` | Yes | `claude_code` or `codex`. |
| `model` | Yes | Explicit engine model name, 1–160 characters. |
| `options` | No | Strict engine options object; defaults to `{}`. |
| `enabled` | No | Boolean; defaults to `true`. |
| `triggers` | Yes | Non-empty array of supported trigger objects. |

Unknown fields are invalid. In particular, `permissions`, `sandbox`, `tools`, and `max_turns` are
not part of the manifest. Every agent receives the same full workspace, shell, network, Docker,
browser, Git, and configured GitHub repository capability.

## Options

`options.reasoning_effort` is optional and accepts `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, or `ultra`. The selected engine and model must support the value; the schema cannot
verify a provider's current model catalog.

## Interactive triggers

Interactive triggers contain only `type`:

```yaml
triggers:
  - type: manual
  - type: mcp
  - type: ui
```

- `manual` is used by direct trusted dispatch.
- `mcp` permits MCP clients to select the agent.
- `ui` permits the web UI to select the agent.

Declaring one does not imply the others. A request from an undeclared surface is rejected.

## GitHub triggers

```yaml
- type: github
  name: review-requested
  event: pull_request
  actions: [review_requested, synchronize]
  labels: [agent-review]
```

`name` is a lowercase kebab-case identity for deduplication and history. `event` accepts:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `check_suite`
- `workflow_run`

`actions` is an optional non-empty string array that filters the GitHub payload action. `labels` is
an optional non-empty string array that filters labeled work. Each string is bounded by the schema.
Only events subscribed on the GitHub App can reach these triggers.

### Author gate

Event text is passed to an agent that holds maintainer credentials for the project repositories.
`authors` decides whose text may start a turn. It accepts GitHub's `author_association` values
(`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`,
`MANNEQUIN`, `NONE`) as a non-empty array, or the word `any` to accept every account:

```yaml
- type: github
  name: community-question
  event: issue_comment
  actions: [created]
  authors: [OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR]
```

When `authors` is omitted the trigger fires only for `OWNER`, `MEMBER`, and `COLLABORATOR`. A
payload without an `author_association` field is treated as `NONE`. The gate reads the association
of the account whose text enters the prompt: the issue author for `issues`, the commenter for
`issue_comment`, the pull request author for `pull_request`, and the reviewer for
`pull_request_review`.

Two cases are not gated because no untrusted account can produce them:

- `check_suite` and `workflow_run` deliveries describe CI state and carry no author association.
- The `assigned`, `labeled`, and `milestoned` actions require triage permission on the repository,
  so a maintainer has already vouched for the item whoever opened it. The kickstart `builder`
  trigger on `issues: [assigned]` therefore keeps working for community-opened issues.

A skipped delivery is not an error. The worker logs the delivery id, event, action, agent, trigger,
sender, and association at `warn` level without the event text, and the webhook is still recorded
and mirrored.

Facility 0.12.x introduced this default. A public repository that relied on any account starting a
reviewer or triage agent must now say so with `authors: any` or an explicit list; private
repositories where every account is a member or collaborator are unaffected. This is a dispatch
filter, not a permission profile: once a turn starts, every agent still receives the same full
workspace and GitHub capability.

Duplicate webhook deliveries do not create duplicate turns. Check and workflow events are attached
to the matching pull request only when their head SHA is current.

## Schedule triggers

```yaml
- type: schedule
  name: weekly-security-audit
  cron: "0 9 * * 1"
  timezone: Europe/Madrid
```

`name` is the stable schedule identity. `cron` must parse as a cron expression and may contain up to
128 characters. `timezone` must be accepted as an IANA timezone and defaults to `UTC`.

The worker scans schedules every minute. Concurrent workers claim one activation, and repeated
runs continue one stable story for that project, agent, and schedule trigger. Disabling the agent
stops future activation without deleting its existing story.

## Prompt body

The body must contain non-whitespace Markdown. It should define the role, working contract,
completion criteria, evidence expected, and constraints such as never merging. Prompts can guide
behavior but cannot reduce credentials. Use repository rules and Facility authorization for
structural enforcement.

The default catalog provides `architect`, `builder`, `pr-reviewer`, `address-review`, `ci-doctor`,
and `security-audit`. They are starter manifests, not reserved names. Custom agents use this same
contract.

## Catalog updates

Facility reads the complete catalog from the primary repository. A parse error in any manifest can
make the catalog unavailable, so validate changes before merge. The UI/API agent-edit operation
requires an expected 40-character commit SHA, creates a branch and commit, and opens a pull request
rather than writing the default branch.

A queued or running turn keeps its manifest snapshot. Later catalog commits affect later turns and
do not alter previous execution history.
