---
title: Kickstart a project
---

# Kickstart a project

From zero to a working factory:

1. **Create the project** in the web app or through the API. The CLI can list
   and get projects, but it does not create them.
2. **Connect the repo.** Configure and install your GitHub App using the
   [self-hosting guide](../self-host/github-app); it then appears in the
   project's repo picker.
3. **Answer the six questions.** Default branch, provision command, check
   commands, modules, model tier, board (optional). The platform pre-fills
   what it can detect — a Node repo with pnpm and Playwright gets the right
   defaults without typing.
4. **Review the generated assets.** Every file the kickstart will write, with hashes, and the
   conflict report if the repo already has any of them (existing files are
   never overwritten).
5. **Open the PR.** The platform commits the rendered assets to
   `facility/kickstart` and opens a pull request. Manual steps that only you
   can do are in the PR body: create the agent token secret, protect the
   default branch, confirm App permissions, and complete preview configuration.
   Work through the
   [repository settings that back the gates](../reference/security#repository-settings-that-back-the-gates)
   while you are there — several of the human gates are held up by repository
   configuration rather than by Facility.
6. **Configure a live PR preview.** Choose a Facility-owned preview or an
   external deployment adapter. For a native preview, provide an immutable
   image, optional command, internal port, readiness path, and TTL. Add
   `FACILITY_API_URL`, `FACILITY_PROJECT_ID`, and a project-scoped
   `FACILITY_PREVIEW_KEY` to the repo. In production, interactive GitHub/OIDC login must be fully
   configured before Facility accepts preview creation. The private origin is
   never returned to callers.
7. **Merge it.** That's Gate 2 muscle memory from day zero. Validate the live
   preview, review the PR, and squash-merge it in GitHub. On merge the
   fingerprint baseline is recorded and the project reports **system ok**.

Confirm the
[repository settings that back the gates](../reference/security#repository-settings-that-back-the-gates)
are in place before this point: the gates have to exist before the first agent
run, not after the first surprise.

Now open an issue and comment `/architect`. The agent's task-specific checklist
and final plan appear in one comment. Continue entirely from GitHub: comment
`/builder` to approve that plan, or `/architect <feedback>` to request another
planning pass. The builder owns the delivered semantic branch, commit message,
PR title, and PR description; Facility signs and publishes that exact delivery
through the installed GitHub App.

## Choose one execution lane per role

Architect and builder commands can run in repository CI (`repo`) or in a
Facility sandbox (`platform`). Choose exactly one owner for each role during
kickstart. When the platform owns a role, the generated GitHub workflow keeps
the same job as a visible fallback but gates it off, so a slash command cannot
start duplicate agents.

```bash
facility kickstart payments \
  --repo acme/payments \
  --execution-lane '{"architect":"platform","builder":"platform"}'
```

After merging the kickstart PR, follow the
[complete delivery-loop validation](validate-delivery-loop) before onboarding a
production repository.

## Defaults that ship

The rendered system is the production-proven v0.2 shape: crew workflows
(architect/builder), review, address-review, doctor, security sweep,
watchtower with budgets, canary, guards runner, skills, `STANDARD.md`, and
the operating contracts — SHA-pinned actions, slash-command parsing,
bot-refusal, untrusted-text discipline included. You customize by editing
your repo or your registry, not by fighting a generator.

The security sweep uses a split trust boundary: the auditor has read-only
repository access and can only emit a bounded JSON artifact. A separate
reviewed job owns issue-write permission, redacts common credential shapes,
and creates or updates a fingerprinted issue only for actionable,
high-confidence findings of high or critical severity. Run a manual sweep with
`create_issues: false` to inspect the artifact without mutating GitHub.
