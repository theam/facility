---
title: Terminal story sessions
---

# Attach to a story from a terminal

The Facility CLI can open the native Claude Code or Codex session in a Docker
story workspace. The conversation and worktree stay in that workspace.

Install the published CLI, then sign in to the instance's **API origin**:

```bash
npm install --global @theagilemonkeys/facility
facility login https://api.facility.example
facility stories --needs-you
facility attach demo#101
```

The instance must have [OAuth configured](../self-host/authentication.md). Login
opens the browser on the same computer and returns through a temporary loopback
listener, protected by state and PKCE S256. API keys cannot open sessions. This
desktop release uses dynamic client registration and the existing `facility:mcp`
resource scope. Device authorization for SSH hosts and a dedicated API scope
are follow-up work.

Upgrade the API, worker and runner together; older runner images do not include
the terminal helpers. Before rolling back the API or worker, end all interactive
sessions. Leave the additive session schema in place when reverting application
code; an older worker does not recognize interactive ownership.

`sessions:observe` permits watching; `sessions:control` permits opening and
taking over. Attaching uses both permissions. Owners and maintainers have both;
the bundled viewer can observe. Roles and active membership are checked again
while a connection is open. A browser WebSocket must come from a configured
Facility origin; terminal clients authenticate with a bearer header.

## Work with the session

```bash
facility attach story_example
facility attach https://api.facility.example/projects/proj_example/stories/story_example
facility new demo "Investigate the failing test"
facility new demo --agent builder
facility new demo --issue 101
facility stories --json
facility preview demo#101 web
```

`project#number` resolves a GitHub issue story in that project. Use the story id
for manual stories, or when a number is ambiguous. Without a story argument,
attach offers stories with open attention. Listings cover projects visible to
the signed-in account. `--instance <api-origin>` selects another saved login.

An initial ask creates a Facility turn, which you watch before entering. Without
an ask, `new` prepares the workspace without sending an automated turn. The
selected agent starts with its manifest instructions and story identity.

Only one turn or person holds a story's session. A running Facility turn is
rendered read-only. A waiting terminal gets the slot before queued messages.
When another person holds it, this release shows their name and start time.
Press **Ctrl+C** while watching to confirm takeover. The old process is stopped
and its appended conversation and usage are imported before another native
process starts. The old holder becomes a watcher. While you hold the session,
Ctrl+C is passed to the native agent. **Ctrl-]** leaves and releases the slot.

The web displays the holder and waiting terminals. Sending while a person holds
the session offers **Send when it ends**, **Take over and send now**, or
**Cancel**. A takeover requires `sessions:control`; ordinary send permission
does not imply terminal control. MCP, GitHub events and schedules queue without
taking over. Cancel, suspend, archive and deletion cannot bypass an interactive
holder; leave or take over first.

Vercel workspaces answer that interactive sessions are **not supported yet** and
retain the read-only view of Facility turns. Live terminal mirroring for another
person, shells, web terminals and file uploads are follow-up work.

## Persistence, accounting and recovery

The native terminal runs inside `dtach` in the runner. A lost client or API
connection leaves the agent alive. Reattach to the same story after restarting
the client. OAuth sockets close at token expiry and the CLI reconnects with
renewed credentials. Concurrent refreshes share a process lock because refresh
tokens rotate. Linux Secret Service is used when available; otherwise the CLI
stores credentials in a `0600` file in `~/.config/facility`. Keep that directory
private and do not commit it.

After 15 minutes with nobody attached, Facility stops the native process,
imports its final journal and frees the slot. Configure the timeout in
`.facility.yml`:

```yaml
sessions:
  detached_timeout_minutes: 15
```

Native messages, steps and cumulative usage are reconciled periodically and
when the session ends. Imports are transactional and idempotent. Native history
already present in the resumed session is omitted from the next Facility
turn's shared-conversation prompt. Budgets are checked before entry and after
imports; exhaustion closes the session. Model changes use each response's recorded
model and appear as `mixed` in a turn's aggregate when necessary. Unknown prices
remain unavailable. A project with unpriced usage cannot admit more budgeted work
in that month, because its remaining allowance cannot be calculated safely.
At a UTC month boundary the session closes for reattachment, so a retained turn
cannot continue spending against the previous budget period.
Entry, watching, takeover and exit are audited with users and durations.

If process shutdown or journal import cannot be confirmed, Facility retains the
occupied slot and raises an attention item instead of allowing another writer.
Restore workspace access and retry reconciliation. Native journals are bounded
to 32 MiB per import in this release. Treat journal files as accounting evidence;
terminal access has the same broad workspace and GitHub maintainer capabilities
as an automated agent turn.

Long-session GitHub credential renewal is not included yet: installation tokens
can expire during a session. Leave and reattach to prepare new credentials.
A local file path pasted into the native terminal refers to the container, and
container `localhost` URLs need `facility preview` to be reachable.

## Herdr

Inside Herdr, Facility reports its title, engine, working/blocked/idle state and
resume command through the installed Herdr binary. Reports use increasing
sequence numbers, bounded background subprocesses and no network service.
Herdr 0.9.2 or later can restore the attach command after a server restart.
Outside a Herdr pane the integration does nothing. Test restore in a disposable
named session, never by restarting a session containing other work.

## Verify an installation

Build the runner with `docker build -f runner/Dockerfile -t facility-runner:dev .`
and start the local source stack with `pnpm dev`. In a disposable story, verify
automated-to-native resume, a correction followed by an automated resume,
takeover from a second terminal and from the web, disconnect/reattach, resize,
permission denial and revocation, imported usage, and budget exhaustion. Check
the conversation and audit after each transition. The contributor acceptance
command is `pnpm verify`; live-provider checks complement its deterministic tests.

See the [CLI reference](../reference/cli.md) and
[workspace lifecycle](../reference/lifecycle.md) for the other operations.
