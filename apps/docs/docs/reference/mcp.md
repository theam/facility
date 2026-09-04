---
title: MCP
---

# MCP

Facility serves Streamable HTTP MCP at `POST /mcp` from the control API. OAuth clients discover its
resource metadata at `/.well-known/oauth-protected-resource/mcp`. API keys use the same endpoint
with `Authorization: Bearer <key>`.

The server exposes twenty task-oriented tools:

| Tool | Result |
|---|---|
| `facility_list_projects` | Projects visible to the principal. |
| `facility_list_agents` | Valid `.agents/` catalog with engines, models, and triggers. |
| `facility_list_skills` | Valid skills installed in `.agents/skills/` or `.claude/skills/`. |
| `facility_list_stories` | Stories, optionally filtered by status. |
| `facility_get_story` | Story, workspace, turns, artifacts, attention, and ordered evidence timeline. |
| `facility_start_story` | Idempotently create or resume a story and queue its first message. |
| `facility_send_message` | Append a message and queue the selected agent. |
| `facility_get_conversation` | Read the shared ordered conversation. |
| `facility_get_environment` | Read runtime, services, readiness, endpoints, and recent events. |
| `facility_open_preview` | Wake and issue a short-lived authenticated preview handoff. |
| `facility_suspend_story` | Stop compute while preserving durable state. |
| `facility_archive_story` | Archive and suspend without deleting. |
| `facility_restore_story` | Restore the archived story and its existing state. |
| `facility_delete_workspace` | Explicitly destroy compute, volume, worktree, and engine sessions. |
| `facility_get_costs` | Read measured token use and cost by turn for a selected period. |
| `facility_get_budget` | Read the current monthly budget and amount spent. |
| `facility_set_budget` | Enable, change, or disable the project's monthly budget. |
| `facility_get_observability` | Read project health, usage, workspace, GitHub, and audit summaries. |
| `facility_get_pipeline` | Read mirrored issues, pull requests, CI state, and story stage. |
| `facility_sync_github` | Reconcile the project's GitHub mirror immediately. |

## Connect Claude Code or Codex

Register the same Streamable HTTP endpoint in either client. Replace the example origin with the
Facility deployment:

```bash
claude mcp add --transport http facility https://facility.example.com/mcp

codex mcp add facility --url https://facility.example.com/mcp
codex mcp login facility
```

Claude Code starts its OAuth flow when the server is first used. Codex can also read a service API
key from an environment variable:

```bash
codex mcp add facility \
  --url https://facility.example.com/mcp \
  --bearer-token-env-var FACILITY_API_KEY
```

## Complete story flow

Claude Code, Codex, and any other MCP client send the same tool calls. Start or resume an issue-backed
story:

```json
{
  "name": "facility_start_story",
  "arguments": {
    "projectId": "proj_example",
    "provider": "github",
    "externalId": "issue:272",
    "title": "Persistent story workspaces",
    "agent": "builder",
    "message": "Implement the accepted story and verify it in its development environment.",
    "idempotencyKey": "issue-272-initial"
  }
}
```

Continue the same conversation, optionally choosing another repository-defined agent:

```json
{
  "name": "facility_send_message",
  "arguments": {
    "projectId": "proj_example",
    "storyId": "story_example",
    "agent": "pr-reviewer",
    "message": "Review the current branch and run the relevant checks.",
    "idempotencyKey": "issue-272-review-1"
  }
}
```

Open the running application, suspend compute, and later restore the same workspace:

```json
{"name":"facility_open_preview","arguments":{"projectId":"proj_example","storyId":"story_example","service":"app"}}
{"name":"facility_suspend_story","arguments":{"projectId":"proj_example","storyId":"story_example"}}
{"name":"facility_restore_story","arguments":{"projectId":"proj_example","storyId":"story_example"}}
```

Deletion is deliberately separate and permanent:

```json
{
  "name": "facility_delete_workspace",
  "arguments": {
    "projectId": "proj_example",
    "storyId": "story_example",
    "confirm": true,
    "idempotencyKey": "issue-272-delete-after-export"
  }
}
```

`facility_get_conversation` uses `after` and `limit` as a stable message-sequence cursor.
`facility_get_environment` uses the same fields for ordered workspace events and returns
`next_cursor` and `has_more`. Story and environment responses include typed attention, available
next operations, active-compute status, retained-storage status, provider usage, and an explicit
marker when monetary cost is unavailable.

`facility_list_skills` is an inventory operation. It does not install or upgrade skills. A story's
`timeline` combines Facility turn events, Git snapshots, artifacts, attention, and mirrored GitHub
branches, pull requests, reviews, and checks. `occurred_at` is the source event time and
`observed_at` is when Facility stored it; they can differ after reconciliation.

Mutations execute directly after normal authentication and project authorization. They do not
create an internal approval object. Delete requires `confirm: true` and a matching idempotency key.

When a budget is enabled, Facility checks it before starting a provider call. Usage and cost are
recorded after the call from provider-reported values when available, otherwise from the built-in
model price book. A call already running may cross the limit; subsequent turns are blocked. Models
without a known price are rejected while budget enforcement is enabled.
