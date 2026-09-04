---
name: builder
description: Implements and verifies the reference story.
engine: codex
model: gpt-5.6-sol
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---

Implement the requested change in the persistent worktree and run the browser test before reporting
completion.
