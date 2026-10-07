---
title: Local mode
---

# Run Facility for local repositories

Local mode runs Facility on your own machine against Git repositories on that machine. It needs
Docker and PostgreSQL. It needs no GitHub App, OAuth application, webhook, or hosted repository.
Users follow [Work on a local repository](../guides/local-repository.md) once it is running.

## Install

1. Install Docker and Node.js 24 with pnpm 11.20.0, and clone Facility.
2. Build the workspace image: `docker build -f runner/Dockerfile -t facility-runner:dev .`
3. Copy `.env.example` to `.env` and set `SECRET_MASTER_KEY` (`openssl rand -base64 32`).
4. Leave every `GITHUB_*` value empty.
5. Approve the directories Facility may read:

   ```bash
   FACILITY_LOCAL_REPOSITORY_ROOTS=/home/you/code
   ```

   Separate several roots with `:`. Facility refuses paths outside them, symlinks that resolve
   outside them, and worktrees whose Git directory lives outside them.
6. Run `pnpm dev`, open `http://localhost:3400`, and choose **continue locally**.

`pnpm dev` starts PostgreSQL on `localhost:5461`, applies migrations, and runs the API, worker, and
UI. The API and worker both read local repositories, so both need the same roots.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACILITY_LOCAL_REPOSITORY_ROOTS` | empty (disabled) | Directories whose repositories may be registered. |
| `FACILITY_LOCAL_REPOSITORY_OWNER_UIDS` | the Facility process user | Comma-separated user ids allowed to own registered repositories. |
| `FACILITY_LOCAL_SNAPSHOT_MAX_BYTES` | 512 MiB | Largest repository bundle Facility imports. |
| `FACILITY_LOCAL_GIT_NAME`, `FACILITY_LOCAL_GIT_EMAIL` | `Facility Agent`, `facility-agent@localhost` | Author identity for agent commits. |
| `FACILITY_LISTEN_HOST` | `localhost` | Interface the API binds. |

## Model providers

Local mode uses the existing Claude Code and Codex engines with cloud credentials. Configure them
per project exactly as for GitHub projects: declare the names under `environment.secrets` in
`.facility.yml`, then provide the values as project environment variables in **Settings** or as
`FACILITY_PROJECT_<PROJECT_ID>_ANTHROPIC_API_KEY` / `..._OPENAI_API_KEY` in `.env`. Existing
secret redaction, usage accounting, and budgets apply unchanged.

## Network exposure and authentication

Facility binds the API to loopback by default. Docker Compose publishes the API and UI on
`127.0.0.1` unless `FACILITY_BIND_ADDRESS` says otherwise. Remote access is a separate deployment
mode: configure GitHub or OIDC sign-in and follow [production](production.md) before widening
either setting.

The **continue locally** login (`FACILITY_INSECURE_DEV=1`) signs in as the local owner without a
password. It is supported for local mode only under these conditions, which Facility enforces:

- it is refused when `NODE_ENV=production`;
- `PUBLIC_URL` and `WEB_URL` must be loopback URLs;
- the connection must come from a loopback address; and
- the browser-facing host must be `localhost`, `127.0.0.1`, or `[::1]`. This defeats
  DNS-rebinding pages and other machines on the network.

Because the proxy that serves the UI must connect from loopback, the shortcut is for the
`pnpm dev` setup. When Facility runs in containers, use GitHub or OIDC sign-in instead. Every API
call still passes the normal role, project-scope, and organization checks.

## Containers

To run the Compose stack in local mode, mount each approved root at the same path in the `api` and
`worker` services, list it in `FACILITY_LOCAL_REPOSITORY_ROOTS`, and set
`FACILITY_LOCAL_REPOSITORY_OWNER_UIDS` to the user id that owns the repositories on the host. Use
read-only mounts: Facility only reads source repositories.

```yaml
services:
  api:
    volumes:
      - /home/you/code:/home/you/code:ro
  worker:
    volumes:
      - /home/you/code:/home/you/code:ro
```

## Back up and restore

A local installation holds state in four places. Back up all of them together, while no turn is
running:

1. **Database.** Stories, conversations, review decisions, check results, imported source revisions,
   and export bundles live in PostgreSQL:

   ```bash
   pg_dump --format=custom --file=facility.dump "$DATABASE_URL"
   ```

2. **Workspace volumes.** Each story's files, story branch, and agent sessions live in a Docker
   volume named `facility-ws-volume-<id>`:

   ```bash
   for volume in $(docker volume ls -q --filter label=facility.workload.kind=workspace-v2); do
     docker volume inspect --format '{{ index .Labels "facility.workspace.id" }}' "$volume" \
       > "$volume.workspace-id"
     docker run --rm -v "$volume:/workspace:ro" -v "$PWD:/backup" alpine \
       tar -C /workspace -czf "/backup/$volume.tar.gz" .
   done
   ```

3. **Source repositories.** Your repositories are not copied into Facility, except inside workspace
   volumes. Back them up as you normally would. After a restore they must be at the same paths,
   because Facility stores each repository's canonical path.
4. **Secrets.** Keep `SECRET_MASTER_KEY` and the project credentials in `.env`. Without the same
   master key, restored encrypted project variables cannot be read.

To restore:

1. Recreate the database: `pg_restore --clean --dbname="$DATABASE_URL" facility.dump`.
2. Recreate each volume with the labels Facility uses to recognize its own workspaces, then extract
   its archive:

   ```bash
   for archive in facility-ws-volume-*.tar.gz; do
     volume="${archive%.tar.gz}"
     docker volume create \
       --label "facility.workspace.id=$(cat "$volume.workspace-id")" \
       --label facility.workload.kind=workspace-v2 "$volume"
     docker run --rm -v "$volume:/workspace" -v "$PWD:/backup:ro" alpine \
       tar -C /workspace -xzf "/backup/$archive"
   done
   ```

3. Restore `.env` with the same `SECRET_MASTER_KEY`, and put source repositories back at their
   registered paths.
4. Start Facility. Each workspace's compute is recreated from its volume the next time its story
   runs.
