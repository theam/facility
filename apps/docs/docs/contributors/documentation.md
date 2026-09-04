---
title: Documentation
---

# Writing and maintaining documentation

Documentation is part of Facility's supported interface. A code change is incomplete when a user,
operator, client author, or contributor cannot discover and operate the resulting behavior.

## Audiences and page types

- **Concepts** explain why Facility behaves as it does and how parts relate.
- **Guides** lead a user through one real outcome, including prerequisites, validation, and recovery.
- **Reference** states exact fields, routes, tools, states, defaults, limits, and error behavior.
- **Self-hosting** covers installation, configuration, security, upgrades, backups, monitoring, and
  incidents.
- **Contributor** pages map code ownership, tests, and documentation maintenance.
- **Decision records** preserve choices and consequences that future changes must evaluate.

Do not combine all audiences into one large overview. Link from the overview to a stable reference
instead of duplicating a schema in several guides.

## Required coverage for a behavior change

Update the relevant reference and at least one path that tells a user how to use or operate the
behavior. Include:

- prerequisites and permissions;
- successful flow;
- persistent state and lifecycle effects;
- failure and denial behavior;
- destructive or irreversible actions;
- security and secret implications;
- cost, budget, observability, analytics, audit, or mirror effects when relevant;
- verification evidence; and
- upgrade or compatibility notes.

If the web UI and MCP expose the same capability, document the shared behavior once and link from
both surface references. Do not imply that removing a separate service removes the underlying
functional capability.

## Source of truth

Verify exact claims against code: Zod schemas for manifests and routes, runtime interfaces for
lifecycle, configuration parsing for environment variables, migrations for persisted state, and
tests for denial behavior. OpenAPI at `/docs` is authoritative for HTTP body and response schemas;
the handwritten API reference explains resource grouping and cross-cutting rules.

Examples must parse and use values accepted by current code. Avoid model or provider claims that
the repository cannot verify. When a provider reports no price or scanner data, use “unavailable,”
not “free” or “clean.”

## Style

Lead with the action or contract. Use direct sentences, concrete nouns, and normal transitions.
Prefer small examples that a reader can adapt. Avoid slogans, fake quotations, repetitive
summaries, and claims that something is easy or complete without evidence.

Use `Facility`, `MCP`, `GitHub`, `Claude Code`, `Codex`, `Docker`, `Vercel Sandbox`, and
`PostgreSQL` consistently. Use `story`, `turn`, `workspace`, `agent`, and `project` according to the
[lifecycle reference](../reference/lifecycle.md).

Never put private repository names, customer details, deployment addresses, tokens, private issue
context, or internal planning in public docs, examples, fixtures, screenshots, PR descriptions, or
test output.

## Links and navigation

Add each published page to `apps/docs/sidebars.ts`. Use relative `.md` links between documentation
pages so the local link guard can resolve them. Use stable public URLs for files outside the docs
site. After moving a page, update inbound links and add a redirect if an existing published URL must
remain valid.

The index should let users choose a user, operator, reference, or contributor path. Every detailed
page should link to the next operational step rather than ending at an isolated description.

## Verification

Run:

```bash
pnpm --filter @facility/docs test
pnpm --filter @facility/docs build
node guards/markdown-links.mjs
```

Preview changed routes and sidebar order in the docs development server. The documentation contract
test protects required subjects and exact schema fields. Add a durable assertion when introducing a
new public contract; do not use line count as a quality proxy.

Review documentation in the same pull request as behavior whenever possible. If implementation and
documentation must land separately, the implementation PR should identify the exact follow-up and
must not present undocumented behavior as ready for users.
