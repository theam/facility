---
title: CLI
---

# CLI

One binary, two lives: the vendored installer it always was, and a client
for your platform.

The CLI is not yet distributed through npm. Run it from a Facility checkout:

```bash
node /absolute/path/to/facility/packages/cli/bin/facility.mjs <command>
# Optional interactive shorthand used throughout this page:
alias facility='node /absolute/path/to/facility/packages/cli/bin/facility.mjs'
```

## Vendored lane (no platform required)

| command | does |
|---|---|
| `init` | install the method into a repo (asks six questions, writes the files, prints the human steps) |
| `add <module>` | add a quality module (database, analytics, ai-queryability, design-system) |
| `doctor [--json]` | check the install and list what's left |

### Repository configuration

Interactive `facility init` detects the package manager, checks, deployment
providers, existing preview configuration, and GitHub Project hints. For a
reproducible non-interactive install, provide the decisions explicitly:

```bash
facility init \
  --branch=main \
  --provision='pnpm install --frozen-lockfile' \
  --checks='pnpm lint, pnpm typecheck, pnpm test' \
  --org=acme \
  --project=12 \
  --preview-image='ghcr.io/acme/app:${{ steps.delivery.outputs.head_sha }}' \
  --preview-command='pnpm start' \
  --preview-port=3000 \
  --preview-readiness-path=/healthz \
  --preview-ttl-hours=24
```

The resulting `.facility.json` is the reviewable source of truth. Its `checks`
must be non-empty for builder delivery. `preview.command` may prepare
non-production data before starting the server; Facility injects no project
secrets, and the immutable image must already be published. The
`${{ steps.delivery.outputs.head_sha }}` tag placeholder is resolved by GitHub
Actions in the repository lane and by Facility in the platform lane.

```json
{
  "defaultBranch": "main",
  "packageInstall": "pnpm install --frozen-lockfile",
  "provision": "pnpm run local:setup",
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "board": { "org": "acme", "project": 12 },
  "executionLane": { "architect": "platform", "builder": "platform" },
  "preview": {
    "enabled": true,
    "image": "ghcr.io/acme/app:sha-…",
    "command": ["sh", "-lc", "pnpm start"],
    "port": 3000,
    "readinessPath": "/healthz",
    "ttlHours": 24
  }
}
```

Run `facility doctor --run-guards --github` after committing. It checks the
manifest, generated workflows, configured agent models and authentication,
preview variables/secrets, deterministic guards, and branch protection.

## Platform lane

The platform lane is the complete operator surface; the web application is not
required.

| area | commands |
|---|---|
| connection | `login`, `logout`, `profiles list\|use\|remove`, `status`, `doctor --platform [--profile]` |
| projects and repos | `projects list\|get\|create\|update\|archive`, `repos list\|connect\|create\|disconnect\|verify\|adopt`, `kickstart`, `upgrade`, `health` |
| execution | `agents list\|status\|create\|update\|delete`, `sessions list\|get\|events\|transcript\|watch\|trigger\|steer\|interrupt\|resume\|cancel` (`runs` is an alias), `conversations list\|get\|start\|send`, `sandboxes list\|create\|update\|delete` |
| GitHub delivery | `github installations\|repos\|issues\|issue\|sync\|trigger`, `outcomes`, `repos list\|connect\|create\|disconnect\|verify\|adopt` |
| human gates | `inbox`, `inbox decide`, `proposals get\|create\|execute`, `action-types list\|get`, `issues list\|ack\|resolve` |
| knowledge and policy | `kb space get\|set`, `kb entries list\|get\|create\|update`, `kb validate`, `tasks list\|create\|update\|delete\|transition\|propose`, `registry list\|get\|create\|version\|publish\|deprecate` |
| money and models | `providers list\|create\|delete`, `virtual-keys list\|issue\|revoke`, `budgets list\|get\|set\|delete`, `spend`, `llm-requests list\|get` |
| administration | `org get\|update`, `members list\|add\|update\|remove`, `roles list\|create\|update\|delete`, `keys issue\|list\|revoke` |
| evidence and integrations | `catalog`, `analytics overview\|timeseries`, `audit list\|verify`, `integrations list\|get\|create\|update\|rotate-secret\|events\|deliveries\|retry\|delete` |

Run `facility <command> --help` for exact flags and an example. Global platform
flags can appear before or after the command: `--profile`, `--json`, `--timeout`,
and `--help`. Unknown flags and missing values fail closed. Destructive commands
require `--yes`.

Human output uses compact tables that adapt to the terminal width and switch to
a readable field layout when a table cannot fit. Color is restrained to live
work, status, and warnings and honors both non-TTY output and `NO_COLOR`. JSON
mode emits one JSON value per command and JSONL for `runs watch`; failures use
stdout too, leaving stderr clean for deterministic pipelines. Exit codes are
`0` success, `1` command/API/terminal-run failure, and `2` authentication.
`kb validate` and `audit verify` return `1` when their report is not valid, so
they can be used directly as CI gates.

`sessions transcript` writes the original NDJSON transcript in human mode and
one JSON object with parsed events in `--json` mode. `sessions watch --json`
is the deliberate JSONL exception because it is an unbounded event stream.

`sessions trigger <project> <agent> --input <json-or-text>` carries the manual
run's objective. Builder agents require a non-empty text or structured input;
Facility rejects objective-free manual builder runs instead of letting an agent
guess what to implement.
Programmatic callers must likewise provide a non-empty `message`, `approvedPlan`,
structured `input`, or governed issue number when they trigger a builder.

`facility doctor` checks the current repository. Add `--platform` to use the
current saved profile, `--profile <name>` to select one, or pass `--url` and
`--key` together. Remote plaintext targets require `--allow-insecure`, exactly
as login does. `--json` is machine-readable in both modes.

Credentials can come from a mode-`0600` profile file, an alternate
`FACILITY_CONFIG`, or the paired `FACILITY_URL` and `FACILITY_API_KEY`
environment variables. Interactive keys are masked and remote plaintext HTTP
is refused unless `--allow-insecure` is explicitly chosen for development.
Non-interactive login may receive URL and key as two newline-delimited stdin
values. JSON mode never prompts: credentials must come from flags or the paired
environment variables, preserving the one-JSON-value contract.
