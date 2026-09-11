# Facility workspace runner

The runner is the complete Linux environment used by persistent story
workspaces. It is trusted agent compute, not a restricted command sandbox. The
control plane creates, wakes, inspects, suspends, and replaces its compute while
the workspace volume retains repositories and native engine state.

## Included capabilities

The image contains:

- Claude Code and Codex from the locked `runner/agent-clis` package set;
- Git and GitHub CLI with Facility's installation-token credential helper;
- Chromium, Xvfb, fonts, and browser runtime libraries;
- Docker Engine, CLI, Compose, Buildx, containerd, runc, RootlessKit, and
  rootless networking/storage support;
- Node.js, npm, Corepack, the repository-pinned pnpm release, Python, native
  build tools, curl, jq, and ripgrep; and
- the Facility preview gateway used to expose declared services.

Go-based container and GitHub tools are rebuilt from checksum-pinned source and
audited during the image build. Base image and package changes must preserve
that executable supply-chain check rather than bypassing it.

## Persistent layout

The working directory is `/workspace`. Facility checks repositories out beneath
`/workspace/repos/<owner>/<repository>`. `HOME` is
`/workspace/.facility/home`, so Claude Code and Codex session/configuration
files live on the persistent workspace volume.

Project dependencies, uncommitted files, local commits, Docker project data,
and artifacts may also live on that volume. Replacing the container must not
replace the volume.

## Docker isolation

The Docker workspace runtime starts a workspace-scoped daemon during trusted
bootstrap. Agent and project commands use that daemon. They do not receive the
Facility host Docker socket, even though the control-plane API and worker need
host daemon access to manage workspace resources.

Avoid adding a host-socket mount to repository Compose examples or runner
entrypoints. A project can run privileged software inside its trusted workspace
without becoming an administrator of every Facility workspace on the host.

## Targets

- `runner` is the default Docker workspace image and runs normal commands as
  the `node` user.
- `vercel-runner` leaves Vercel's trusted initialization path as root; Facility
  runs agent commands as `node` after initialization. This target includes
  `sudo` for the Vercel SDK's user switch. Its build verifies that root can
  switch to `node` and that `node` cannot use sudo to become root.

The default command sleeps because lifecycle and agent commands arrive through
the workspace provider. The image is not the Facility API or worker image.

## Build and inspect

From the repository root:

```bash
docker build -f runner/Dockerfile -t facility-runner:dev .
docker run --rm facility-runner:dev sh -lc \
  'node --version && claude --version && codex --version && gh --version && docker compose version'
```

The second command checks client availability; nested Docker acceptance needs
the Facility Docker workspace E2E because daemon bootstrap, volumes, network,
preview, and compute replacement are runtime responsibilities.

## Verification

Run:

```bash
FACILITY_E2E_DOCKER=1 \
FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev \
pnpm test:e2e-workspace
```

The full command and database requirements are in `docs/testing.md`. Runner
changes also require `pnpm verify`, a successful image build for each supported
target architecture, and vulnerability review using the repository scanner
configuration.

## Updating tools

Update one coherent toolchain at a time. Pin image digests, source commits,
archive checksums, package locks, and executable version assertions together.
Retain the final-image size and Vercel layer constraints documented in the
Dockerfile comments.

After an engine CLI update, verify fresh and resumed Claude Code and Codex
sessions. After a Docker tool update, verify Compose, Buildx, nested daemon
startup, compute replacement, and volume persistence. After Chromium or font
changes, run browser tests and inspect screenshots rather than relying on the
binary version alone.

Do not put engine tokens, GitHub credentials, project secrets, or provider
configuration into the image. Facility injects short-lived and project-scoped
values when preparing a story.
