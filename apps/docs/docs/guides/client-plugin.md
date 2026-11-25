---
title: Work from Claude Code or Codex
---

# Work from Claude Code or Codex

The Facility client plugin lets Claude Code, Claude Cowork and Codex run a story for you: create
or find the GitHub issue, start the project's planning agent, bring the plan back for your decision
and follow the build until the pull requests and the preview are ready. It adds four skills on top
of the [Facility MCP server](../reference/mcp.md) and calls only the documented MCP tools, with
your own Facility identity.

| Skill | Say something like | Result |
| --- | --- | --- |
| `facility:start` | "Start issue #123 in Facility" | Issue → story → planning agent running |
| `facility:review-plan` | "What does the plan say? Should I approve it?" | One-screen decision card and, on your yes, an approval link |
| `facility:watch` | "Tell me when the pull request is ready" | Polling that reports only what needs you |
| `facility:attention` | "What's waiting on me in Facility?" | A prioritized list across your projects |

The skills answer in the language you write in and keep issues and agent messages in the
repository's language.

## Prerequisites

- A Facility account with access to the project. Reads need project read access; starting stories,
  messaging agents, registering plans and declaring deliveries need the write permissions listed in
  the [MCP reference](../reference/mcp.md).
- Your instance's MCP endpoint, `<PUBLIC_URL>/mcp`, for example `https://facility.example.com/mcp`.
  Ask your Facility operator if you do not know it.
- GitHub access to create issues: a GitHub connector or MCP server, or the `gh` CLI signed in.
  Without either, the agent drafts the issue for you to create.

## Install from your organization's catalog

If your organization publishes a plugin catalog, use it. It pins the skills to the Facility version
your instance runs and already contains the MCP endpoint. Replace the example names with yours:

```bash
claude plugin marketplace add example-org/example-tools
claude plugin install facility@example-tools
```

```bash
codex plugin marketplace add example-org/example-tools
codex plugin add facility@example-tools
```

Operators set up that catalog with [Distribute the client plugin](../self-host/client-plugin.md).

## Install from the Facility repository

The Facility repository publishes the same plugin in catalogs that follow `main`. Sparse checkout
avoids cloning the whole monorepo.

### Claude Code

```bash
claude plugin marketplace add theam/facility --sparse .claude-plugin plugins/facility
claude plugin install facility@facility --config mcp_url=https://facility.example.com/mcp
```

The plugin declares the MCP server with the URL you pass as `mcp_url`. Installing without
`--config` leaves the option unset and Claude Code warns about it; set it from `/plugin`. If you
already registered the same URL with `claude mcp add`, Claude Code keeps your registration and does
not load the plugin's duplicate.

### Codex

Codex plugins cannot take the MCP URL as an install option, so register the server separately:

```bash
codex plugin marketplace add theam/facility --sparse .agents/plugins --sparse plugins/facility
codex plugin add facility@facility
codex mcp add facility --url https://facility.example.com/mcp
```

### Claude Cowork

Cowork uses the plugins your Claude organization provides. Ask your organization owner to add the
catalog, as described in [Distribute the client plugin](../self-host/client-plugin.md).

## Sign in

The first time the agent calls a Facility tool, you sign in to Facility in the browser with OAuth.
In Claude Code, `/mcp` shows the server as needing authentication until then and starts the flow.
In Codex, run:

```bash
codex mcp login facility
```

Ask "What's waiting on me in Facility?" to confirm the connection. The answer lists your projects
and anything waiting on you.

## Run a story

1. **Start.** "Start this ticket in Facility" with a link or pasted text. The agent finds the
   project, checks that the issue has no story yet, and shows what it will create and which agent
   it will start. Nothing is written until you confirm.
2. **Watch.** "Tell me when the plan is ready." The agent polls with the host's scheduler:
   `/loop` in Claude Code, a scheduled task in Cowork, a thread automation in Codex. Without a
   scheduler, ask "how is it going?" when you want an update.
3. **Decide the plan.** The agent checks the plan against the issue and shows a decision card. On
   your yes it requests an approval link. You confirm in Facility; the agent never approves for
   you and reports the decision only after Facility records it.
4. **Follow the build.** The agent reports pull requests, CI results and the preview. When the
   implementation agent finishes, it offers to declare the delivery pull request set, which starts
   the preview.
5. **Accept.** If the project requires delivery acceptance, the agent requests an acceptance link
   for you to confirm in Facility. It never merges pull requests.

## Behavior and limits

- Every write is confirmed with you first: creating issues, starting or messaging agents,
  registering plans, declaring deliveries and requesting completion.
- Plan approval and delivery acceptance stay interactive confirmations in Facility. The MCP tools
  only return expiring links, as described in the [MCP reference](../reference/mcp.md).
- Watching consumes model usage in your Claude or Codex session on every check. It does not add
  Facility provider usage; agent turns it observes are measured as usual.
- Some steps the plugin performs, such as registering a plan from the planning agent's output or
  declaring the delivery pull request set, are not yet performed by Facility itself. The plugin's
  [operating rules](https://github.com/theam/facility/blob/main/plugins/facility/references/operating-rules.md)
  list them.

## Update

```bash
claude plugin marketplace update facility
claude plugin update facility@facility
```

```bash
codex plugin marketplace upgrade facility
codex plugin add facility@facility
```

The Facility catalogs follow `main`, so the skills can expect MCP tools that an older instance does
not serve yet. An organization catalog pinned to your instance's version avoids that mismatch.

## Troubleshooting

- **The agent says the Facility tools are missing.** In Claude Code, open `/mcp` and authenticate
  the Facility server; check that `mcp_url` ends in `/mcp`. In Codex, run `codex mcp list` and
  `codex mcp login facility`.
- **Sign-in fails after it previously worked.** See
  [OAuth scopes and renewal recovery](../self-host/authentication.md#mcp-interactive-oauth).
- **An approval link expired.** Ask the agent for a new one, or approve from the story's plan page
  in Facility.
