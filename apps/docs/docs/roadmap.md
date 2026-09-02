---
title: Roadmap
---

# Roadmap

Facility 0.12 replaces short-lived governed runs with persistent story workspaces. The proposal is
in progress and assigned to the maintainer leading the release.

The release includes:

- persistent story conversations, worktrees, volumes, and native engine sessions;
- Claude Code and Codex adapters with model selection in `.agents/`;
- manual, GitHub, and scheduled agents on one dispatcher;
- full development environments with Docker, Compose, browser testing, and authenticated previews;
- direct Git and GitHub maintainer workflows;
- a thirteen-tool MCP server embedded in the control plane; and
- a retained web UI over the same domain operations.

The 0.12 database is a clean boundary. Existing 0.11 databases are rejected without modification.
There is no in-place history migration in this release.
