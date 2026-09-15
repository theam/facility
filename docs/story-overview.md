# Reading a story

The story overview separates three states:

- **Agent activity:** a running or queued turn. An unfinished task does not imply that an agent is executing.
- **Task phase:** ready, in progress, attention, review, done or archived. This persists between agent runs.
- **Environment:** the provider's current inspection. The previously recorded workspace state is available under Environment details, but does not override the current inspection. Unavailable inspection is shown as unavailable.

The header also lists the people working on the story (those who started or continued it from
Facility) and notes when the title is still being generated or was taken from the request.

The header carries the actions a reader takes most: send a task (the composer opens in place, or opens pre-addressed to an agent that asked a question), open a running service, reach the pull request and recorded results, and cancel an active run. Workspace maintenance (suspend, archive, restore, clean setup) and permanent deletion sit behind a separate menu so they never compete with everyday work. Opening the page starts no agent and wakes no machine; every action is an explicit click with the same permissions and confirmations as before.

The conversation is shown as exchanges: each request with the run it produced and that run's final response. A request shows the person's name and avatar (initials when there is no image), or the GitHub login, schedule, or API client that sent it, and the agent it addressed. A response shows that it comes from an agent, the agent's name, the engine (Claude Code or Codex) and the model the run recorded — never the agent's current configuration. Running, queued, failed, canceled, and waiting-for-reply runs say so instead of showing a result.

Messages arrive newest first in server pages of ten (`GET …/conversation?order=desc&limit=10`, cursor `before`). When a page boundary would separate a response from its request, the request rides along as `related` context and is merged by id, so a run is never shown half. Older pages append below without moving what is on screen; new exchanges that arrive while the reader is further down are announced rather than inserted. Long messages expand in place without rendering the text twice. GitHub-triggered messages show the human comment or event subject and a source link; the original agent prompt stays under technical details. This is a presentation projection, not a rewrite of the stored transcript or the agent's instructions.

Agent responses recorded after this change store only the engine's final response as the message body (Claude Code's `result`, Codex's last `agent_message`); intermediate agent messages, tool use, commands and reasoning summaries stay as turn events and are read through **Run details**, which fetches `GET …/turns/:turnId/activity` (pages of ten, text bounded, noise such as `item.updated` skipped) only when opened. A single stored event is fetched on its own (`GET …/turns/:turnId/events/:seq`) when the reader asks for the full payload. Older agent messages that predate the separation are labelled as a combined transcript and shown as stored; Facility does not reconstruct a final response from them.

Activity timeline (`GET …/timeline`, keyset pages of ten with agent events summarized) and environment logs are folded and fetched only when opened. The page requests the story bundle with `evidence=none`, so the bounded turn events and composed timeline are not downloaded on open; API and MCP clients keep the default bundle shape.

Only open attention items appear above the conversation. Resolved and dismissed notices remain in a collapsed history. Dismissing a notice does not erase its evidence.

Preview and browser verification are everyday environment actions. Suspend, archive and clean setup are grouped under maintenance. Suspend is offered when inspection reports running compute. Permanent deletion keeps its existing explicit confirmation.

A suspended Vercel machine does not accrue CPU or memory usage, but retained snapshots can incur storage charges. A running machine can accrue memory charges even when no agent is working. Facility does not infer a zero bill from missing provider cost data; consult [Vercel pricing](https://vercel.com/docs/sandbox/pricing) for current rates.

The presentation helpers in `apps/web/lib/story-presentation.ts` keep state interpretation, exchange grouping, run status wording and ordering independent of React; `services/api/src/turns/activity.ts` projects stored engine events into bounded, readable activity. Unit tests cover those decisions; the story page integration test covers their combined rendering, collapsed history and read-only permissions; `apps/web/test/story-conversation.test.tsx` covers paging, merging, live updates and lazy run details; `services/api/test/story-reading-routes.integration.test.ts` covers the reading endpoints, their bounds, permissions and tenant isolation.

# Reading the backlog

The Stories page is the project backlog. `services/api/src/stories/backlog.ts` merges mirrored
GitHub issues, stories and open pull requests into one item per unit of work and
`services/api/src/stories/phase.ts` derives the work phase with a fixed precedence: deleted or
archived, delivered (merged pull request, completed story, closed issue), a live turn, open
attention (Facility items, failing checks, requested changes), review (open non-draft pull request),
progress, and finally not started. The phase never inspects a workspace provider, so listing the
backlog cannot wake compute. Agent activity (`running`, `queued`, `idle`) and the recorded workspace
state travel alongside the phase instead of being folded into it.

`apps/web/lib/backlog-presentation.ts` turns those values into words, the activity line, the URL
parameters that hold every filter, and the agent choices offered by the composer. Unit tests cover
the derivation and the presentation; the page integration test covers grouping, links, permissions,
pagination, and the empty and error states.
