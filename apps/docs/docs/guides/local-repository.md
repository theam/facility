---
title: Local repositories
---

# Work on a local repository

Facility can run stories against a Git repository on the machine that runs Facility. No GitHub
account, App, installation, hosted remote, or webhook is involved. Agents work in persistent local
Docker workspaces, you review and revise their commits in Facility, and you import the approved
result into your own repository.

Model calls still go to the cloud provider configured for the project's Claude Code or Codex
engine, and they can include code and prompts. Repositories, workspaces, conversations, and review
stay on your machine.

An operator must enable local repositories first; see [Local mode](../self-host/local-mode.md).

## What Facility imports

Facility imports **committed history from the default branch only**. Uncommitted edits and
untracked files in your checkout are never copied. Facility never writes to your repository: it
reads committed objects into its own staging copy and packages them as a Git bundle for the
workspace. Repository hooks, `core.fsmonitor`, and system or global Git configuration are ignored
while it reads.

Submodules and Git LFS content are not imported yet. Registration and each import report them
explicitly; submodule directories appear empty and LFS files appear as pointer files.

## 1. Register the repository

The repository needs at least one commit and must be inside a directory the operator approved.

From the UI, choose **New project → Use a Git repository on this machine**, then enter a project
name and the repository's absolute path on the Facility host. With the CLI and an API key that has
`repos:write`:

```bash
export FACILITY_API_KEY=fak_...
facility repos add-local ~/code/shop --project=proj_... --alias=shop
```

The CLI lists the uncommitted and untracked paths that will stay behind before it registers
anything. The alias names the repository in `.facility.yml` as `local:<alias>`, so machine paths
never appear in committed configuration. A project uses either GitHub repositories or local
repositories, never both, and one organization owns a given host path.

## 2. Add the starter configuration

Facility proposes starter configuration as a patch rather than a pull request. The UI shows the
patch after registration; the API returns it from
`POST /v1/projects/:projectId/repos/:repoId/local-kickstart`. You can also write the files
directly:

```bash
facility init --local=shop --start="pnpm dev"
```

Both produce `.facility.yml` with `primary: local:shop` and three agents (`architect`, `builder`,
and `reviewer`) that commit to the story branch and never push, open pull requests, or run `gh`.
Review the files, then commit them on the default branch. Facility reads only committed
configuration.

Add `environment.checks` to run named checks against a story's exact commit during review:

```yaml
environment:
  start: pnpm dev
  checks:
    test: pnpm test
    lint: pnpm lint
```

## 3. Run a story

Start a story from the UI, MCP, or API as usual. On the first turn Facility resolves the default
branch once, reads `.facility.yml` and the agent catalog at that commit, imports the same commit
into the workspace, and creates the story branch from it. The turn's events record the commit and
configuration hash.

Later turns keep the workspace's history and uncommitted work. Facility never resets a story
branch when your checkout changes.

## 4. Review, revise, and approve

Open **Review and export** on the story page. It shows the commits and files since the imported
source, uncommitted changes, check results for the current head, and the approval state. Opening
it wakes a suspended workspace only for people who can run workspaces.

- **Request changes** records your note and opens the composer so you can ask an agent for the
  revision.
- **Run checks** runs every configured check and attaches the results to the tested commit.
- **Approve** records approval of the exact head commit. Uncommitted changes are unfinished work
  and must be committed first. Any later commit makes the approval stale.

## 5. Export and import

**Export approved commits** packages the approved commit range as a Git bundle and a patch. Download
the bundle next to your repository and import it into a new branch:

```bash
git fetch ./sexp_....bundle "refs/heads/facility/<story>:refs/heads/facility-review/<story>-<id>"
git log --oneline main..facility-review/<story>-<id>
git merge facility-review/<story>-<id>
```

Each export imports to its own branch name, so repeating an export never overwrites an earlier
import, and your working tree and default branch are untouched until you merge. Resolve any merge
conflicts as usual. You can instead apply the patch with `git am`.

Facility records the review and the export, not a merge. The workspace stays available, so you
can keep revising the story and export again.

## Pick up changes from your repository

When your default branch moves on, choose **Refresh source from repository**. Facility imports the
new commit as the workspace's source base and records the new revision. The story branch is not
moved. The workspace's copy of the default branch only fast-forwards when it has not diverged, so
an agent can rebase or merge deliberately.

## Limits of the first release

- Facility never runs directly in your checkout and never merges into it.
- Local repositories need the Docker workspace driver.
- Submodules and Git LFS content are reported, not imported.
- Pull requests, issue synchronization, GitHub triggers, and CI mirroring do not apply to local
  projects. Manual, UI, MCP, and scheduled starts work.
