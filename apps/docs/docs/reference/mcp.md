---
title: MCP
---

# MCP

Facility serves Streamable HTTP MCP at `POST /mcp` from the control API. OAuth clients discover its
resource metadata at `/.well-known/oauth-protected-resource/mcp`. API keys use the same endpoint
with `Authorization: Bearer <key>`.

The server exposes exactly thirteen task-oriented tools:

| Tool | Result |
|---|---|
| `facility_list_projects` | Projects visible to the principal. |
| `facility_list_agents` | Valid `.agents/` catalog with engines, models, and triggers. |
| `facility_list_stories` | Stories, optionally filtered by status. |
| `facility_get_story` | Story, workspace, turns, artifacts, and attention state. |
| `facility_start_story` | Idempotently create or resume a story and queue its first message. |
| `facility_send_message` | Append a message and queue the selected agent. |
| `facility_get_conversation` | Read the shared ordered conversation. |
| `facility_get_environment` | Read runtime, services, readiness, endpoints, and recent events. |
| `facility_open_preview` | Wake and issue a short-lived authenticated preview handoff. |
| `facility_suspend_story` | Stop compute while preserving durable state. |
| `facility_archive_story` | Archive and suspend without deleting. |
| `facility_restore_story` | Restore the archived story and its existing state. |
| `facility_delete_workspace` | Explicitly destroy compute, volume, worktree, and engine sessions. |

Mutations execute directly after normal authentication and project authorization. They do not
create an internal approval object. Delete requires `confirm: true` and a matching idempotency key.
