---
title: "ADR 002: Workspace runtime primitive"
---

# ADR 002: Workspace runtime primitive

Status: accepted for Facility 0.12

## Decision

A workspace runs in one isolated Linux compute instance with a persistent writable filesystem. It
contains the checked-out repositories, dependency caches, Claude and Codex homes, project services,
and browser artifacts. Compute is replaceable; the filesystem is not.

The workspace image includes Git, GitHub CLI, Claude Code, Codex, Docker Engine, Compose, and a
headless browser. Hosted workspaces run Docker inside their microVM. Local workspaces use a
container with a named volume and a sidecar Docker daemon scoped to that workspace; Facility never
mounts the host Docker socket into agent compute.

Each workspace receives its own network, compute identity, and storage identity. It can reach the
internet and the repositories configured for its project. It cannot address another workspace's
volume or control socket.

## Runtime contract

The control plane depends on these operations only:

```ts
interface WorkspaceRuntime {
  create(input: CreateWorkspace): Promise<WorkspaceHandle>;
  wake(workspace: WorkspaceLocator): Promise<WorkspaceHandle>;
  exec(workspace: WorkspaceLocator, command: WorkspaceCommand): Promise<WorkspaceCommandResult>;
  expose(workspace: WorkspaceLocator, ports: WorkspacePort[]): Promise<PreviewEndpoint[]>;
  inspect(workspace: WorkspaceLocator): Promise<WorkspaceInspection>;
  suspend(workspace: WorkspaceLocator): Promise<void>;
  destroy(workspace: WorkspaceLocator): Promise<void>;
}
```

`suspend` cannot remove storage. `destroy` is the only runtime method allowed to remove durable
state. Repository-wide tests enforce that no merge, archive, inactivity, schedule, or reconciliation
path calls it.

## Security posture

Running Compose requires more capability than the old single-run container. This is intentional.
The compensating boundaries are microVM or container isolation, no host Docker socket, a dedicated
network and volume, resource limits, tenant-scoped control-plane calls, and short-lived credentials.
The agent is trusted as a repository maintainer inside that boundary.

## Evidence

The Docker test starts an unprivileged agent command, a workspace-scoped Docker daemon, three
Compose services, and Chromium. It cancels a long-running command without stopping the services,
removes and replaces the compute container, reattaches the named volume, and reads the prior Git and
session bytes. The fake runtime covers retries, invalid paths, cancellation, recovery after process
restart, and idempotent deletion.

## Alternatives tested

- Binding commands directly to the host filesystem was used by the fake and rejected as a runtime
  because it has no isolation.
- Keeping data in the compute container was rejected by the replacement test. A separately named
  volume is required for the test to pass.
- Mounting the host Docker socket was rejected in favor of a workspace-scoped daemon because the
  socket would allow the agent to control unrelated host containers and volumes.

## Ownership boundary

The application layer owns state transitions and calls only this interface. Runtime adapters own
provider references, command execution, port discovery, and compute/storage operations. Project
commands own the processes they start inside the workspace.

## Revisit when

Change the primitive only if the selected provider cannot preserve volume identity across compute
replacement, cannot safely support Compose and Chromium, or exposes a narrower isolation mechanism
that passes the same fixture.
