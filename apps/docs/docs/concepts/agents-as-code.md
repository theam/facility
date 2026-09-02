---
title: Agents as code
---

# Agents as code

Facility reads every agent from `.agents/*.md` in the primary repository. Frontmatter is strict:
unknown fields fail validation, names match filenames, engines are `claude_code` or `codex`, models
are explicit, and at least one trigger is required.

Supported triggers are:

- `manual`, used by MCP and the UI;
- `github`, with an event, optional action list, and optional labels; and
- `schedule`, with a named cron expression and IANA timezone.

`permissions`, `sandbox`, and `tools` are invalid fields. Facility has one access policy for every
agent: full access to the story workspace and GitHub App installation capabilities for all project
repositories.

The catalog is loaded from a specific Git commit and cached with content hashes. A turn snapshots
the parsed manifest, so later repository edits do not rewrite execution history.
