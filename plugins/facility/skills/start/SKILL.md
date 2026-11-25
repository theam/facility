---
name: start
description: Start a task in Facility. Finds or creates the GitHub issue, opens the Facility story linked to it and launches the project's planning agent. Use when someone says "start this task in Facility", "send this ticket to the architect", "plan this in Facility", or hands over a ticket, chat thread or GitHub issue to begin. Not for reviewing or approving plans (facility:review-plan) or following progress (facility:watch).
---

# Start a Facility story

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

- [start-story.md](../../references/start-story.md): the workflow. Authoritative.
- [operating-rules.md](../../references/operating-rules.md): the Facility model,
  discovery, GitHub access, idempotency and how to report.

## Host notes

- The `facility_*` tools come from the Facility MCP server. If they are missing,
  say so, link the setup guide
  (https://theam.github.io/facility/guides/client-plugin) and stop.
- GitHub: use a GitHub connector or MCP server if one is connected and answers;
  otherwise `gh`.
- Reply in the person's language; keep Facility content (issues, messages to
  agents) in the repository's language.
