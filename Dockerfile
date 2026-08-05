# Multi-stage build for the Facility platform services.
# One image, selectable entrypoint (api | worker | gateway) via the APP arg /
# the start command. Web and docs build separately (Next standalone / static).
#
#   docker build --target api     -t facility/api .
#   docker build --target gateway -t facility/gateway .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl --fail --silent --show-error --location --retry 3 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    --output /etc/ssl/certs/aws-rds-global.pem \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global.pem
RUN corepack enable
WORKDIR /app

# --- deps: install with the full workspace manifest set for cache reuse ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/harness/package.json packages/harness/
COPY packages/run-objective/package.json packages/run-objective/
COPY services/api/package.json services/api/
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter '@facility/core...' \
      --filter '@facility/db...' --filter '@facility/sdk...' \
      --filter '@facility/mcp...' \
      --filter '@facility/harness...' \
      --filter '@facility/api...' --filter '@facility/gateway...'

# --- API build: API + its workspace runtime dependencies ---
FROM deps AS build-api
COPY packages ./packages
COPY services/api ./services/api
COPY tsconfig.base.json ./
# @facility/harness is a runtime dependency of the API (KB validation, the
# Project Owner / learning harness) — it must be built into the image.
RUN pnpm --filter '@facility/core' --filter '@facility/db' \
      --filter '@facility/harness' --filter '@facility/api' run build
# Produce isolated production trees. `deploy --prod` keeps runtime workspace
# dependencies and package assets (including DB migrations) while excluding
# source workspaces, tests, build tools, and every devDependency.
RUN pnpm --filter '@facility/api' deploy --prod --legacy /prod/api
# First-org seeding and repository kickstart both load bundled source assets at
# runtime. Fail the image build if pnpm deployment ever omits either package's
# payload instead of discovering it after a user begins onboarding.
RUN test -f /prod/api/node_modules/@facility/db/dist/seed-assets/packages/harness/contracts/po-agent.md \
  && test -f /prod/api/node_modules/@facility/core/dist/render-assets/packages/cli/templates/watchtower/canary.mjs \
  && test -f /prod/api/node_modules/@facility/core/dist/render-assets/packages/cli/templates/workflows/facility-crew.yml

# --- Gateway build: avoid compiling the much larger API for proxy-only fixes ---
FROM deps AS build-gateway
COPY packages ./packages
COPY services/gateway ./services/gateway
COPY tsconfig.base.json ./
RUN pnpm --filter '@facility/core' --filter '@facility/db' \
      --filter '@facility/gateway' run build
RUN pnpm --filter '@facility/gateway' deploy --prod --legacy /prod/gateway

# --- MCP build: keep SDK/MCP changes independent from API and gateway ---
FROM deps AS build-mcp
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm --filter '@facility/core' --filter '@facility/sdk' \
      --filter '@facility/mcp' run build
RUN pnpm --filter '@facility/mcp' deploy --prod --legacy /prod/mcp

# --- api (also serves the worker via `node dist/worker.js`) ---
FROM base AS api
ENV NODE_ENV=production
COPY --from=build-api /prod/api /app
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
# without a shell to resolve it.
RUN printf '#!/bin/sh\nexec node /app/cli/bin/facility.mjs "$@"\n' > /usr/local/bin/facility \
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
FROM base AS gateway
ENV NODE_ENV=production
COPY --from=build-gateway /prod/gateway /app
EXPOSE 4410
CMD ["node", "dist/start.js"]

# --- MCP streamable-HTTP gateway ---
FROM base AS mcp
ENV NODE_ENV=production
COPY --from=build-mcp /prod/mcp /app
EXPOSE 4420
CMD ["node", "dist/bin/facility-mcp.js", "serve", "--host", "0.0.0.0", "--port", "4420"]
