---
title: "ADR 004: Claude and Codex credentials"
---

# ADR 004: Claude and Codex credentials

Status: accepted for Facility 0.12

## Decision

Claude Code and Codex use their native environment-based credentials. Their secret names are
declared in `.facility.yml`; operators supply the values through the control service's secret
environment under `FACILITY_PROJECT_<PROJECT_ID>_<NAME>`. Facility resolves only that
project-scoped operator name for an authorized turn and injects the value under the logical name
declared by the repository into setup, services, and the selected engine process. A repository
cannot select arbitrary control-plane variables by naming them. The repository stores names, never
values. Facility does not write those values into the persistent workspace, conversation, turn
output, logs, or artifacts.

Claude stores its native session files under a workspace-persistent `CLAUDE_CONFIG_DIR`. Codex
stores its rollouts under a workspace-persistent `CODEX_HOME`. Facility records opaque session ids
and resumes a compatible session on later turns. Changing engine, model, or agent may create a new
session, but never deletes an earlier one.

The current model gateway, virtual run keys, and budget enforcement are removed after both native
adapters pass the continuation suite.

## Trust boundary

An agent with full shell access can read credentials supplied to its own process. This follows the
product's trusted-maintainer model. The mitigations are operator-managed secret storage, per-turn
injection, redaction before persistence, revocation and rotation, and no cross-project credential.
Facility does not claim that a proxy callable by the same full-access agent prevents exfiltration.

Revoking or rotating a provider credential changes the value supplied to the next turn. It does not
delete `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the database session reference, or the worktree. A native
session that the provider no longer accepts is retained as corrupt and replaced in the same
workspace.

## Evidence

Fake Claude Code and Codex executables verify exact model and reasoning-effort arguments, first-run
and resume syntax, streaming, cancellation, malformed output, and corrupt-session replacement. The
project-environment and dispatcher tests inject declared secrets, deliberately echo them from a
fake engine, and verify that persisted messages, events, errors, and API responses contain only the
redaction marker. A denial-path integration test declares `DATABASE_URL` and verifies that the
unscoped control-plane value is never injected.

## Alternatives tested

- Persisting a CLI login inside the workspace was rejected as the primary credential mechanism
  because deleting or rotating the control-plane secret would not revoke that copy.
- The former gateway and virtual-key path was tested by earlier releases and rejected for 0.12
  because a full-access agent could call around a proxy while the extra budget and receipt model
  complicated native-session use.

## Ownership boundary

Operators own provider accounts, secret injection, revocation, and rotation. Facility owns
per-turn delivery, redaction, and durable session references. Claude Code and Codex own their native
session format and decide whether a session remains resumable after credential rotation.

## Revisit when

Add a dedicated project secret store only when it can preserve the same revocation and redaction
contract without making database values a second repository configuration source. Revisit native
environment authentication if either engine stops supporting non-persistent credentials.
