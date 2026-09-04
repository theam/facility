# Facility open-source roadmap

Facility is an open-source, self-hosted system for running AI coding agents as
part of a reviewable software delivery process. One story owns one workspace,
one worktree, and one shared conversation. Codex, Claude Code, the MCP server,
and the web application operate that same state.

## Definition of done

A capability is complete when public automated tests and a reproducible reference installation
prove its user journey. The reference journey is:

1. A maintainer connects a GitHub repository and opens a kickstart pull
   request containing `.facility.yml` and `.agents/*.md`.
2. Starting a story creates or resumes its durable workspace and story branch.
3. The workspace clones every configured repository, runs setup, starts the
   complete development environment, waits for readiness, and exposes its
   declared services.
4. A repository-defined agent runs with its configured engine and model. All
   agents receive the same full workspace and GitHub maintainer capability.
5. Manual messages, GitHub events, and schedules enter one serialized
   conversation and resume the native Codex or Claude Code session.
6. The agent can commit, push, and open or update a pull request. Facility
   never merges it.
7. A signed-in project member can open an authenticated local preview,
   including WebSocket traffic.
8. Merge, archive, and suspend retain the worktree and native sessions. Only an
   explicit, confirmed delete destroys workspace state.
9. The same lifecycle is usable through MCP and the web UI.

## Product contracts

- `.agents/` is the only agent catalog. Prompts, engines, models, options, and
  manual, scheduled, or GitHub triggers are reviewed as repository code.
- `.facility.yml` is the only environment manifest.
- GitHub App installation tokens are issued with the installation's full
  repository access; Facility does not create per-agent permission profiles.
- Default-branch protection and pull-request review remain the merge boundary.
- The public deployment contract is portable. Provider-specific production
  infrastructure belongs in a deployment repository.
- Incompatible database versions are rejected without modification. Upgrade
  requirements are documented in the versioned upgrade guide.

## Acceptance evidence

The repository keeps deterministic unit and integration tests for catalog
parsing, trigger dispatch, tenant isolation, credential redaction, preview
authentication, session persistence, database refusal, MCP parity, and the
complete story lifecycle. CI also builds the deployable images and runs the
Docker workspace acceptance path.

## Next priorities

- improve workspace recovery, provider portability, and operational diagnosis;
- make delivery evidence and cost outcomes easier to inspect and compare;
- strengthen human review and governance without creating a parallel delivery path;
- improve agent and skill inspection across connected repositories; and
- expand deployment options when they preserve the same story lifecycle and interfaces.
