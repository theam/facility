# Spec: sandbox orchestrator + runner (services/api worker, runner/)

**Scope**: platform-native agent execution — the `runs.dispatch` worker in `@facility/api`, a driver seam, the `runner` workspace (agent host that runs inside the sandbox), and live session streaming/steering end-to-end. After this lands, `POST /v1/projects/:id/runs` actually executes Claude Code / Codex / BYO in an isolated container and an engineer can watch and steer it from the API surfaces the web app already consumes.

Read first: control-plane.md (runs/run_events/steer_messages/sandbox_profiles/virtual_keys), gateway.md (the base-URL contract), ARCHITECTURE.md §5 "Platform-native run", discovery/tam-os.md (fragile list: app-token pushes, provisioned-before-agent).

## Driver seam (`services/api/src/sandbox/driver.ts`)

```ts
interface SandboxDriver {
  name: "docker" | "aws";
  launch(spec: LaunchSpec): Promise<{ ref: string }>;   // fire-and-track
  status(ref: string): Promise<"starting"|"running"|"exited"|"lost">;
  logs(ref: string, afterLine?: number): AsyncIterable<string>; // raw container stdout/err (diagnostics only)
  stop(ref: string, opts?: {kill?: boolean}): Promise<void>;
  destroy(ref: string): Promise<void>;
}
```

`LaunchSpec`: {runId, image, env (NON-secret), cpu, memoryMb, timeoutMin, cmd, network}. Secrets travel differently: the runner authenticates back to the api with a one-time **runner token** (random 32B, argon2-hashed on runs row, expires at run end) passed via env — everything else (virtual key, repo token) the runner FETCHES over HTTPS after boot. Container env never holds provider or installation credentials.

**v1 drivers**: `docker` (dockerode against local socket; label `facility.run=<id>`; auto-remove off — we destroy explicitly). Docker sandboxes run with a read-only root filesystem and tmpfs mounts at `/work`, `/tmp`, and `/var/tmp`. Network egress defaults to `restricted`: the container is attached only to `network.docker_network` / `network.dockerNetwork` / `FACILITY_SANDBOX_DOCKER_NETWORK`; if none is configured, networking is disabled. Set `network.egress="unrestricted"` only for trusted local/e2e profiles. `aws` = real Fargate/ECS driver (`RunTask` against the runner task definition, subnets/security-groups/log-config from env; `status`/`stop`/`destroy` map to `DescribeTasks`/`StopTask`). It fails loudly with a clear `not_configured` error when its env/task-def is absent, so a misconfigured deployment surfaces immediately instead of faking success.

## Run lifecycle (worker `runs.dispatch`)

queued → provisioning: resolve agent_def + sandbox_profile + repo; create run-scoped virtual key (budget-linked); mint runner token; render **run bundle** (JSON): {contract (registry content), skills[] (registry), engine config (model/effort), repo {cloneUrl, branch, installationTokenRef}, provision_cmd, check_cmds, gateway URLs, kb/task scope}. Store bundle to object storage; launch container with {FACILITY_API_URL, RUN_ID, RUNNER_TOKEN}.
provisioning → running: on runner's `POST /internal/runs/:id/hello` (runner-token auth). Timeout: profile timeoutMin via pg-boss job; expiry → stop+fail run, platform_issue kind run_failure.
running → terminal: runner posts `result` (succeeded/failed + receipt fields it can see: turns, checks, artifacts); worker finalizes receipt by merging gateway aggregates (SUM llm_requests for run) via `@facility/core` receipts; destroy sandbox; revoke virtual key; audit `run.finished`.
cancel: API sets canceling flag → worker stops container (SIGTERM, 10s, SIGKILL) → canceled.
Reconciler cron (`sandbox.reconcile`, every 2min): containers labeled facility.run without a live run → destroy; runs `running` whose driver status is exited/lost → fail with `sandbox_lost`, issue created.

## Internal runner API (in `@facility/api`, `/internal/*`, runner-token auth only, never session/key auth)

- `POST /internal/runs/:id/hello` → {bundleUrl (signed GET), virtualKey (fvk_… one-time reveal), repoToken (short-lived installation token when repo configured — GitHub App chunk wires the real mint; until then null), gatewayUrls}
- `POST /internal/runs/:id/events` (batch [{type, data, ts}]) → assigns seqs, inserts run_events, NOTIFY channel `run_events:<id>`
- `GET /internal/runs/:id/steer?afterId=` → undelivered steer_messages (long-poll ≤25s); marks delivered
- `POST /internal/runs/:id/result` {status, receipt partials, error?}
Rate-limit per run; reject after terminal state.

