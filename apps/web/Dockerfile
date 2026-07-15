# Facility web (Next.js standalone). Built from the repo root:
#   docker build -f apps/web/Dockerfile -t facility/web .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter '@facility/web...'
ENV NEXT_TELEMETRY_DISABLED=1
# The web imports the SDK's published workspace entrypoint (`dist/index.js`),
# while SDK declarations derive types from DB. A clean image has none of those
# workspace artifacts, so build the full SDK dependency closure first.
RUN pnpm --filter '@facility/sdk...' run build && pnpm --filter '@facility/web' build

FROM base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3400 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3400
CMD ["node", "apps/web/server.js"]
