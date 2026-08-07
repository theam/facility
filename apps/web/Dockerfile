# Facility web (Next.js standalone). Built once; FACILITY_API_URL is supplied
# when the container starts so the same artifact works in every installation.
#   docker build -f apps/web/Dockerfile -t facility/web .
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# Keep dependency resolution keyed to the lockfile and relevant workspace
# manifests. UI/source/docs edits can then reuse this expensive install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/run-objective/package.json packages/run-objective/
COPY packages/sdk/package.json packages/sdk/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter '@facility/web...'
COPY apps/web apps/web
COPY packages/run-objective packages/run-objective
COPY packages/sdk packages/sdk
COPY packages/ui packages/ui
COPY tsconfig.base.json ./
ENV NEXT_TELEMETRY_DISABLED=1
# The web imports the SDK's published workspace entrypoint (`dist/index.js`). A
# clean image has no SDK artifact, so build it before Next consumes the output.
RUN pnpm --filter '@facility/sdk...' run build && pnpm --filter '@facility/web' build

FROM base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3400 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3400
CMD ["node", "apps/web/server.js"]
