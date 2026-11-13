---
name: watch
description: Watch a Facility story and tell the person only when something needs them — plan ready, agent waiting for a reply, run failed, PR opened, preview ready, delivery waiting for acceptance. Facility's MCP has no push notifications, so this skill sets up polling with the host's scheduler. Use for "let me know when the plan is ready", "tell me when the PR is open", "how is the story going?". Not for deciding plans (facility:review-plan).
---

# Watch a Facility story

## Human gates

These bind every run. Every skill in this plugin carries this exact block, and
[operating-rules.md](../../references/operating-rules.md) explains why; a
repository guard keeps the copies identical.

1. **Confirm writes and runs.** Ask before creating an issue, starting or
   messaging an agent, registering a plan, declaring a delivery or requesting
   completion. One confirmation may cover a short sequence you state.
2. **Never decide for a person.** Plan approval and delivery acceptance are a
   person's click in Facility: request the link, never click it, never report
   it as done until Facility shows it. Never merge pull requests.
3. **The project's agents do the work.** Do not implement the change locally
   instead of the story's agents.

## Read first

- [watch-story.md](../../references/watch-story.md): the workflow and the
  scheduler for each host. Authoritative.
- [operating-rules.md](../../references/operating-rules.md): the Facility model,
  discovery, GitHub access, idempotency and how to report.

## Host notes

- The `facility_*` tools come from the Facility MCP server. If they are missing,
  say so, link the setup guide
  (https://theam.github.io/facility/guides/client-plugin) and stop.
- Claude Code: `/loop 3m <check prompt>` or the session's scheduling tools.
  Claude Cowork: a scheduled task. Codex: a thread automation. Stop when the
  story needs the person, finishes or fails.
- Reply in the person's language; keep Facility content (issues, messages to
  agents) in the repository's language.
