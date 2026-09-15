---
title: The story loop
---

# The story loop

The normal Facility workflow is a loop around one durable story, not a chain of disposable agent
jobs.

## 1. Start from work that matters

A user starts an ad hoc story or a story linked to a GitHub issue. A GitHub trigger or schedule can
also create or continue a stable story. Facility records the source, title, initial message,
selected agent, and an idempotency key before dispatching work.

## 2. Prepare the workspace

Facility creates or wakes one workspace and checks out the primary and related repositories. It
runs `environment.setup` when the environment contract has changed or a clean setup was requested,
then runs `environment.seed` when setup is due. It starts the complete development environment and
waits for the optional readiness command.

The repositories live under `repos/<owner>/<repository>` in the workspace. The story branch,
dependencies, native engine state, and project artifacts use the durable volume rather than the
replaceable compute instance.

## 3. Run an agent turn

The dispatcher loads the selected agent at an exact primary-repository commit, checks its trigger,
and records the engine, model, options, and manifest hash. Claude Code or Codex then continues the
story with full access to the configured repositories and environment.

An agent may ask for user input. Facility moves the story to `attention` and preserves the live
conversation. The user can reply, retry a failed turn, dismiss an obsolete attention item, or
cancel active work.

## 4. Inspect the actual result

The agent and user can run unit, integration, and browser checks in the workspace. Declared
services are exposed through Facility's authenticated preview proxy, so a user can test the exact
environment from another browser without producing a separate preview build.

Environment events, readiness duration, provider failures, retained storage, and available
provider usage are visible through the UI, MCP, and API. Browser checks can retain screenshots,
logs, and other files as story artifacts.

## 5. Deliver through GitHub

The agent uses normal Git and GitHub operations to create commits, push the story branch, and open
or update a pull request. CI and review can activate configured agents in the same story and
workspace. GitHub events also refresh Facility's issue, pull-request, check, and workflow mirror.

## 6. Retain or remove deliberately

After merge, Facility marks the story done and suspends compute. A user may archive and later
restore it, or continue the conversation if follow-up work is needed. The worktree and engine
session remain available.

Only explicit workspace deletion destroys durable execution state. See the [lifecycle
reference](../reference/lifecycle.md) for exact states and operations.
