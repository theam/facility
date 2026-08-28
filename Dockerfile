# Multi-stage build for the Facility platform services.
# One image, selectable entrypoint (api | worker | gateway) via the APP arg /
# the start command. Web and docs build separately (Next standalone / static).
#
#   docker build --target api     -t facility/api .
#   docker build --target gateway -t facility/gateway .
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
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/harness/package.json packages/harness/
COPY packages/run-objective/package.json packages/run-objective/
COPY services/api/package.json services/api/
COPY services/gateway/package.json services/gateway/
# The reviewed image-size patch belongs to the docs-only graph. These filtered
# service installs deliberately omit docs, so they may leave that patch unused.
RUN pnpm install --frozen-lockfile --filter '@facility/core...' \
      --filter '@facility/db...' --filter '@facility/sdk...' \
      --filter '@facility/mcp...' \
      --filter '@facility/harness...' \
      --filter '@facility/api...' --filter '@facility/gateway...'

# Build the workspace packages shared by the three service images once. Bake
# requests API, gateway, and MCP concurrently; keeping this as one graph vertex
# prevents three Core builds and two DB builds from competing for memory.
FROM deps AS build-service-packages
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm --filter '@facility/core' --filter '@facility/db' \
      --filter '@facility/harness' --filter '@facility/sdk' run build:runtime

# --- API build: API + its workspace runtime dependencies ---
FROM build-service-packages AS build-api
COPY services/api ./services/api
RUN pnpm --filter '@facility/api' run build:runtime
# Produce isolated production trees. Injected workspace packages keep the
# deployed node_modules self-contained; legacy deploy leaves links back to the
# build workspace, which break after /prod/* is copied into the runtime stage.
# Production deploys retain package assets (including DB migrations) while
# excluding source workspaces, tests, build tools, and every devDependency.
RUN pnpm --config.inject-workspace-packages=true \
      --filter '@facility/api' deploy --prod /prod/api
# First-org seeding and repository kickstart both load bundled source assets at
# runtime. Fail the image build if pnpm deployment ever omits either package's
# payload instead of discovering it after a user begins onboarding.
RUN test -f /prod/api/node_modules/@facility/db/dist/seed-assets/packages/harness/contracts/po-agent.md \
  && test -f /prod/api/node_modules/@facility/core/dist/render-assets/packages/cli/templates/watchtower/canary.mjs \
  && test -f /prod/api/node_modules/@facility/core/dist/render-assets/packages/cli/templates/workflows/facility-crew.yml

# --- Gateway build: avoid compiling the much larger API for proxy-only fixes ---
FROM build-service-packages AS build-gateway
COPY services/gateway ./services/gateway
RUN pnpm --filter '@facility/gateway' run build:runtime
RUN pnpm --config.inject-workspace-packages=true \
      --filter '@facility/gateway' deploy --prod /prod/gateway

# --- MCP build: keep SDK/MCP changes independent from API and gateway ---
FROM build-service-packages AS build-mcp
RUN pnpm --filter '@facility/mcp' run build:runtime
RUN pnpm --config.inject-workspace-packages=true \
      --filter '@facility/mcp' deploy --prod /prod/mcp

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
# without a shell to resolve it. Bootstrap is followed in the same one-shot task
# by idempotent reconciliation: the initial deploy necessarily seeded while no
# organization existed, so its org-scoped profiles/contracts did not exist yet.
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

# --- gateway ---
FROM runtime AS gateway
ENV NODE_ENV=production
COPY --from=build-gateway /prod/gateway /app
EXPOSE 4410
CMD ["node", "dist/start.js"]

# --- MCP streamable-HTTP gateway ---
FROM runtime AS mcp
ENV NODE_ENV=production
COPY --from=build-mcp /prod/mcp /app
EXPOSE 4420
CMD ["node", "dist/bin/facility-mcp.js", "serve", "--host", "0.0.0.0", "--port", "4420"]
