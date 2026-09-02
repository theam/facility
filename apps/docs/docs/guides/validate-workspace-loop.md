---
title: Validate the workspace loop
---

# End-to-end validation

Use a disposable private repository or mirror. Do not use a production repository for the first
acceptance run.

1. Start Facility with a fresh 0.12 database and build the runner image.
2. Connect the repository and merge its kickstart configuration PR.
3. Call `facility_start_story` with a stable external id, an agent name, a message, and a new
   idempotency key. Repeat the same call and verify that it returns the same story and workspace.
4. Wait for the first turn. Confirm the effective engine and model match `.agents/<name>.md`.
5. Ask the agent to write an uncommitted marker, start the declared environment, and run a browser
   check against the application.
6. Suspend the story, remove or replace its compute container, restore it, and verify the marker,
   dependencies, Git state, conversation, and native engine session remain.
7. Open an authenticated preview. Test HTTP navigation and one WebSocket path from another browser
   session. Revoke or expire it and verify access stops.
8. Continue the story with another authorized user and, optionally, another configured agent.
   Confirm both use the same conversation and worktree.
9. Have the agent create a normal commit, push the story branch, and open a pull request using
   `git` and `gh`.
10. Deliver the same GitHub webhook twice. Confirm repository-defined triggers create one queued
    message or turn.
11. Trigger a due scheduled agent from two scheduler workers. Confirm only one activation and one
    stable scheduled story.
12. Merge the test pull request. Confirm the story becomes done and compute sleeps while the
    workspace, worktree, sessions, and messages still exist.
13. Archive and restore the story. Confirm its state remains. Finally use the explicit delete tool
    with matching confirmation and idempotency key, then verify the durable volume is gone.

Run the repository suite as supporting evidence:

```bash
FACILITY_E2E_DOCKER=1 FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:dev pnpm verify
```

Record exact commands, commit and PR URLs, preview checks, and database assertions. A model's prose
claim is not acceptance evidence.
