---
title: Security
---

# Security model

Facility's trust boundary is the story workspace, not each command an agent executes. Every agent
is treated like a repository maintainer and can use the full shell, filesystem, network, Docker,
browser, Git, and GitHub capability available to that project. Do not connect a repository unless
that access is acceptable.

Facility still enforces:

- client authentication and tenant/project authorization;
- isolation between workspace processes, networks, and volumes;
- short-lived GitHub credentials scoped to configured project repositories;
- signed, deduplicated GitHub webhooks bound to an installation and organization;
- authenticated, expiring, revocable preview sessions with membership checks on every request;
- secret redaction from persisted command events and API responses; and
- explicit confirmation and idempotency for durable workspace deletion.

Agent manifests cannot define a custom permission set. Reviewers and scheduled agents have the
same capability as builders. Their prompts define behavior, while GitHub branch protection,
required reviews, and CI remain structural controls for merge.

The persistent volume can contain proprietary code, uncommitted changes, dependencies, and native
engine session data. Encrypt storage, back it up according to project requirements, restrict host
access, and delete it only through the explicit lifecycle operation.
