---
title: CLI
---

# CLI

The 0.12 CLI configures and checks a repository. Runtime automation belongs to MCP; people can also
use the web UI.

Install or invoke the published package from a repository root:

```bash
npx @theagilemonkeys/facility --version
npx @theagilemonkeys/facility init
npx @theagilemonkeys/facility doctor
```

```text
facility init      write .facility.yml and .agents/*.md
facility doctor    validate the local workspace contract
facility instance bootstrap
                   bind the first owner and GitHub installation
```

## `facility init`

Init detects the GitHub remote, package manager, setup command, development command, and likely
service port. Interactive mode lets you correct those values. `--yes` accepts detected or explicit
values without prompts.

| Flag | Purpose |
| --- | --- |
| `--dir=<path>` | Configure another repository directory. |
| `--yes`, `-y` | Run without interactive confirmation. |
| `--force` | Overwrite the seven Facility-owned targets. |
| `--repo=<owner/name>` | Set the primary GitHub repository. |
| `--provision=<command>` | Set optional `environment.setup`. |
| `--start=<command>` | Set required `environment.start`. |
| `--preview-readiness-command=<command>` | Set optional `environment.ready`. |
| `--service-port=<number>` | Set the initial `app` service port. |
| `--build-model=<id>` | Set the initial Claude builder model. |
| `--review-model=<id>` | Set the initial Claude reviewer model. |
| `--plan-model=<id>` | Set the initial Claude architect model. |
| `--codex-build-model=<id>` | Set the initial Codex builder model. |
| `--codex-plan-model=<id>` | Set the initial Codex architect model. |

Init writes only `.facility.yml` and these manifests:

- `.agents/architect.md`
- `.agents/builder.md`
- `.agents/pr-reviewer.md`
- `.agents/address-review.md`
- `.agents/ci-doctor.md`
- `.agents/security-audit.md`

It preserves each existing file independently unless `--force` is explicit. Review before using
force: these files are project-owned configuration, not disposable generated output.

## `facility doctor`

Doctor checks the local seven-file kickstart contract and exits non-zero when it finds a problem.
Use `--dir=<path>` to inspect another checkout and `--json` for machine-readable results:

```bash
facility doctor --json
```

Doctor does not connect to a Facility instance or GitHub and does not prove that commands start
successfully. The server's strict manifest parsers remain authoritative. Follow local validation
with a disposable story workspace.

## `facility instance bootstrap`

After migrations and seed data exist in an empty database, bootstrap binds the first organization,
owner identity, and GitHub App installation:

```bash
DATABASE_URL=postgres://... facility instance bootstrap \
  --org-name='Acme Engineering' \
  --org-slug=acme \
  --owner-email=owner@example.com \
  --owner-name='Repository Owner' \
  --github-user-id=12345 \
  --github-login=owner \
  --github-account-id=67890 \
  --github-installation-id=24680 \
  --github-account-login=acme \
  --github-account-type=organization
```

The command takes a PostgreSQL advisory lock. Repeating the exact binding is safe and reports that
it already exists; a different binding against a populated instance is refused. Use `--json` for
automation and protect `DATABASE_URL` as an administrative secret.

Run `facility <command> --help` for local usage. Unknown options and missing option values fail
instead of being ignored.
