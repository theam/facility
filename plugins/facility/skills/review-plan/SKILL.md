---
name: review-plan
description: Review a Facility story's plan with a person and carry their decision through Facility. Reads the plan, checks it against the issue, presents a one-screen decision card and, on a yes, requests the approval link that releases the implementation agent. Use when the planning agent has finished, or when someone asks "what does the plan say?", "should I approve it?", "approve the plan" or "ask for changes". Not for starting stories (facility:start).
---

# Review and decide a Facility plan

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

- [review-plan.md](../../references/review-plan.md): the workflow. Authoritative.
- [operating-rules.md](../../references/operating-rules.md): the Facility model,
  discovery, GitHub access, idempotency and how to report.

## Host notes

- The `facility_*` tools come from the Facility MCP server. If they are missing,
  say so, link the setup guide
  (https://theam.github.io/facility/guides/client-plugin) and stop.
- After giving the approval link, poll for the decision with the host's
  scheduler, as described in `facility:watch`.
- Reply in the person's language; keep Facility content (issues, messages to
  agents) in the repository's language.