Also upgrade the public SSE `GET /v1/runs/:id/stream` from polling to LISTEN/NOTIFY (keep poll fallback).

## runner/ workspace (`@facility/runner`)

Small Node 22 TS program + Dockerfile (`runner/Dockerfile`, base `node:22-bookworm` + git + ripgrep; Claude Code and Codex CLIs installed at IMAGE BUILD: `npm i -g @anthropic-ai/claude-code @openai/codex` — pin exact versions in the Dockerfile with a comment). Flow:

1. hello → fetch bundle; write workspace: clone repo (when configured) to /work/repo at branch; else init empty /work/scratch.
2. Write engine config: contract → `/work/contract.md`; skills → `.claude/skills/` (or `.agents/skills` mirror); `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` → gateway; `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` = virtual key.
3. Run provision_cmd (if any) streaming output as `shell` events; failure → result failed with `provision_failed` (the provisioned-site rule: agent never starts on a broken site).
4. Launch engine:
   - claude_code: `claude -p <composed prompt> --output-format stream-json --verbose --permission-mode bypassPermissions --max-turns 500` (+ model/effort flags from config), cwd repo. Parse stream-json events → map to run_events: assistant text→`assistant`, tool_use→`tool` {name, input summary ≤500 chars}, result→final.
   - codex: `codex exec --json -s danger-full-access` (sandboxing is the container) — map JSONL events likewise.
   - byo: `sh -c config.cmd` with the same env contract; stdout lines → `assistant` events.
5. Steering: poll long-poll endpoint; on message: write to a `STEERING.md` inbox file AND (claude_code) send via stdin turn injection if the CLI session is interactive-capable; v1 baseline that MUST work: queue the steer text and append it as the next user turn using `claude -p --resume <session_id>` when the current turn completes; emit `steer` event when applied. Document the mechanism per engine in runner/README.md — no pretending.
6. Checks — two kinds, both surfaced as `check` events:
   - **Platform-owned gates:** after the engine, run every `bundle.checkCmds` command in the workspace cwd; each emits a `check` event flagged `self_reported: false` with `status` passed/failed, `exit_code`, and (on failure) a capped, secret-redacted output tail. Source of truth: the sandbox profile's `setup.check_cmds`, falling back to the project's `settings.check_cmds`.
   - **Agent self-report:** parse `.agent-sdlc/checks.jsonl` if the agent wrote it (tam-os convention) → `check` events flagged `self_reported: true` (the runner forces this flag; the agent can't spoof platform provenance).
7. result: succeeded when engine exit 0 (claude: result event subtype success) **and** every platform check passed; otherwise failed (`checks_failed` when the engine succeeded but a gate did not) + tail of stderr as error. Never swallow the engine's nonzero exit, and never report success while a required gate is red.

Timeout safety inside the container: kill engine at bundle.timeoutMin−2, post result failed `timeout`.

## Mechanical floor

```
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint && node guards/run.mjs
docker build -t facility-runner:dev runner/
FACILITY_E2E_DOCKER=1 pnpm --filter @facility/api test:e2e-sandbox
```

`test:e2e-sandbox` (vitest, tagged, requires docker + compose PG): full loop with engine **byo** and image facility-runner:dev — trigger run via API with a byo agent_def whose cmd is a fixture script (emits lines, reads a steer, writes checks.jsonl, exits 0) → assert: run reaches succeeded; run_events contain hello→shell→assistant→steer→check sequence; steer round-trip < 30s; virtual key revoked after; container gone (docker ps -a filtered by label empty); receipt retains event/check counts and includes normalized check outcomes with provenance. Plus unit tests: driver docker launch/stop/destroy against a sleep container; reconciler kills orphans (launch container with label, no run row); internal API auth (wrong runner token → 401; post after terminal → 409); SSE NOTIFY path delivers an event end-to-end.

Claude/Codex engine paths: unit-test the stream-json/JSONL PARSERS against recorded fixtures (commit small fixture files; note their CLI versions). Do not attempt live model calls in tests.

## Judgment criteria

No secret in container env beyond the one-time runner token (I will read LaunchSpec construction); runner fetches everything else authenticated. Drivers are genuinely swappable (worker imports the interface only). Event mapping loses nothing important (tool names + truncated inputs, not raw dumps of huge payloads). The aws driver fails loudly (`not_configured`) when its env/task-def is missing, never silently. Reconciler cannot kill innocent containers (label + run-state double check). Steering is auditable (audit event on send + `steer` run_event on apply).
