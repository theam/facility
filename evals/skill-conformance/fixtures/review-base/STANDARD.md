# Engineering standard (fixture)

## Verification ladder (lightest first, escalate by risk)

1. `node guards/run.mjs` — always run.
2. `npm test` — unit tests.
3. `npm run e2e` — full end-to-end; required before any release-affecting change.

## Completion checklist (walk before saying done)

- [ ] guards green
- [ ] unit tests green
- [ ] CHANGELOG.md carries an entry for the change

<!-- facility:modules -->
### analytics
Every exported function must be exercised by at least one test.
<!-- /facility:modules -->
