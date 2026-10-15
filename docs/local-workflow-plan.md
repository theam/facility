# Local workflow implementation plan

Status: implemented for the first release. User guide:
`apps/docs/docs/guides/local-repository.md`; operator guide: `apps/docs/docs/self-host/local-mode.md`.

## Implementation notes

- **Source identity.** `project_repositories.source` is `github` or `local`; local rows use the
  `_local` owner sentinel, an alias, and a canonical `source_path`
  (`packages/db/migrations/v0.12/0009_local_repository_sources.sql`). GitHub uniqueness applies
  only to GitHub rows. A project never mixes sources, and one organization owns a host path.
- **Host access.** `services/api/src/repositories/local.ts` validates approved roots
  (`FACILITY_LOCAL_REPOSITORY_ROOTS`), ownership, symlinks, worktree Git directories, repository
  roots, and empty repositories, and re-validates the stored path on every use. Git runs read-only
  with system/global config, hooks, fsmonitor, and replace objects disabled; snapshots are copied
  through a Facility-owned staging repository.
- **Configuration and turns.** `services/api/src/repositories/sources.ts` selects GitHub or local
  readers for `.facility.yml`, agents, skills, and repository access. `.facility.yml` accepts
  `local:<alias>` and `environment.checks`. The manifest's commit is imported into the workspace,
  recorded in `workspaces.source_revisions` and a `turn.source` event, and never re-fetched
  implicitly. Local turns receive no GitHub credential.
- **Review and export.** `services/api/src/repositories/local-review.ts` and
  `/v1/projects/:projectId/workspace-stories/:storyId/local-review` provide review state, checks,
  exact-commit approval, change requests, explicit source refresh, and bundle/patch exports
  (`story_exports`). The story page shows them in place of a pull request.
- **Onboarding.** `facility repos add-local`, `facility init --local`, a UI setup page, and a local
  kickstart patch. The API binds `localhost` by default, Compose publishes on loopback, and the
  development login now requires a loopback peer and loopback host.
- **Deferred.** Uploading a CLI-created bundle instead of mounting source roots into containers;
  importing submodules and Git LFS content (reported explicitly for now); the manual smoke check
  with a configured cloud engine, which needs live model credentials.

## Outcome and scope

A user can register a Git repository on their machine, create a story,
run an agent in a persistent local Docker workspace, inspect changes and previews,
request revisions, and bring the approved result back into their repository.
No GitHub account, App, installation, hosted repository, or webhook is required.

Confirmed scope: cloud AI inference is permitted while keeping repositories,
execution, conversation history, and review on the user's machine.
Cloud inference can transmit code and prompts to the model provider.
Use the existing Claude Code and Codex engines with configured provider credentials.
Fully offline inference and local model hosting are outside this plan.
Internet access for model calls, dependency installation, and image downloads is permitted;
the workflow must not depend on GitHub services or a hosted repository.

## Existing foundation and constraints

- Docker workspaces already persist data in named volumes and support suspend/resume:
  `services/api/src/workspaces/docker.ts` and `runtime.ts`.
- Manual stories, conversations, and turn Git evidence already exist:
  `services/api/src/stories/service.ts` and `turns/dispatcher.ts`.
- Repository registration requires an App installation:
  `services/api/src/routes/v1/projects.ts`.
- Agent catalogs and project manifests are loaded through GitHub:
  `services/api/src/agents/catalog.ts`, `workspaces/project-environment.ts`,
  and their construction in `story-domain.ts`.
- Dispatch always requests GitHub workspace credentials before preparing a workspace:
  `services/api/src/turns/dispatcher.ts` and `github/workspace-credentials.ts`.
- `.facility.yml` repository validation and clone URLs assume GitHub:
  `services/api/src/workspaces/project-environment.ts`.
- Agent manifests and engine interfaces currently enumerate Claude Code and Codex:
  `packages/agents/src/index.ts` and `services/api/src/turns/engines.ts`.

## Design decisions

Keep repository source, workspace runtime, model execution, and delivery integration separate.
A local repository should use the existing Docker runtime without requiring GitHub credentials.
GitHub remains an optional repository and delivery integration.

Use Facility-managed Git copies inside workspace volumes.
Import committed history through a controlled Git bundle/snapshot transfer.
Do not mount the user's working checkout writable into agent containers.
Export completed work as a Git bundle and patch, with instructions to import a new review branch.
The initial milestone leaves merging into the user's working branch as an explicit user action.

Local paths refer to the machine running Facility, not the browser's filesystem.
Register paths through an authenticated local CLI or a UI backed by explicitly configured roots.
If the API runs in a container, configure narrow source mounts or use CLI bundle upload.
Committed content is the initial import contract; uncommitted and untracked files are excluded
and this is shown before import.

## Implementation sequence

### 1. Add repository source identity and local registration

