# Security policy

Facility runs coding agents in persistent story workspaces with full access to
the connected GitHub repositories, shell, network, Docker, and browser. We
treat cross-organization access, credential exposure, preview-authentication
bypass, webhook forgery, and prompt injection that escapes the configured
project boundary as security vulnerabilities.

## Reporting

Report privately via [GitHub Security Advisories](https://github.com/theam/facility/security/advisories/new).
Please don't open public issues for suspected vulnerabilities. We'll respond
within five working days.

In scope, with examples:

- A way for issue/PR/review text to escape the untrusted-data framing and
  drive agent behavior (prompt injection → action).
- A workspace or API request that can read or modify another organization's
  projects, stories, conversations, sessions, or previews.
- A path that exposes GitHub installation tokens, engine credentials, preview
  gateway secrets, or persisted native session data.
- A forged or replayed GitHub webhook that starts work more than once.
- A path by which an agent can merge or push directly to a protected branch.

## Expectations for adopters

Facility intentionally gives every agent the same maintainer-level GitHub and
workspace capability. Operators must restrict the GitHub App to the intended
repositories, protect default branches, isolate the workspace runtime from the
control plane, terminate TLS at the public edge, and keep the preview surface
token private. Archive and suspend retain worktree and native session data;
only explicit workspace deletion removes it. The complete deployment boundary
is documented in `apps/docs/docs/reference/security.md`.
