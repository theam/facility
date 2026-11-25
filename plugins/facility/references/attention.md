# What needs my attention in Facility

Outcome: one screen that tells the person what to do next and why, with each
item one step away. Read
[operating-rules.md](operating-rules.md) first.

## Gather (read-only)

1. `facility_list_projects` → the projects the person works on (ask once if
   unclear; remember their answer in the conversation).
2. Per project:
   - `facility_list_attention` (`status: open`) → waiting agents, failed or
     interrupted runs, each with the action it accepts.
   - `facility_list_backlog` (`phase: ["attention", "review"]`, `assignee: ["me"]`
     first, then unassigned) → stories blocked or in review.
   - For stories in review: `facility_get_story_workflow` → plans waiting for a
     decision and deliveries waiting for acceptance.
   - Optionally `facility_list_backlog` (`phase: ["not_started"]`, sorted by
     priority) → mirrored issues nobody has started.

## Prioritise

1. Things only this person can unblock: plan decisions, acceptance, agent
   questions addressed to them.
2. Failures that stop an agent (`turn_error`, `runtime_error`).
3. Reviews and PRs waiting.
4. Not-started issues (a short list, not the backlog).

## Present (one screen, person's language)

```
Facility — <date>
1. <story> · <what is waiting> · <why it matters> → <proposed action>
2. …
Not started (top 3): <issue> · <issue> · <issue>
```

Recommend the first action. Offer the matching skill: `facility:review-plan`,
`facility:watch`, or `facility:start` for a not-started issue. Take no action without
the person's choice.
