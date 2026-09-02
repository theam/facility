---
title: Kickstart a repository
---

# Kickstart a repository

Create a project in the UI and choose a repository visible to the GitHub App. Facility detects a
Compose file or a package start script. Review and, if needed, edit the setup command, start
command, readiness command, and exposed application port.

Kickstart opens a pull request containing exactly `.facility.yml` and six initial agent manifests
under `.agents/`. Existing files are not overwritten. The pull request does not modify the default
branch until a maintainer merges it.

The CLI writes the same files locally:

```bash
facility init \
  --repo=acme/app \
  --provision='pnpm install --frozen-lockfile' \
  --start='docker compose up -d' \
  --preview-readiness-command='curl --fail http://localhost:3000/health' \
  --service-port=3000

facility doctor
```

Before merge, inspect every command and port in `.facility.yml`, and inspect each agent's prompt,
engine, model, and triggers. All of them will run with full workspace and GitHub maintainer access.
