---
title: Roadmap
---

# Roadmap

Facility remains a self-hosted AI SDLC system for reviewable delivery with humans, gates, and
evidence in one place. Persistent story workspaces change its execution foundation, not that
direction.

## 0.12: consolidate the execution core

Facility 0.12 replaces short-lived governed runs with persistent story workspaces. The proposal is
in progress and assigned to the maintainer leading the release. This release deliberately removes
components that were not stable enough and keeps the smallest architecture that can run the full
issue-to-pull-request loop durably.

The release includes:

- persistent story conversations, worktrees, volumes, and native engine sessions;
- Claude Code and Codex adapters with model selection in `.agents/`;
- manual, MCP, UI, GitHub, and scheduled agents on one dispatcher;
- full development environments with Docker, Compose, browser testing, and authenticated previews;
- direct Git and GitHub maintainer workflows;
- cost accounting and monthly budget enforcement without a separate model gateway;
- operational observability, audit history, and product usage summaries;
- a webhook-backed GitHub issue, pull request, and CI mirror with a delivery pipeline;
- a nineteen-tool MCP server embedded in the control plane;
- a retained web UI over the same domain operations; and
- a compact AWS reference control plane whose story workspaces remain on Vercel.

The 0.12 database is a clean boundary. Existing 0.11 databases are rejected without modification.
There is no in-place history migration in this release.

## Beyond 0.12

Architectural removal in 0.12 does not make the removed product outcomes irrelevant. Facility will
continue iterating towards stronger human governance, reusable organizational configuration and
upgrades, richer delivery evidence, deeper cost and outcome analysis, and additional execution and
deployment options where they improve the AI SDLC.

Future work should earn its place on top of the persistent story lifecycle. New policy or
orchestration layers should remain reviewable, share state across MCP and the UI, preserve the
normal GitHub delivery boundary, and avoid recreating services that the core control plane can own
directly.