Add a source discriminator (`github` or `local`) and provider-specific metadata.
Retain GitHub owner/name/installation constraints for GitHub records.
Local records use a stable ID, display name, default branch, and registered source reference.
Update uniqueness constraints so local paths do not masquerade as GitHub owner/name pairs.
Migrate existing records to `github` without changing their behavior.

Provide local registration and validation through API, CLI, SDK, and UI.
Require a Git repository with an initial commit; explain empty repositories clearly.
Resolve canonical paths under approved roots, check ownership and authorization,
and reject traversal, symlink escapes, and cross-project source access.
Do not execute repository hooks or setup commands during registration.

Deliverable: a local project can be registered with GitHub configuration absent.

### 2. Load configuration from a pinned local commit

Introduce a small repository source interface for resolving revisions,
reading files at a commit, and preparing a repository snapshot.
Adapt the current GitHub readers and add local Git readers.
Use it for `.facility.yml`, agent manifests, skills, and initial project setup.
Resolve the commit once and record it with configuration hashes and turn evidence.

Evolve `.facility.yml` to refer to registered repository aliases for local sources;
keep existing GitHub syntax compatible and keep machine-specific paths out of the manifest.
Generate starter agents and configuration as a reviewable local patch instead of a kickstart PR.
Local templates must describe local review/export and avoid mandatory `gh` commands.

Deliverable: local agents and environment configuration load without any GitHub API calls.

### 3. Complete one local agent turn

Replace the dispatcher's unconditional GitHub credential dependency with repository preparation
that supplies source-specific transport and optional credentials.
Keep model credentials separate from repository credentials.
Local preparation imports the pinned snapshot into the existing Docker volume,
sets a local Git author identity, and creates the story branch.
Preserve the current setup, preview, session resumption, and Git evidence behavior.

Subsequent turns keep existing workspace changes.
Refreshing from the source repository is explicit and records the new revision;
never reset a story branch automatically when the host checkout changes.
Handle related repositories through the same import contract;
report unsupported submodules or Git LFS content explicitly until supported.

Deliverable: register a local repository, start a manual story, execute an agent,
and inspect its diff without a GitHub App or hosted remote.

### 4. Provide local review and return changes

Expose local changes, commits, test/check results, and review actions in the story view.
Record approval against the exact reviewed commit; later changes invalidate approval.
Treat uncommitted changes as unfinished work requiring a commit before approval/export.
Export the approved history as a bundle plus a patch and import instructions.
Record review and export separately from merge: export alone does not mean the work was merged.
Preserve workspaces after completion and allow revisions and repeat exports.

Run configured local checks in the workspace and attach results to the tested commit.
Disable GitHub reconciliation, triggers, issue synchronization, and PR requirements
for local sources, including overview/attention calculations and scheduled jobs.
Keep manual, UI, MCP, and applicable scheduled starts available.
Show local review actions wherever the current UI assumes a pull request.

Deliverable: a user can review, revise, approve, and import a story's result locally.

### 5. Make local operation a supported setup

Document and automate local onboarding with Docker and PostgreSQL,
no GitHub environment variables, and explicit model-provider configuration.
Audit the existing development login before treating it as supported local authentication.
Default services to loopback; retain authorization and tenant checks for every operation.
Keep remote access a separately configured deployment mode.
Include backup/restore instructions covering the database, workspace volumes,
repository snapshots, and required secret material.

Deliverable: a fresh local installation reaches its first completed story through the UI/CLI.

### 6. Validate and preserve GitHub behavior

Add unit coverage for source selection, manifest compatibility, revision pinning,
path validation, review invalidation, and export behavior.
Add integration coverage using temporary repositories, deterministic agent fakes,
and local services; default CI must not require live credentials or external networking.
Keep real Docker lifecycle checks in the repository's appropriate integration tier.

Required scenarios include registration, configuration loading, turn completion,
resume after restart, concurrent stories, stale source revisions, local checks,
review after new changes, export/import conflicts, and preservation of a dirty host checkout.
Assert that GitHub clients are never invoked for a local source.
Retain regression coverage for existing GitHub projects and repository migrations.

Local filesystem access and authentication changes require both unit and integration tests
under AGENTS.md, including unauthorized and cross-tenant access, malicious paths,
symlink/path replacement attempts, and applicable malformed/revoked/expired credentials.
Include regression tests that fail if local execution again requires GitHub credentials.

## Acceptance boundary

The first release is complete when a fresh local Git repository with no remote can
complete the entire story-to-reviewed-export workflow with no GitHub configuration.
Agent execution uses the existing engines and configured cloud AI credentials.
Cloud model calls retain existing secret handling, usage accounting, and budget enforcement.
Automated acceptance uses deterministic agent fakes without live provider credentials;
a manual smoke check exercises the complete workflow with a configured cloud engine.

Native execution directly in the host checkout, automatic merges into that checkout,
and replacing GitHub with another hosted forge are outside the first release.
They can follow once the isolated local workflow is reliable.
