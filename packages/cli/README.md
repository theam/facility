# @theagilemonkeys/facility

The Facility CLI installs and validates the small repository contract used by
Facility 0.12. Day-to-day story work happens through the Facility MCP server or
web application.

```bash
cd your-repository
npx @theagilemonkeys/facility init
npx @theagilemonkeys/facility doctor
```

`init` writes exactly two kinds of project-owned configuration:

- `.facility.yml` describes the repositories, setup command, development
  command, readiness check, and exposed services for a persistent workspace.
- `.agents/*.md` describes each agent's prompt, engine, model, and manual, MCP,
  UI, scheduled, or GitHub triggers.

Existing files are preserved unless `--force` is explicit. Agent manifests do
not contain permission profiles: every enabled agent receives the same full
workspace and GitHub maintainer capability for the connected project.

`doctor` checks the seven-file contract locally. It never connects to a
Facility instance and supports machine-readable output with `--json`.

Instance operators can create the first organization, owner, and GitHub App
installation with `facility instance bootstrap`. See the
[Facility documentation](https://github.com/theam/facility/tree/main/apps/docs/docs)
for deployment and MCP setup.

Node.js 24 LTS is recommended; Node.js 22 is supported from 22.13.0. Facility
0.x is early software and does not promise in-place database upgrades between
minor versions.

Apache-2.0
