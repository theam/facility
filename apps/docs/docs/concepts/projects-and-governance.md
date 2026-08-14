---
title: Projects & governance
---

# Projects & governance

A **project** is the unit of governance: one product, one or more GitHub
repositories, its own agents, budgets, knowledge base, and analytics —
cleanly separated from every other project in the organization.

## Kickstart

Kickstart turns a repository into a working factory. The platform detects
the stack, asks the few questions that matter (default branch, provision
command, check commands, modules), renders the versioned template set —
workflows, guards, skills, the standard, operating contracts — and opens a
pull request. A human merges it: the platform never pushes to your default
branch. Greenfield or brownfield, the defaults are the production-proven
shape; every choice can be changed later.

## Fingerprints

The platform records a manifest — path and SHA-256 — of every file it
manages in your repo, tied to the template-set version. On every push that
touches managed paths, the manifest is re-verified:

- **ok** — files match the installed system version.
- **drifted** — a managed file changed outside an upgrade. Drift is a signal,
  not a police action: review it, then either restore or **adopt** the change
  (re-baseline, on the record).
- **corrupted** — managed files are missing or mangled; the repo's integrity
  is in question and the platform raises an issue.

## Upgrades

The template set is versioned. Upgrading renders the target version against
your recorded answers, three-way-merges it with what's in the repo, and opens
a PR. Files you never touched apply cleanly; conflicts are reported alongside,
never silently overwritten. The fingerprint advances only when the PR merges.

## System versioning

Every project records its system version. Org policy can pin projects,
preview diffs between versions, and roll forward on your schedule — the whole
method is data, not folklore.
