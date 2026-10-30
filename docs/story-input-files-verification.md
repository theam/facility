# Story input files — implementation verification

Verified locally on 2026-10-30, based on `7570971` (current `main` at preparation).
No deployment, real customer-file transfer, or paid agent turn was performed.

## Implemented boundary

An authorized person or MCP client prepares a story-scoped upload, sends bounded
binary bytes using a ten-minute single-file capability, then explicitly sends a
message containing completed file IDs. Metadata is stored in PostgreSQL; bytes
remain outside Git in the existing durable workspace volume. The native dispatcher
verifies availability and passes a compact manifest, not inline contents.

Preparing or transferring a file does not approve a plan, queue inference, import
knowledge, or authorize publication. Metadata reads do not wake compute. A sleeping
workspace requires explicit resume consent for a transfer. No-tools consultations
remain text-only.

## Automated verification

- `pnpm lint`, `pnpm typecheck`, and `pnpm build:clean`.
- All database, CLI, and critical API suites, run directly without cached results
  or accepted skips. The API files were enumerated in the same order as
  `scripts/test-critical.mjs`, with the same Docker-suite exclusion. A subsequent
  full dispatcher run includes manifest/missing-file and pre-engine retry regressions.
- `pnpm test:uncached`; the final web suite has 204 passing tests.
- The 18 focused file HTTP/storage/provider tests cover byte/hash mismatch,
  actual streamed-size limits (including no Content-Length), grant replay and
  expiry, revocation, cross-org/project/story denial, path and symlink rejection,
  quota reservation/release, deletion races, and explicit compute resumption.
- `pnpm check:unused`, `pnpm guards`, and the committed migration-range check.
- `pnpm audit --audit-level low` exits successfully under the repository's existing
  policy. Two pre-existing high-severity exceptions remain; this change adds no
  external dependency or scanner exception.

## Review follow-up

Three independently reviewed defects have regression coverage:

- Provider writes now use a private per-file staging directory owned by the
  command user. Docker can write a root-owned child without preventing cleanup.
  Cleanup exit status is checked; a failed cleanup does not mark the upload
  available. Explicit discard removes matching interrupted-transfer staging
  before releasing its reservation. The real Docker test checks copies before
  compute replacement and after a simulated cleanup failure and discard.
- An attention retry preserves only the failed request's attachment IDs and
  revalidates them. A removed file rejects the retry rather than silently losing
  its manifest. Both pre-engine setup-failure cases run in the dispatcher suite
  (32 passing tests), without real inference.
- OpenAPI declares octet-stream request/response bodies. The SDK supports binary
  PUT bodies and ArrayBuffer downloads without JSON conversion; single-use
  binary uploads are not automatically retried. Its 18 passing tests include a
  local HTTP round trip. API integration also runs the SDK through the real
  Fastify handlers. A development workspace link to the existing SDK supports
  that test; no external package was added.

The local critical suites used a dedicated disposable PostgreSQL container on
port 5469. The literal `pnpm verify` wrapper was not used: it targets the shared
developer PostgreSQL port 5461 and recreates databases. Its stages were run
separately against the owned disposable databases instead. The standard CI
verifier is unchanged and remains required.

## Docker acceptance

The current runner source was built without bypassing checks:

```sh
docker build -f runner/Dockerfile -t facility-runner:f13-input-files .
FACILITY_E2E_DOCKER=1 \
FACILITY_WORKSPACE_TEST_IMAGE=facility-runner:f13-input-files \
DATABASE_URL=postgres://facility:facility@127.0.0.1:5469/facility_ws \
pnpm test:e2e-workspace
```

Result: **3 files, 16 tests passed; no skips**. The new case verifies binary
transfer, retention across suspension and compute replacement, physical removal,
and scoped destruction. The complete existing workspace loop also ran.

Local runner image (Linux arm64) manifest:
`sha256:25c6fddd66a951550ee7ae9f6405d70d60f80fbdcb450b357781229836274fb1`.
An earlier Go-proxy connection failure was resolved by a later build after an
explicit container-network availability check; no dependency or network checks
were disabled. The earlier focused run with an existing image is not substituted
for this full acceptance result.

## Browser check

The integrated browser used a temporary localhost page rendering the real input
component, the normal Next.js API proxy, Fastify routes and a fake workspace
backed by actual local files and a separate disposable database. No production
session or external agent was connected. The temporary harness was removed.

Observed: loading, authentication-required denial, empty inventory, successful
binary upload and selected available reference, missing-story denial, and private
attachment download. The downloaded synthetic JSON exactly matched the original:

`7cdd6731f4f41c6df15bdde5b304b67ac26c9179c6686bce2d1c20c2496845dd`

Automated composer coverage separately checks that selected references survive
draft restoration and hiding the panel, and are included in the explicit send.

## Remaining acceptance boundaries

- Human review and merge/deployment are separate, not performed here.
- The dispatcher regression uses a deterministic native-engine fake. It proves
  verified-byte availability and manifest handoff, not that a real model read or
  understood the document. A post-deployment authorized story must check that.
- Vercel binary APIs and session fencing have deterministic provider coverage;
  live Vercel transfer/retention still needs an authorized acceptance workspace.
- Private GitHub issue-attachment download with the actual installation-token
  flow has not been verified. This is not advertised as a supported input route,
  and no arbitrary-URL proxy was added. Manual stories need no GitHub issue.
- Original documents, knowledge import and model evaluation are outside this
  feature's acceptance; an exported chunk/metadata wrapper is not a restore file.
