# Facility client plugin

Skills that let Claude Code, Claude Cowork and Codex operate Facility stories
through the Facility MCP server. Ask your agent to **"start this task in
Facility"** and it finds or creates the GitHub issue, opens the Facility story,
launches the project's planning agent, brings the plan back to you for a
decision, and follows the build until the pull requests and the preview are
ready. People stay at the two gates: **plan approval** and **delivery
acceptance**.

| Skill | Say something like | What it does |
| --- | --- | --- |
| `facility:start` | "Start this ticket in Facility" | Issue (creates it if missing) → story → planning agent |
| `facility:review-plan` | "What does the plan say? Should I approve it?" | One-screen decision card → approval link or feedback to the agent |
| `facility:watch` | "Let me know when the PR is ready" | Polls Facility and reports only what needs you |
| `facility:attention` | "What's waiting on me in Facility?" | Prioritized list across projects |

The workflows live in [`references/`](references/) and are shared by every
skill. Start with [operating-rules.md](references/operating-rules.md).

## Install

- Individual setup: [Work from Claude Code or Codex](../../apps/docs/docs/guides/client-plugin.md).
- Organization rollout, pinned to the Facility version your instance runs:
  [Distribute the client plugin](../../apps/docs/docs/self-host/client-plugin.md).

## Layout contract

This directory holds only skills and references. It has no
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` or `.mcp.json` on
purpose: the catalog entry that installs the plugin is its manifest and
declares the MCP server URL of one Facility instance. Claude Code and Codex
take MCP servers from the entry only when the plugin ships no manifest of its
own, so adding one here would silently drop every organization's MCP
connection. `guards/client-plugin.mjs` enforces this.
