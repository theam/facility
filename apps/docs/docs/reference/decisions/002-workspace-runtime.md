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
  wake(id: string): Promise<WorkspaceHandle>;
  exec(id: string, command: Command): Promise<CommandResult>;
  expose(id: string, ports: PortSpec[]): Promise<PreviewEndpoint[]>;
  inspect(id: string): Promise<WorkspaceInspection>;
  suspend(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
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
