---
title: Knowledge & the Project Owner
---

# Knowledge base & the Project Owner agent

Every project can run a **Project Owner agent**: a scheduled, sandboxed agent
that owns the project's domain knowledge and turns validated needs into
implementation-ready tasks. Its harness combines narrow recoverable state,
typed knowledge artifacts, mechanical validation, and human approval gates.

## The knowledge base

Typed, linked, validated at write time:

- **Signal** — something observed, with evidence and a named source.
- **Decision** — what we'll do and why, grounded in signals, confirmed by a
  human where it matters.
- **Task** — implementation-ready work derived from a decision: problem,
  evidence, sketch, acceptance criteria, WSJF score.
- **Verification** — the closed loop on shipped work: what actually changed
  for users. Merged is not verified.
- **Reference** — curated documentation (architecture, conventions, runbooks).
  Free; no parent required.
- **Learning** — a durable lesson from delivery or review, stored as `L` in a
  Product workspace. Free; no parent required. Research workspaces reuse `L`
  for **Literature** notes instead — the prefix is the same, the meaning
  follows the space's chain.

The platform enforces the chain mechanically — a task without a decision, a
verification without a shipped task, a missing backlink: rejected at write
time, not discovered in review. The `ACTIVE` state note stays deliberately
narrow (objective, next step, blocker, links) so sessions recover cleanly
every time.

The chain a space runs is part of that contract. Reconfiguring it is refused
while an entry already stored would be left undeclared — the refusal names the
entries and the stored config stays as it was — so a chain switch can never
strand what was legitimately written under the previous one.

## Task flow

The PO agent proposes tasks; humans accept them in the inbox; the platform
opens the GitHub issue with a KB trace and places it on the board. From there
the normal loop applies — `/architect`, gate 1, `/builder`, gate 2 — and the
verification entry closes the circle back into the knowledge base.

## Learning mode

Nightly, per project, a learning agent studies the day — receipts, reviews,
failures, rejected proposals — and drafts improvements: a skill edit, a rule,
a guard candidate, a knowledge entry. Five proposals a night, maximum, each
with evidence and an expected effect. Every one is validated by a human
before it becomes real.

Approved skill, rule, and knowledge amendments remain versioned Facility
registry/KB changes. Approved guard candidates and other repository work are
different: Facility creates or updates one fingerprinted GitHub task, links the
proposal and evidence, and stops. The task then follows the ordinary
`/architect` → plan approval → `/builder` path. Learning does not write product
code or open an implementation pull request directly. The ratchet turns;
people hold the handle.
