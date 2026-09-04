# Multi-stage build for the Facility platform services.
# One control-plane image serves API, MCP, webhooks, and the worker entrypoint.
# Web and docs build separately (Next standalone / static).
#
#   docker build --target api     -t facility/api .
FROM node:24-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# Keep a digest-pinned base while still making a reviewed Debian security
# refresh invalidate BuildKit's cached package layer.
ARG DEBIAN_SECURITY_REFRESH=20260828
RUN test -n "$DEBIAN_SECURITY_REFRESH" \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl --fail --silent --show-error --location --retry 3 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    --output /etc/ssl/certs/aws-rds-global.pem \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global.pem
RUN corepack enable
WORKDIR /app

# Deployable services execute Node directly. Keep package managers in the build
# stages, but delete their global dependency trees from the runtime rootfs so
# unused npm/Corepack code cannot become a production CVE surface.
FROM base AS runtime
RUN rm -rf /usr/local/include/node \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /pnpm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm \
    /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/bin/corepack \
  && for tool in npm npx pnpm corepack yarn; do \
    if command -v "$tool" >/dev/null 2>&1; then \
      echo "runtime package manager remains available: $tool" >&2; \
      exit 1; \
    fi; \
  done

# --- deps: install with the full workspace manifest set for cache reuse ---
FROM base AS deps
ENV FACILITY_ALLOW_UNUSED_PATCHES=true
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages/core/package.json packages/core/
COPY packages/agents/package.json packages/agents/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY services/api/package.json services/api/
# The reviewed image-size patch belongs to the docs-only graph. These filtered
# service installs deliberately omit docs, so they may leave that patch unused.
RUN pnpm install --frozen-lockfile --filter '@facility/core...' \
      --filter '@facility/agents...' \
      --filter '@facility/db...' --filter '@facility/sdk...' \
      --filter '@facility/mcp...' \
      --filter '@facility/api...'

# Build the workspace packages used by the control plane once.
FROM deps AS build-service-packages
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm --filter '@facility/core' --filter '@facility/agents' \
      --filter '@facility/db' \
      --filter '@facility/sdk' --filter '@facility/mcp' run build:runtime

# --- API build: API + its workspace runtime dependencies ---
FROM build-service-packages AS build-api
COPY services/api ./services/api
RUN pnpm --filter '@facility/api' run build:runtime
# Produce isolated production trees. Injected workspace packages keep the
# deployed node_modules self-contained; legacy deploy leaves links back to the
# build workspace, which break after /prod/* is copied into the runtime stage.
# Production deploys retain package assets (including the 0.12 DB baseline) while
# excluding source workspaces, tests, build tools, and every devDependency.
RUN pnpm --config.inject-workspace-packages=true \
      --filter '@facility/api' deploy --prod /prod/api
# Fail the image build if the clean database baseline or repository-defined
# agent templates are absent from the portable production deployment.
RUN test -f /prod/api/node_modules/@facility/db/migrations/v0.12/0001_facility_012.sql \
  && test -f /prod/api/node_modules/@facility/db/migrations/v0.12/0002_insights_and_github_mirror.sql \
  && test -f /prod/api/node_modules/@facility/core/dist/render-assets/packages/cli/templates/agents/builder.md

# --- api (also serves the worker via `node dist/worker.js`) ---
FROM runtime AS api
ENV NODE_ENV=production
COPY --from=build-api /prod/api /app
# Validate the final runtime filesystem, after the build workspaces are gone.
# This catches portable-deploy regressions that a build-stage file check cannot.
RUN test -f /app/node_modules/@facility/db/dist/bin/deploy.js \
  && node --input-type=module --eval 'await import("@facility/db/deploy")'
# The CLI travels with the API image so operator commands can be run as one-shot
# tasks inside the VPC. `facility instance bootstrap` needs the database, and in
# a reference deployment the database accepts connections only from the service
# security group — there is nowhere else to run it from. The package is a few
# hundred kilobytes of plain ESM whose only dependency, `postgres`, is already
# here for @facility/db.
COPY --from=build-api /app/packages/cli /app/cli
# Operator commands read as `facility …` inside the image, the way they read
# everywhere else, instead of as a path into it. A wrapper rather than a symlink
# because the checked-in bin is not executable, and an ECS command override runs
# without a shell to resolve it. Bootstrap is followed by idempotent role
# reconciliation in the same one-shot task.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'if [ "${1:-}" = "instance" ] && [ "${2:-}" = "bootstrap" ] && [ "${3:-}" != "--help" ]; then' \
    '  node /app/cli/bin/facility.mjs "$@"' \
    '  FACILITY_SEED_DEMO=0 exec node /app/node_modules/@facility/db/dist/bin/deploy.js' \
    'fi' \
    'exec node /app/cli/bin/facility.mjs "$@"' \
    > /usr/local/bin/facility \
  && chmod +x /usr/local/bin/facility
# Regression guard for the deployed operator path. Exec form on purpose: it
# resolves `facility` the way the container runtime does for an ECS command
# override, with no shell in between, so the guard exercises the same lookup the
# runbook depends on. Reaching the command proves the PATH entry, and importing
# it proves that its production `postgres` dependency resolves.
RUN ["facility", "instance", "bootstrap", "--help"]
EXPOSE 4400
CMD ["node", "dist/start.js"]
