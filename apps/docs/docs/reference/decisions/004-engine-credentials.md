---
title: "ADR 004: Claude and Codex credentials"
---

# ADR 004: Claude and Codex credentials

Status: accepted for Facility 0.12

## Decision

Claude Code and Codex use their native credentials. Facility stores configured provider
credentials encrypted in the control plane, decrypts only for an authorized turn, and injects them
into that engine process. Credentials are never written into the persistent workspace, conversation,
turn output, logs, or artifacts.

Claude stores its native session files under a workspace-persistent `CLAUDE_CONFIG_DIR`. Codex
stores its rollouts under a workspace-persistent `CODEX_HOME`. Facility records opaque session ids
and resumes a compatible session on later turns. Changing engine, model, or agent may create a new
session, but never deletes an earlier one.

The current model gateway, virtual run keys, and budget enforcement are removed after both native
adapters pass the continuation suite.

## Trust boundary

An agent with full shell access can read credentials supplied to its own process. This follows the
product's trusted-maintainer model. The mitigations are encrypted control-plane storage, per-turn
injection, redaction before persistence, revocation and rotation, and no cross-project credential.
Facility does not claim that a proxy callable by the same full-access agent prevents exfiltration.
