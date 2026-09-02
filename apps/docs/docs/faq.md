---
title: FAQ
---

# Frequently asked questions

## Is a workspace deleted after merge?

No. Merge marks the story done and may suspend compute. The worktree, volume, conversation, and
Claude or Codex session files remain. Only `facility_delete_workspace` or the corresponding UI
control destroys them.

## Are agents sandboxed differently by role?

No. Every agent receives the same full workspace and GitHub installation access. Role-specific
restraint belongs in its prompt. Tenant and project isolation still apply.

## Where are agents configured?

Only in `.agents/*.md`. Each manifest contains the name, engine, model, options, triggers, and
prompt. The database stores a cache tied to the source commit, not an editable second definition.

## Do scheduled agents still exist?

Yes. A schedule in an agent manifest creates or resumes a stable scheduled story. GitHub events and
manual requests use the same dispatcher.

## Is a preview another deployment?

No. Facility authenticates a short-lived session and proxies the declared port from the live
workspace, including WebSockets.

## Can I upgrade a 0.11 database?

Not in place. Back it up and start 0.12 with an empty database. See [the upgrade boundary](reference/upgrade-012.md).
