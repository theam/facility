# Facility web (Next.js standalone). Built once; FACILITY_API_URL is supplied
# when the container starts so the same artifact works in every installation.
#   docker build -f apps/web/Dockerfile -t facility/web .
FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# The standalone server needs Node, not the package managers used to build it.
# Removing their vendored dependencies keeps unused tooling out of the image
# CVE inventory and makes a future base-layout change fail visibly at build time.
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

FROM base AS build
ENV FACILITY_ALLOW_UNUSED_PATCHES=true
# Keep dependency resolution keyed to the lockfile and relevant workspace
# manifests. UI/source/docs edits can then reuse this expensive install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY apps/web/package.json apps/web/
COPY packages/run-objective/package.json packages/run-objective/
COPY packages/sdk/package.json packages/sdk/
COPY packages/ui/package.json packages/ui/
# The reviewed image-size patch belongs to the docs-only graph. This filtered
# web install deliberately omits docs, so it may leave that patch unused.
RUN pnpm install --frozen-lockfile --filter '@facility/web...'
COPY apps/web apps/web
COPY packages/run-objective packages/run-objective
COPY packages/sdk packages/sdk
COPY packages/ui packages/ui
COPY tsconfig.base.json ./
ENV NEXT_TELEMETRY_DISABLED=1
# The web imports the SDK's published workspace entrypoint (`dist/index.js`). A
# clean image has no SDK artifact, so build it before Next consumes the output.
RUN pnpm --filter '@facility/sdk...' run build:runtime && pnpm --filter '@facility/web' build

FROM runtime AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3400 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3400
CMD ["node", "apps/web/server.js"]
