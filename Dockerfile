# Multi-stage build for the Facility platform services.
# One image, selectable entrypoint (api | worker | gateway) via the APP arg /
# the start command. Web and docs build separately (Next standalone / static).
#
#   docker build --target api     -t facility/api .
#   docker build --target gateway -t facility/gateway .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
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
COPY services/api/package.json services/api/
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter '@facility/core...' \
      --filter '@facility/db...' --filter '@facility/sdk...' \
      --filter '@facility/mcp...' \
      --filter '@facility/harness...' \
      --filter '@facility/api...' --filter '@facility/gateway...'

# --- build TS to dist ---
FROM deps AS build
COPY packages ./packages
COPY services ./services
COPY tsconfig.base.json ./
# @facility/harness is a runtime dependency of the API (KB validation, the
# Project Owner / learning harness) — it must be built into the image.
RUN pnpm --filter '@facility/core' --filter '@facility/db' --filter '@facility/sdk' \
      --filter '@facility/mcp' \
      --filter '@facility/harness' \
      --filter '@facility/api' --filter '@facility/gateway' run build
# Produce isolated production trees. `deploy --prod` keeps runtime workspace
# dependencies and package assets (including DB migrations) while excluding
# source workspaces, tests, build tools, and every devDependency.
RUN pnpm --filter '@facility/api' deploy --prod --legacy /prod/api \
  && pnpm --filter '@facility/gateway' deploy --prod --legacy /prod/gateway \
  && pnpm --filter '@facility/mcp' deploy --prod --legacy /prod/mcp

# --- api (also serves the worker via `node dist/worker.js`) ---
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /prod/api /app
EXPOSE 4400
CMD ["node", "dist/start.js"]

# --- gateway ---
FROM base AS gateway
ENV NODE_ENV=production
COPY --from=build /prod/gateway /app
EXPOSE 4410
CMD ["node", "dist/start.js"]

# --- MCP streamable-HTTP gateway ---
FROM base AS mcp
ENV NODE_ENV=production
COPY --from=build /prod/mcp /app
EXPOSE 4420
CMD ["node", "dist/bin/facility-mcp.js", "serve", "--host", "0.0.0.0", "--port", "4420"]
