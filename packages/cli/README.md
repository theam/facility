# @theagilemonkeys/facility

The Facility CLI installs and validates the small repository contract used by
Facility 0.12. Day-to-day story work happens through the Facility MCP server or
web application.

```bash
cd your-repository
npx @theagilemonkeys/facility init
npx @theagilemonkeys/facility doctor
```

Node.js 24 LTS is recommended; Node.js 22 is supported from 22.13.0.

## Initialize a repository

Interactive init detects the GitHub remote, package manager, setup command,
development command, and application port. For automation, provide the values
explicitly:

```bash
npx @theagilemonkeys/facility init --yes \
  --repo=acme/application \
  --provision='pnpm install --frozen-lockfile' \
  --start='docker compose up -d' \
  --preview-readiness-command='curl --fail http://localhost:3000/health' \
  --service-port=3000
```

`init` writes exactly two kinds of project-owned configuration:

- `.facility.yml` describes the repositories, setup command, development
  command, readiness check, and exposed services for a persistent workspace.
- `.agents/*.md` describes each agent's prompt, engine, model, and manual, MCP,
  UI, scheduled, or GitHub triggers.

Existing files are preserved unless `--force` is explicit. Agent manifests do
not contain permission profiles: every enabled agent receives the same full
workspace and GitHub maintainer capability for the connected project.

Init creates `architect`, `builder`, `pr-reviewer`, `address-review`,
`ci-doctor`, and `security-audit`. Model flags customize the initial templates:

```text
--build-model=<id>        --review-model=<id>
--plan-model=<id>         --codex-build-model=<id>
--codex-plan-model=<id>
```

Use `--dir=<path>` to configure another checkout. Existing targets are
preserved independently; `--force` overwrites only `.facility.yml` and those
six agent files. Review them before using force because they are project-owned
configuration.

## Validate locally

`doctor` checks the seven-file contract locally. It never connects to a
Facility instance and supports machine-readable output with `--json`.

```bash
npx @theagilemonkeys/facility doctor --json
```

Doctor provides fast local feedback; the server's strict manifest parsers and
a real disposable workspace remain authoritative for runtime acceptance.

## Bootstrap an instance

Instance operators can create the first organization, owner, and GitHub App
installation with `facility instance bootstrap`. See the
[Facility documentation](https://github.com/theam/facility/tree/main/apps/docs/docs)
for deployment and MCP setup.

Bootstrap requires `DATABASE_URL` and explicit organization, owner GitHub
identity, account, and installation values. It is safe to repeat only with the
exact same binding and refuses a different binding when instance data exists.
Run `facility instance bootstrap --help` for the full command.

Facility 0.x is early software and does not promise in-place database upgrades
between minor versions. Facility 0.12 specifically requires a new database
rather than a 0.11 in-place migration.

Apache-2.0
