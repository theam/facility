---
title: CLI
---

# CLI

One binary, two lives: the vendored installer it always was, and a client
for your platform.

```bash
npx @theam/facility <command>
```

## Vendored lane (no platform required)

| command | does |
|---|---|
| `init` | install the method into a repo (asks six questions, writes the files, prints the human steps) |
| `add <module>` | add a quality module (database, analytics, ai-queryability, design-system) |
| `doctor [--json]` | check the install and list what's left |

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
