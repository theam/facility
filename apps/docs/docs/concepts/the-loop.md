---
title: The loop
---

# The loop

One change, end to end. This is the SDLC Facility installs and governs —
the same loop shown at [sdlc.theagilemonkeys.com](https://sdlc.theagilemonkeys.com).

1. **Signal and intake.** Work begins as feedback, telemetry, a meeting, or
   an alert. The signal becomes a shaped issue with a named human owner.
2. **Board.** A human prioritizes the issue. Work moves forward only on
   explicit human action; agents do not choose what the team should build.
3. **Planning.** `/architect` plans against reality: it reads the code and
   runs real commands in a provisioned environment. Planning happens in the
   issue thread, where it can be challenged cheaply.
4. **Human gate 1.** An engineer accepts the plan. In the repo lane, invoking
   `/builder` is the acceptance. In the platform lane, approving the plan in
   Facility dispatches the linked builder run.
5. **Build.** `/builder` implements end to end in one run: code, tests,
   checks, push, PR. One-shot delivery is deliberate: an agent allowed to
   ship "foundation + plan" will ship it every time.
6. **Preview.** Every PR must have a live, isolated environment where a
   person can try the change quickly. Today, connect your deployment provider's
   per-PR previews and put the URL and status on the PR. Facility does not yet
   provision these environments itself; [native previews are on the roadmap](../roadmap#native-preview-environments).
7. **Defense in depth.** A contract the agent cannot override, specialist
   reviewers, deterministic guards, and the full build — machines test.
8. **Human gate 2.** A person validates the preview, reviews the pull request,
   and squash-merges it in GitHub. Gate 2 is not a Facility inbox approval:
   branch protection and GitHub review remain the shipping boundary.
9. **Production.** The accepted commit reaches the protected default branch
   and follows the project's deployment process.
10. **Self-observation and closure.** Every run leaves a receipt (tokens, cost,
   duration, and actual check outcomes). Facility joins the linked issue to its
   human squash-merge outcome, health checks daily, and flies a synthetic
   canary through the whole path weekly. Recurring failures become
   new guards — **the ratchet**: the guard set only grows.

## Two execution lanes

Facility runs this loop in two ways, per project and per trigger:

- **Repo lane** — the vendored GitHub workflows installed by kickstart run
  the agents in your CI, exactly as `facility init` always did. Zero platform
  dependency at execution time.
- **Platform lane** — the platform runs the agent in its own sandbox: same
  contracts, same gates, plus live session streaming, steering, and
  platform-enforced budgets.

Migrating a repo is not a rewrite — it's flipping lanes one trigger at a
time, with the fallback always intact.
