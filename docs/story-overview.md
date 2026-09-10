# Reading a story

The story overview separates three states:

- **Agent activity:** a running or queued turn. An unfinished task does not imply that an agent is executing.
- **Task phase:** ready, in progress, attention, review, done or archived. This persists between agent runs.
- **Environment:** the provider's current inspection. The previously recorded workspace state is available under Environment details, but does not override the current inspection. Unavailable inspection is shown as unavailable.

The header links to the pull request, latest conversation, message composer, environment and agent run history. Messages are newest first by conversation sequence. Long messages expand in place. GitHub-triggered messages show the human comment or event subject and a source link; the original agent prompt stays under technical details. This is a presentation projection, not a rewrite of the stored transcript or the agent's instructions. Truncated legacy events retain their original text in details.

Only open attention items appear above the conversation. Resolved and dismissed notices remain in a collapsed history. Dismissing a notice does not erase its evidence.

Preview and browser verification are everyday environment actions. Suspend, archive and clean setup are grouped under maintenance. Suspend is offered when inspection reports running compute. Permanent deletion keeps its existing explicit confirmation.

A suspended Vercel machine does not accrue CPU or memory usage, but retained snapshots can incur storage charges. A running machine can accrue memory charges even when no agent is working. Facility does not infer a zero bill from missing provider cost data; consult [Vercel pricing](https://vercel.com/docs/sandbox/pricing) for current rates.

The presentation helpers in `apps/web/lib/story-presentation.ts` keep state interpretation, event formatting and ordering independent of React. Unit tests cover those decisions; the story page integration test covers their combined rendering, collapsed history and read-only permissions.
