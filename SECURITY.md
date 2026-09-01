# Security policy

Facility generates CI workflows that run AI agents with elevated permissions
on ephemeral runners. We treat weaknesses in what we generate — prompt
injection paths, secret exposure, privilege escalation through workflow
configuration — as security vulnerabilities, the same as flaws in the CLI
itself.

## Reporting

Report privately via [GitHub Security Advisories](https://github.com/theam/facility/security/advisories/new)
when private reporting is enabled on the repository. If that form is unavailable,
email **security@theagilemonkeys.com** with a short description and reproduction
steps instead. Please don't open public issues for suspected vulnerabilities.
We'll respond within five working days.

In scope, with examples:

- A way for issue/PR/review text to escape the untrusted-data framing and
  drive agent behavior (prompt injection → action).
- Generated workflow configuration that exposes secrets to fork-originated
  code or over-grants tokens.
- A path by which a crew agent can approve, merge, or push to a protected
  branch despite the contracts and hooks.
- Guard or hook bypasses that defeat their stated invariant.

## Expectations for adopters

The generated setup assumes: secrets live in GitHub Environments with
TEST-tier credentials, the default branch is protected, and runners are
GitHub-hosted (ephemeral). If you weaken any of those, you own the resulting
surface. `apps/docs/docs/reference/hardening.md` documents the threat model behind each generated
decision.
