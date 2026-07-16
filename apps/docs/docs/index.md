---
slug: /
title: What Facility is
---

# Facility

**The platform that governs your AI SDLC.** Agents carry every change from
signal to production; people decide what ships; every run leaves a receipt.
Facility is the control plane that makes that operable for an organization —
not one repo at a time, but as a governed system.

## The problem it closes

Wiring an AI agent into a repository is the easy part. The second month is
where it breaks: keys and budgets sprawl across repo secrets, upgrades mean
re-vendoring files everywhere, the knowledge (skills, standards, guards)
forks silently per repo, humans have no single place where their decisions
are requested, and the run data that would tell you whether any of it works
evaporates. The method is proven — Facility's SDLC has run The Agile Monkeys'
own products in production since August 2025. What was missing is the
platform.

## What it owns

Execution stays where it belongs: GitHub repos, CI, isolated sandboxes.
Facility owns what must be centralized to govern:

| concern | what the platform does |
|---|---|
| **identity** | WorkOS SSO for humans, scoped API keys for machines, one RBAC for web, CLI, MCP, and agents |
| **projects** | kickstart a repo into a working factory in minutes; fingerprint managed files; upgrade with a PR, never a surprise |
| **money** | every model call goes through the gateway: project keys, hard budgets, cost by model, agent, and task |
| **execution** | agents run in disposable sandboxes; sessions stream live; a stuck agent can be steered by a human; connect per-PR preview deployments today, with native Facility previews [planned](roadmap#native-preview-environments) |
| **knowledge** | skills, rules, contracts, harnesses, guards — versioned, bundled, immutable once published |
| **humans** | one inbox for Facility decisions such as plan gates, learning validations, and budget overrides; GitHub review and squash merge remain Gate 2 |
| **observation** | receipts, outcomes, health, the canary — live numbers straight from the pipeline, stored by default |

## The two gates, still human

Facility never moves accountability. Agents cannot approve, cannot merge,
cannot push to protected branches. A person accepts the plan; a person validates
the live preview, reviews the pull request, and signs the merge. The platform
makes those decisions cheap to exercise — it never makes them optional.

## Where to go next

- [The loop](concepts/the-loop) — how a change travels the factory.
- [Self-host quickstart](self-host/quickstart) — up in one compose file.
- [Kickstart a project](guides/kickstart) — greenfield or an existing repo.
- [Roadmap](roadmap) — what is available now and what is planned.
- [The tam-os migration](guides/tam-os) — the first production tenant.
