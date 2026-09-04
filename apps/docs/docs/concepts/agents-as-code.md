---
title: Agents as code
---

# Agents as code

Facility reads every agent from `.agents/*.md` in the primary repository. Frontmatter is strict:
unknown fields fail validation, names match filenames, engines are `claude_code` or `codex`, models
are explicit, and at least one trigger is required.

The Markdown body is the agent prompt. The frontmatter is execution configuration. Keeping both in
one reviewed file makes a model change, schedule change, or prompt change visible in Git history.

Supported triggers are:

- `manual`, used by trusted internal or direct API dispatch;
- `mcp`, used by the embedded MCP server;
- `ui`, used by the web application;
- `github`, with an event, optional action list, and optional labels; and
- `schedule`, with a named cron expression and IANA timezone.

An agent runs only when its manifest is enabled and declares the matching trigger type. MCP and UI
still call the same story service and dispatcher; the distinct values make the activation source
reviewable without creating separate orchestration paths.

`permissions`, `sandbox`, and `tools` are invalid fields. Facility has one access policy for every
agent: full access to the story workspace and GitHub App installation capabilities for all project
repositories.

This uniform policy also applies to `pr-reviewer`, `ci-doctor`, `security-audit`, and custom agents.
Use the prompt to constrain their task and GitHub branch protection to constrain merge. Do not
assume a read-oriented agent has read-only credentials.

The catalog is loaded from a specific Git commit and cached with content hashes. A turn snapshots
the parsed manifest, so later repository edits do not rewrite execution history.

The default kickstart catalog includes `architect`, `builder`, `pr-reviewer`, `address-review`,
`ci-doctor`, and `security-audit`. They are ordinary manifests rather than built-in runtime roles.
You can edit, disable, or replace them and add more `.md` files using the same schema.

Facility can propose an agent change from the UI or API. It writes the manifest on a branch and
opens a pull request against the primary repository. The catalog changes only after the repository
contains the new commit. Concurrent edits use the expected commit SHA to avoid silently
overwriting a newer manifest.

See the [agent manifest reference](../reference/agent-manifest.md) for the full schema and examples.
