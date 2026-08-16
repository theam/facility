# @theagilemonkeys/facility

The command-line half of [Facility](https://github.com/theam/facility) —
open-source, self-hosted tooling for running AI coding agents as part of a
reviewable delivery process, with the humans, the gates and the evidence in one
place.

One binary with two jobs, and you rarely need both:

- **A client for a Facility platform.** Dispatch agents, follow sessions, decide
  proposals, inspect spend, manage projects and repositories — everything the
  web application does, from a terminal or a script.
- **An installer for a repository.** When a team wants the process running in
  its own CI, invoked from issue comments, `facility init` writes the workflows,
  the standard, the skills and the guards into the repository.

```bash
npx @theagilemonkeys/facility --help
```

Node.js 20 or newer. Zero configuration to read; one runtime dependency —
`postgres`, which `facility instance bootstrap` uses to connect directly to a
Facility database. `init` also shells out to `git`, and `doctor --github` to the
GitHub CLI, where those are on the `PATH`.

**Early software.** Facility is published while it is still being built: the
API is young, generated files change shape between `0.x` releases, and no
upgrade path is promised across them. Apache-2.0 means what it says — no
warranty, use at your own risk.

## Talking to a platform

```bash
npx @theagilemonkeys/facility login --url https://facility.example.com --key fak_…
npx @theagilemonkeys/facility status      # runs, approvals, issues and spend at a glance
npx @theagilemonkeys/facility inbox       # review and decide pending proposals
npx @theagilemonkeys/facility sessions    # trigger, watch, steer or cancel agent runs
```

Platform commands take a global `--json`, `--profile <name>` and
`--timeout <seconds>`, so the CLI is as usable from a script as from a prompt.
It speaks the same versioned REST API and obeys the same permissions as the web
application: what your key cannot do, the CLI will not do either.

## Installing the process into a repository

```bash
cd your-repository
npx @theagilemonkeys/facility init
npx @theagilemonkeys/facility doctor --run-guards --github
```

`init` asks about the package manager, the default branch, the commands that
provision an environment and verify a change, then writes GitHub workflows for
planning, building, reviewing and repairing, plus `STANDARD.md`, agent
instructions, skills, deterministic guards, and a `.facility.json` recording the
answers. It never overwrites an existing generated file unless you pass
`--force`, and it appends to `AGENTS.md` and `CLAUDE.md` inside a delimited
managed block rather than replacing them.

This is the second step, not the entry price: a repository connected to a
Facility platform is operated entirely from the platform, without a single file
being added to it.

## Documentation

- [CLI reference](https://github.com/theam/facility/blob/main/apps/docs/docs/reference/cli.md)
- [Self-hosting guide](https://github.com/theam/facility/blob/main/apps/docs/docs/self-host/quickstart.md)
- [Repository and issues](https://github.com/theam/facility)

Apache-2.0 · an initiative by [The Agile Monkeys](https://theagilemonkeys.com)
