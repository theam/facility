FROM debian:bookworm-slim AS bind-broker-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*
COPY runner/bind-broker.c /src/bind-broker.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror \
      -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE \
      /src/bind-broker.c -Wl,-z,relro,-z,now -pie \
      -o /facility-bind-broker

FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    busybox-static \
    curl \
    docker.io \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    fuse-overlayfs \
    git \
    gh \
    iproute2 \
    iptables \
    jq \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    ripgrep \
    rootlesskit \
    slirp4netns \
    uidmap \
    util-linux \
    xfonts-scalable \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

# Keep the Docker daemon and its socket proxy on identities that the untrusted
# agent user cannot impersonate. The daemon itself is rootless; the proxy is the
# only process allowed to reach its raw socket.
RUN useradd --system --uid 1001 --create-home --home-dir /var/lib/facility-docker facility-docker \
  && useradd --system --uid 1002 --no-create-home --home-dir /nonexistent facility-proxy \
  && usermod --append --groups node facility-docker \
  && usermod --append --groups node,facility-docker facility-proxy \
  && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 facility-docker

# Pinned 2026-07-19 after `npm view`: claude-code 2.1.215, codex 0.144.6.
RUN npm i -g @anthropic-ai/claude-code@2.1.215 @openai/codex@0.144.6

# Create the package-manager shims while the image is still writable. Runtime
# sandboxes mount /work as a writable tmpfs and keep the image root read-only;
# baking the shims makes a later `corepack enable` idempotent instead of trying
# (and failing) to write /usr/local/bin. Package downloads still use $HOME in
# writable /work.
RUN corepack enable

WORKDIR /app
COPY --from=bind-broker-build /facility-bind-broker /usr/local/bin/facility-bind-broker
COPY runner/package.json runner/package-lock.json runner/tsconfig.json ./
COPY packages/run-objective/package.json /packages/run-objective/
COPY packages/run-objective/src /packages/run-objective/src
COPY runner/src ./src
COPY runner/runner-entrypoint.sh runner/codebuild-runner.sh /app/
RUN npm ci && npm run build && npm prune --omit=dev

# Run non-root: agent CLIs (Claude Code) refuse bypass-permissions as root, and
# a rogue agent process should never hold uid 0.
RUN mkdir -p /work \
  && chown -R node:node /work \
  && chown -R root:root /app \
  && chmod -R a-w /app \
  && chmod 0755 /app/runner-entrypoint.sh /app/codebuild-runner.sh
ENV HOME=/work
WORKDIR /work
USER node
ENTRYPOINT ["/app/runner-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
