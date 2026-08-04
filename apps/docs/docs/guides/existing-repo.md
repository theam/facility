---
title: Adopt an existing repo
---

# Adopt an existing repository

Repositories that already run the vendored Facility system (or its
predecessors) adopt the platform incrementally — nothing breaks on day one.

## Step 1 — import

Connect the repo to a project. The platform detects vendored facility files
and records the current state as the fingerprint baseline (**adopt**), so
integrity checking starts from reality, not from an ideal.

## Step 2 — money first

Switch the repo's provider secrets to gateway virtual keys
(`ANTHROPIC_BASE_URL` in the workflow env + a project key). Same agents, same
workflows — now with budgets, attribution, and envelopes. This is the
highest-value, lowest-risk move.

## Step 3 — telemetry

Point the receipt collector's sink at the platform ingest endpoint (the
`facility.run.v1` schema remains compatible with the legacy receipt schema, so
existing collectors keep working). Outcomes, health, and analytics light up.

## Step 4 — lanes, one trigger at a time

Per command, choose the execution lane: keep `/builder` in repo CI, move the
weekly security sweep to a platform sandbox, run the new Project Owner agent
platform-side. Each flip is reversible; the vendored workflows remain the
fallback.

Declare those choices in `.facility.json` under `executionLane`. A push to the
default branch synchronizes the reviewed manifest into the control plane. An
unset agent remains on the `repo` lane, so adoption fails closed and does not
start duplicate automation.

Platform sandboxes clone the repository before starting the agent. Checked-in
`AGENTS.md`, `CLAUDE.md`, hooks, commands, guards, and skills therefore remain
available. If a repository skill and a Facility catalog skill have the same
name, the checked-in repository skill wins.

## Step 5 — upgrades

From now on, method updates arrive as upgrade PRs from the platform instead
of re-running an installer — reviewed, three-way merged, fingerprinted.
