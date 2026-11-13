# Start a Facility story

Outcome: **one GitHub issue ↔ one Facility story ↔ the planning agent running**,
and the person knows what happens next. Read
[operating-rules.md](operating-rules.md) first.

## 1. Understand the task

- Read the source completely: the ticket in the team's issue tracker, a chat thread,
  a GitHub issue or the person's description.
- Extract the problem, objective, acceptance criteria, technical notes and
  dependencies. If the acceptance criteria are missing or vague, say so and ask
  whether to continue: the plan will only be as good as the issue.

## 2. Find the Facility project, agents and policy

- `facility_list_projects` → the project that owns the code.
- `facility_list_agents` and `facility_get_workflow_policy` → the planning agent
  (not held by `planApprovalAgents`) and which agents wait for plan approval.
- If no agent looks like a planner, ask the person which agent to start.

## 3. Look for existing work (no duplicates)

- `facility_list_backlog` with `q` = issue number or key words, `phase: ["all"]`.
  If the issue already has a story, do **not** start another one: report it and
  offer to continue it (`facility_send_message`) or to watch it.
- Search GitHub for an equivalent open issue in the candidate repository.

## 4. Choose the repository

Where the change mainly lives, if that repository belongs to the project
(`facets.repositories` in the backlog). If the work spans several repositories,
use the project's primary repository. If unsure, ask.

## 5. Confirm once, then act

Show a short card and wait for an explicit yes:

> I'll create **"<title>"** in **<owner/repo>** (labels: <existing labels>) from
> <source>, then start **<planning agent>** in Facility project **<project>**.
> The plan comes back to you for approval before anything is built. OK?

## 6. Create the issue (if it does not exist)

- GitHub access in the order of the operating rules: connector → `gh` → ask the
  person. With `gh`: `gh issue create -R <owner/repo> --title … --label … --body-file …`.
- Body: copy the source faithfully (context, objective, acceptance criteria as a
  checklist, technical notes, dependencies), in the repository's language, and
  end with a link to the source ticket. Use only labels that already exist
  (`gh label list`). No secrets or unnecessary personal data.
- Check the issue is mirrored: `facility_list_backlog` with `q` = its number.
  Only if it is still missing after about a minute, call `facility_sync_github`.

## 7. Start the story

`facility_start_story` with:

- `projectId`, `provider: "github"`, `externalId: "issue:<number>"`,
  `repositoryId` (from the backlog facets), explicit `title` (the issue title),
  explicit `agent` (the planning agent) and
  `idempotencyKey: "start-<owner>-<repo>-issue-<n>-<agent>"`.
- `message`, in the repository's language:
  - the issue link and that it is the source of truth for scope;
  - what the plan must contain: where the relevant code is (files and symbols),
    the recommended approach and discarded alternatives, impact on existing
    configuration or data and the migration path, the expected PRs per
    repository, and the tests;
  - where to save the plan if the agent's convention would be ambiguous (for
    example, an issue from a child repository);
  - "Plan only. A person will review and approve the plan before implementation."
  - the person's own constraints, quoted.

## 8. Confirm it is running

- `facility_get_story_workflow`: plan `none` and no `blockedReason`.
- `facility_list_backlog` (`q` = issue number): `activity.state` running or queued.
- `facility_list_attention` (`q` = title): no `turn_error` or `runtime_error`.
  If the run failed during setup, say so plainly; do not present an environment
  failure as a plan. Offer a retry or diagnosis.

## 9. Report and hand over

One short card:

- Issue: link · Story: title (Facility project) · Agent: name, state.
- What happens next: the planning agent reads the code and writes a plan; it
  usually takes several minutes.
- Offer to watch it and to bring back the plan for a decision (`facility:watch`,
  then `facility:review-plan`).
- Optionally offer to add the issue link to the source ticket (a write: ask).
