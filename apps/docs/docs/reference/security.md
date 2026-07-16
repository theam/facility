---
title: Security model
---

# Security model

Security and privacy are first-class concerns; this page is the contract.

## Identity & access

- Humans: WorkOS SSO (AuthKit). Machines: argon2id-hashed API keys bound to
  roles. One permission catalog for web, CLI, MCP, and agents; deny by
  default; every route declares its permission and the startup assertion
  refuses undeclared routes.
- Custom roles are named permission sets — no side-channel authority.

## Secrets

- **Stored secrets** — provider API keys and integration signing secrets are
  sealed (libsodium) with a master key from your secret manager/KMS, decrypted
  only in the service that needs them, and never returned by any API.
- **Service credentials** — the GitHub App private key and WorkOS credentials
  are supplied to the services as environment variables from your secret
  manager; the platform reads them at boot and does not persist them in its
  database.
- Sandboxes receive no provider secrets — only run-scoped virtual keys and
  short-lived repo tokens fetched after boot.

## Webhooks and outbound network safety

- Facility-signed inbound events bind timestamp, delivery id, event type, and
  exact body bytes into HMAC-SHA256. The receiver enforces a five-minute replay
  window and integration-scoped delivery deduplication.
- Outbound webhooks require HTTPS outside insecure development, reject URL
  credentials and private/reserved IPv4/IPv6 answers, pin the validated address
  for the connection, disable redirects, and use a ten-second deadline. The
  durable outbox gives at-least-once delivery with bounded retry and visible dead
  letters.
- Remote MCP validates `Host` and browser `Origin`, requires a non-empty Bearer
  credential, bounds JSON bodies, and forwards the caller credential to the API;
  it has no privileged service identity.

## Untrusted text

Issue, PR, review, and comment text is data, never instructions — the rule
holds in webhook handlers (no interpolation into shell/prompts/SQL), in
operating contracts, and in the rendered workflows (jq event parsing,
start-of-line slash commands, bot-refusal, message-hash canary
authorization). The fifteen production hardening notes ship encoded in
templates, handlers, and guards — not as advice.

## Audit & privacy

- Append-only, hash-chained audit log; tamper evidence is a query.
- Store-everything default (envelopes, transcripts). Expiry is by the object
  store's lifecycle policy — configured by our AWS Terraform, and operator-
  configured for other S3-compatible stores; there is no app-level enforcement yet
  (a per-org `retention_days` setting is recorded; app-enforced per-org expiry is a
  follow-up). Access is gated by permission + project scope — the full transcript
  needs `audit:read`.
- Receipts and analytics are metrics-only: no prompts, no code, hashed
  actors. Self-hosted telemetry to the vendor: none.

## The invariants that never move

Agents never approve, never merge, never push to protected branches. Every
outward action carries a named principal. Every merge carries a human
decision.

Report vulnerabilities per [SECURITY.md](https://github.com/theam/facility/blob/main/SECURITY.md).
