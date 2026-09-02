---
title: Quickstart
---

# Self-host quickstart

Install Docker, Node.js 24, and the repository-pinned pnpm version.

```bash
corepack install --global pnpm@11.20.0
pnpm install --frozen-lockfile
cp .env.example .env
docker build -f runner/Dockerfile -t facility-runner:dev .
pnpm dev
```

The UI is on `http://localhost:3400`; the API, MCP server, GitHub webhook, and preview proxy are on
`http://localhost:4400`. Local PostgreSQL listens on port 5461.

For local development, choose **continue locally** on the login page. To exercise real repositories,
configure a GitHub App for repository access and restart the services. Production installations use
GitHub or OIDC authentication and bind the first owner with `facility instance bootstrap`. Create a
project in the UI, choose a repository, and open its kickstart PR. After merging that configuration
PR, start a story through MCP or the Stories page.

0.12 requires an empty database. The migration command refuses a 0.11 schema without changing it.
