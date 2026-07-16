# FAQ

## GitHub already lets me assign issues to Claude, Codex, or Copilot. Why this?

Agent HQ answers "how do I run an agent on an issue". Facility answers what
hits you the week after: the agent ships plans instead of code because it
cannot verify anything; PRs merge on vibes because the review step has no
standard to enforce; nobody wrote down who approves what. Facility is the
method layer — provisioned verification, a binding standard, deterministic
guards, human-owned transitions. It rides on top of whatever execution
substrate wins; today that's `claude-code-action`, and the engine seam in
`.facility.json` exists so it doesn't have to stay the only one.

## How is this different from GitHub Agentic Workflows (gh-aw)?

gh-aw is a compiler: Markdown in, hardened workflow out. It is mechanism, and
good mechanism. It has no opinion about *what* your SDLC should be — roles,
board semantics, quality contracts, the verification ladder, what humans must
own. Facility is those opinions, packaged. If gh-aw becomes the best way to
execute them, Facility should compile to it rather than compete with it.

## Why does everything get vendored into my repo?

Because your SDLC configuration should not have a runtime dependency on us.
After `init`, every file is yours: readable in your repo, reviewable in your
PRs, editable without forking anything. The CLI is an installer, not a
framework. The cost is that updates are not automatic — `facility update` is
on the roadmap, and the `.facility.json` manifest exists so it can diff what
you have against what's current.

## Why can't the agents merge? They wrote the code and the checks pass.

Because the merge is where accountability lives. The crew makes the work
cheap; it does not make the judgment optional. The day an agent-authored
change breaks production, "a human read it and signed off" is the difference
between an incident and a crisis of the whole approach. Protect your default
branch so this is enforced by GitHub, not by trust in a prompt.

## What does it cost to run?

Each crew invocation is a GitHub Actions job (most of it: your provision
command) plus Claude usage under your subscription via the OAuth token.
The review workflow caps at 20 turns; crew runs are bounded by the job
timeout. The real cost driver is invoking /builder before the plan is good —
which is exactly what the /architect column is for.

## My tests need API keys. Where do they go?

In the `facility-crew` GitHub Environment, as dedicated TEST-tier keys with
spend caps — never production keys. An unset secret resolves to empty and
simply disables that integration's tests. The agent runs on an ephemeral
runner with `bypassPermissions`; treat every key you give it as exposed to
the code in your repo.

## Does this work for non-Node projects?

Yes. The CLI and the vendored guards need Node on the runner (present on all
GitHub-hosted runners) — your project doesn't. `init` detects pnpm/yarn/npm
and otherwise leaves a marked slot for your toolchain steps. The provision
command is yours: `make db`, `docker compose up -d`, `mix ecto.setup`.

## Can I use my existing AGENTS.md / CLAUDE.md / .claude setup?

Yes. `init` never overwrites: it appends a managed block to existing
AGENTS.md/CLAUDE.md, skips an existing `.claude/settings.json`, and leaves
any file it finds in place (`--force` to override). `facility doctor` tells
you what state you're in.

## What is the watchtower, in one paragraph?

The layer that answers "is any of this actually working?" with numbers
instead of vibes: nightly agent-PR outcomes (human squash-merge acceptance,
assessment coverage, issue-to-merge lead time, one-shot rate, human fixups)
on a dashboard issue, a daily health monitor with per-workflow budgets that
goes red on breach, and a weekly canary that flies a synthetic
/architect probe through the real pipeline. It reads only the GitHub API,
never the facility's own telemetry, and it's pinned by its own guard so it
can't quietly rot. Full design: [watchtower.md](watchtower.md).

## Why "facility"?

*"This is our software factory."* A facility is where units of work enter as
signals and leave as shipped, inspected, signed-off software: the architect
plans, the builder makes the change, every change gets its own world, the
work survives the gauntlet, the watchtower keeps score — and a person opens
both gates. The name is the place, because the point was never one agent; it
is the whole floor.
