---
title: GitHub App
---

# GitHub App

Create one GitHub App for the Facility instance and install it only on repositories the instance
may automate. Grant read/write access to Contents, Issues, Pull requests, Workflows, Actions,
Checks, and Deployments; grant read access to Metadata and organization membership. Add account
email access if GitHub OAuth is also used for sign-in.

The complete repository permission set is:

| Permission | Access |
| --- | --- |
| Actions | Read and write |
| Checks | Read and write |
| Contents | Read and write |
| Deployments | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Workflows | Read and write |
| Code scanning alerts | Read-only |
| Dependabot alerts | Read-only |
| Secret scanning alerts | Read-only |
| Metadata | Read-only |

Do not create different GitHub Apps or permission profiles for different agents. If an installation
cannot expose one of the alert APIs, Facility records a scanner as unavailable rather than clean.

Subscribe to Issues, Issue comment, Pull request, Pull request review, Workflow run, and Check suite
events. Set the webhook URL to `/webhooks/github` and configure `GITHUB_APP_WEBHOOK_SECRET`.

Facility verifies the HMAC before parsing a delivery, resolves the installation to one organization,
stores a deduplicated event, and dispatches triggers declared in `.agents/`. Duplicate deliveries
do not create duplicate turns. A merged pull request marks its story done and suspends compute; it
does not delete the workspace.

All agents receive the same installation token capability. Facility does not request a smaller
permission set for reviewers, scheduled agents, or planning agents.
