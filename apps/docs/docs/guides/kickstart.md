---
title: Kickstart a project
---

# Kickstart a project

From zero to a working factory:

1. **Create the project** in the web app or through the API. The CLI can list
   and get projects, but it does not create them.
2. **Connect the repo.** Install your GitHub App on the repository; it
   appears in the project's repo picker.
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
   default branch, confirm App permissions, and require the deployment
   provider's per-PR live preview check.
6. **Configure a live PR preview.** Connect the repo to a deployment provider
   that creates an isolated environment for each pull request. Make its URL and
   status visible on the PR so Gate 2 can validate behavior, not only a diff.
   Facility requires this validation surface now; native orchestration is
   [planned](../roadmap#native-preview-environments).
7. **Merge it.** That's Gate 2 muscle memory from day zero. Validate the live
   preview, review the PR, and squash-merge it in GitHub. On merge the
   fingerprint baseline is recorded and the project reports **system ok**.

Now open an issue and comment `/architect`.

## Defaults that ship

The rendered system is the production-proven v0.2 shape: crew workflows
(architect/builder), review, address-review, doctor, security sweep,
watchtower with budgets, canary, guards runner, skills, `STANDARD.md`, and
the operating contracts — SHA-pinned actions, slash-command parsing,
bot-refusal, untrusted-text discipline included. You customize by editing
your repo or your registry, not by fighting a generator.
