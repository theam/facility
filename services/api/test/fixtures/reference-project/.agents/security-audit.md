---
name: security-audit
description: Repeats the reference security audit in one durable story.
engine: claude_code
model: claude-opus-4-8
enabled: true
options: {}
triggers:
  - type: schedule
    name: weekly
    cron: "0 8 * * 1"
    timezone: UTC
---

Audit the current worktree, compare findings with the earlier conversation, and report only
evidence-backed changes.
