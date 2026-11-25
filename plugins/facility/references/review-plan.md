# Review and decide a Facility plan

Outcome: the person makes an informed decision in under a minute, and Facility
records it. Read
[operating-rules.md](operating-rules.md) first.

## 1. Find the plan

- Identify the story (from the conversation, or `facility_list_backlog` /
  `facility_list_attention`).
- `facility_get_story_workflow`: `plan.status`, `plan.revision`,
  `plan.decisionRevision`, `queuedAgents`, `blockedReason`.
- If a plan revision exists: `facility_get_plan` (markdown, repositories,
  agents, decision receipts).
- If `plan.status` is `none` but the planning agent has finished, the plan is in
  its output: read `facility_get_conversation` (last agent message), the issue
  comments and the plan file the agent reports. Facility needs a recorded plan
  revision before it can be approved: offer to register the agent's exact text
  with `facility_propose_plan` (`sourceMessageId` of that message, the
  repositories and agents it names, `expectedRevision` = current revision).
  This records metadata only and starts nothing, but it is still a write: ask.
- **Repository scope:** list **every** repository of the project, not only the
  ones the change touches. Facility only lets held agents run when the approved
  plan lists exactly the project's full repository set; a partial list can be
  approved but leaves the agent blocked ("Approve the full current project
  repository scope before granting native project execution"). Take the set
  from the latest approved plan of another story in the project
  (`facility_get_plan`); the backlog facets only show repositories with items.
  The plan's agents must come from the primary repository's `.agents/`.

## 2. Check it yourself before summarising

- Every acceptance criterion of the issue is covered, or explicitly deferred.
- Scope matches the issue; flag additions and omissions.
- Concrete evidence: real files and symbols, executed vs proposed checks.
- Risks, migrations, data or configuration impact, and questions that need a
  human decision.
- Repositories and agents the plan will release, and the expected PRs.

## 3. Decision card (one screen, in the person's language)

```
Plan for <story title> — revision <n>
What will change: <1–3 lines>
Approach: <recommended option> · discarded: <alternatives, 1 line>
Scope: <repos / PRs / main files> · tests: <what proves it>
Needs your decision: <open questions or risks, or "nothing">
Gaps against the issue: <list or "none">
My recommendation: approve | ask for changes — <one-line reason>
Full plan: <link or path>
1. Approve  2. Ask for changes  3. Reject
```

## 4. Carry out the decision

- **Approve:**
  1. If the plan asked questions, send the person's answers, quoted, to the
     implementation agent first (`facility_send_message`, `agent` = that agent).
     The policy holds it in `queuedAgents` until approval, so it starts with the
     answers instead of open questions.
  2. `facility_request_plan_decision` with `intent: "approve"`,
     `expectedRevision` and `expectedDecisionRevision` from the workflow, and
     `idempotencyKey: "plan-<storyId>-r<rev>-approve"`. Give the person the
     returned link, say what the click does (Facility's human gate; the tool
     does not approve) and that it expires in about 15 minutes. If it expires,
     they can also approve from the story's plan page in Facility.
  3. **Do not wait for the person to come back.** Poll
     `facility_get_story_workflow` every minute or two (host scheduler, as in
     `facility:watch`) until the decision is recorded or the link expires. If the
     person says they approved, verify immediately.
- **Ask for changes:** send the person's feedback, quoted, to the planning agent
  with `facility_send_message` (`agent` = planning agent). A new revision will
  follow; review it again.
- **Reject:** `facility_request_plan_decision` with `intent: "reject"` and the
  person's reason, then the link as above.

## 5. Verify after the click

- `facility_get_story_workflow`: the plan shows the decision and held agents
  are running, or `blockedReason` explains why not. "Approved" alone is not
  enough: check that the agent actually left `queuedAgents`.
- If the implementation agent did not start, report it and offer the next
  step; do not start it without the person's OK.
- Then offer to watch the story until the PRs and preview are ready
  (`facility:watch`).
