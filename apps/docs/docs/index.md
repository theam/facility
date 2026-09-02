---
title: Facility
slug: /
---

# Continue a story in a real workspace

Facility gives Claude Code and Codex a persistent place to do software work. Start a GitHub issue
or an ad hoc story from MCP or the web UI. Facility creates one shared conversation, one worktree,
and one complete development environment, then keeps them until you explicitly delete them.

The repository defines its environment in `.facility.yml` and every agent in `.agents/*.md`.
Architects, builders, reviewers, CI repair agents, and scheduled security audits use the same
manifest format, dispatcher, workspace, GitHub access, and conversation.

Facility trusts these agents as repository maintainers. They can use shell, network, Docker,
browser tools, branches, commits, pushes, and pull requests. GitHub review, CI, and branch
protection decide what merges.

Start with the [quickstart](self-host/quickstart.md), [kickstart a repository](guides/kickstart.md),
then run the [end-to-end validation](guides/validate-workspace-loop.md).
