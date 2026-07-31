# Documents about building Facility

This directory holds the documents that only matter if you are working *on*
Facility — what verification has to prove before a change is releasable, and
what happens when one is merged.

Everything about *using* Facility — the method, the concepts, the guides, the
reference, self-hosting — lives in [`apps/docs`](../apps/docs), which is the
published documentation site. If you are writing something a user would read,
it belongs there.

- [`testing.md`](testing.md) — the two acceptance tiers and the sandbox E2E
  policy. A green fast test run is not release evidence.
- [`releasing.md`](releasing.md) — how merging to `main` publishes, how to
  recover a failed run, and the one-time bootstrap steps. Maintainers only.
