# Watch a Facility story

Outcome: the person stops checking Facility by hand and hears about each state
change that needs them, once. Read
[operating-rules.md](operating-rules.md) first.

## What one check reads (read-only, cheap first)

1. `facility_get_story_workflow` → `plan.status` / revision / decision,
   `queuedAgents`, `blockedReason`, `acceptance.status`.
2. `facility_list_attention` (`q` = story title, `status: open`) →
   `agent_waiting`, `turn_error`, `runtime_error` and the action each accepts.
3. `facility_list_backlog` (`q` = issue number) → `phase`, `activity.state`,
   `activity.agentName`, `pullRequest`.
4. Only once PRs exist: `facility_get_delivery` (PR set, CI, reviews) and
   `facility_get_preview_convergence` (preview state and URL).

"What is the agent doing right now?" The MCP has no run-activity tool yet. Point
the person to the run activity section of the story page in Facility, which shows
the agent's progress messages and tool use while it works. `facility_get_story`
holds the raw events but is very large; use it only to diagnose.

Optional cheap signal outside MCP: poll the GitHub issue's comments or linked PRs
with `gh` from a background shell loop; agents often comment there when done.

## Events worth telling the person

| Event | Tell them | Offer |
| --- | --- | --- |
| Plan ready (revision > 0, or planning agent finished) | Plan is ready | `facility:review-plan` |
| `agent_waiting` | The agent's question, quoted | Draft an answer for them to confirm |
| `turn_error` / `runtime_error` | What failed and where (setup vs work) | Diagnose or retry (ask first) |
| Implementation agent started | Building has started | Keep watching |
| PR opened / CI red / CI green | Links and status | Inspect failures |
| Implementation agent finished, delivery not declared (`scope_incomplete`) | PRs, deviations from the plan, known failures | Declare the delivery with `facility_set_delivery` (ask first): all PRs the agents opened, `declaredComplete: true`, the parent/integration PR as primary in multi-repo projects. This starts the preview |
| Preview ready | Preview link | Try it; request acceptance |
| Acceptance required | What is being accepted | `facility_request_delivery_acceptance` link (ask first) |
| Merge order (multi-repo) | Merge the parent/integration PR first; a child PR carrying "Closes #…" closes the issue and the story | Check which PR carries the closing keyword |
| Story done (issue closed) | Summary and links | If `facility_get_story_completion` says `request_completion`, request it (ask first), then stop watching |

Report transitions only; stay silent when nothing changed.

An agent's turn ends when it replies. If it says it is "watching CI", nobody is:
keep watching the PR checks yourself until they finish.

## Host adapters (use what the host supports, never invent background work)

- **Claude Code:** `/loop 3m <check prompt>` or the session's scheduling tools;
  stop the loop when the story is done or waits on the person.
- **Claude Cowork:** a scheduled task with the same check prompt.
- **Codex:** a thread automation or heartbeat with the same check prompt.
- **No scheduler:** check at safe points while working with the person and tell
  them to ask "how is it going?". Do not promise unattended monitoring.

Interval: every 2–3 minutes while an agent is running; stop when the story needs
the person, finishes or fails. A scheduled task marked active is not proof it
ran: verify its first real execution.

## Card format

```
<story title> — <event>
<one line: what happened> · <link>
Next: <what you propose> (1. Do it  2. Not now)
```
