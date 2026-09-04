---
title: Roadmap
---

# Roadmap

Facility is a self-hosted AI SDLC system for reviewable delivery with humans, gates, and evidence
in one place.

## Current focus

Facility is building a dependable issue-to-pull-request loop around:

- persistent story conversations, worktrees, volumes, and native engine sessions;
- Claude Code and Codex adapters with model selection in `.agents/`;
- manual, MCP, UI, GitHub, and scheduled agents on one dispatcher;
- full development environments with Docker, Compose, browser testing, and authenticated previews;
- direct Git and GitHub maintainer workflows;
- cost accounting and monthly budget enforcement without a separate model gateway;
- operational observability, audit history, and product usage summaries;
- a webhook-backed GitHub issue, pull request, and CI mirror with a delivery pipeline;
- an MCP server embedded in the control plane;
- a web UI over the same domain operations; and
- a compact AWS reference control plane whose story workspaces remain on Vercel.

## Planned direction

Facility will continue iterating towards stronger human governance, reusable organizational
configuration and upgrades, richer delivery evidence, deeper cost and outcome analysis, and
additional execution and deployment options where they improve the AI SDLC.

Future work should earn its place on top of the persistent story lifecycle. New policy or
orchestration layers should remain reviewable, share state across MCP and the UI, and preserve the
normal GitHub delivery boundary.
