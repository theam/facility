---
title: API
---

# HTTP API

The OpenAPI document is served from `/docs`. The supported 0.12 surface covers authentication,
members and API keys, projects and repositories, kickstart, story workspaces, conversations,
environments, previews, the GitHub webhook, and `POST /mcp`.

Every protected request resolves an organization principal. Project-scoped keys cannot access org
administration or another project. Mutating routes that may be retried require `Idempotency-Key`;
reusing a key with a different request is rejected.

Long-running work is represented by persisted turns and events rather than an open HTTP request.
Clients can poll the story and conversation without creating duplicate work.
