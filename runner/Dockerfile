FROM debian:trixie-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258 AS bind-broker-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

COPY runner/bind-broker.c /src/bind-broker.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror \
      -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE \
      /src/bind-broker.c -Wl,-z,relro,-z,now -pie \
      -o /facility-bind-broker

# Docker's official rootless image publishes a coherent, multi-platform static
# daemon/client/runtime set built with a current Go toolchain. Copying from one
# digest-pinned source avoids Debian's lagging docker.io binaries and a second
# architecture-specific download/checksum matrix.
FROM docker:29-dind-rootless@sha256:7451e3dc398b11ba2d8183bb7915402683e3d32e5ec8cef835c215f314a65fef AS docker-tools

# GitHub CLI has no official container image. Its immutable release archives
# are verified per target architecture before the single binary crosses stages.
FROM debian:trixie-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258 AS gh-build
ARG TARGETARCH
ARG GH_VERSION=2.97.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && case "$TARGETARCH" in \
    amd64) gh_sha256="a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112" ;; \
    arm64) gh_sha256="73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5" ;; \
    *) echo "unsupported GitHub CLI architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}" \
    --output "/tmp/${archive}" \
  && printf '%s  %s\n' "$gh_sha256" "/tmp/${archive}" | sha256sum --check --strict \
  && tar -xzf "/tmp/${archive}" -C /tmp \
  && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /gh

FROM node:24-trixie@sha256:66bb8d36ae1ddd72199ed235a089904874ca4079ee517936ca3adb80506a75c1

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    busybox-static \
    curl \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    fuse-overlayfs \
    git \
    iproute2 \
    iptables \
    jq \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0t64 \
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
    slirp4netns \
    uidmap \
    util-linux \
    xfonts-scalable \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

# npm is a runtime capability for repositories that use package-lock.json, so
# keep it rather than forcing every project through pnpm. The Node base can lag
# fixes in npm's own dependency tree: install the current CLI, overlay its
# same-major patched transitives, and remove the older nested copies that Node
# would otherwise resolve first.
ARG NPM_VERSION=12.0.2
RUN npm install --global "npm@${NPM_VERSION}" \
  && npm install --global --omit=dev --ignore-scripts \
    brace-expansion@5.0.9 \
    ip-address@10.3.1 \
    tar@7.5.21 \
    undici@6.28.0 \
  && rm -rf \
    /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
    /usr/local/lib/node_modules/npm/node_modules/ip-address \
    /usr/local/lib/node_modules/npm/node_modules/tar \
    /usr/local/lib/node_modules/npm/node_modules/undici \
  && test "$(npm --version)" = "$NPM_VERSION" \
  && npm config get registry >/dev/null

COPY --from=docker-tools /usr/local/bin/ /usr/local/bin/
COPY --from=docker-tools /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=gh-build /gh /usr/local/bin/gh
RUN docker --version \
  && dockerd --version \
  && rootlesskit --version \
  && containerd --version \
  && runc --version \
  && docker compose version \
  && docker buildx version \
  && gh --version

# Keep the Docker daemon and its socket proxy on identities that the untrusted
# agent user cannot impersonate. The daemon itself is rootless; the proxy is the
# only process allowed to reach its raw socket.
RUN useradd --system --uid 1001 --create-home --home-dir /var/lib/facility-docker facility-docker \
  && useradd --system --uid 1002 --no-create-home --home-dir /nonexistent facility-proxy \
  && usermod --append --groups node facility-docker \
  && usermod --append --groups node,facility-docker facility-proxy \
  && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 facility-docker

# Keep the privileged agent toolchain in its own locked, cacheable layer. The
# runner application changes more frequently and must not re-resolve CLI
# transitives or invalidate this install.
COPY runner/agent-clis/package.json runner/agent-clis/package-lock.json /opt/facility-agent-clis/
RUN cd /opt/facility-agent-clis \
  && npm ci --omit=dev \
  && ln -s /opt/facility-agent-clis/node_modules/.bin/claude /usr/local/bin/claude \
  && ln -s /opt/facility-agent-clis/node_modules/.bin/codex /usr/local/bin/codex \
  && claude --version \
  && codex --version

# Create the package-manager shims while the image is still writable. Runtime
# sandboxes mount /work as a writable, per-run volume and keep the image root read-only;
# baking the shims makes a later `corepack enable` idempotent instead of trying
# (and failing) to write /usr/local/bin. Package downloads still use $HOME in
# writable /work.
RUN corepack enable

# Seed the repository's pinned package-manager release into an immutable image
# layer. The entrypoint copies this trusted seed into each sandbox's ephemeral
# workspace; repositories pinning another release can still download it for that run,
# but no executable Corepack cache persists into the next run.
COPY package.json /tmp/facility-root-package.json
RUN package_manager="$(node -p "require('/tmp/facility-root-package.json').packageManager")" \
  && COREPACK_HOME=/opt/facility-corepack corepack install --global --cache-only "$package_manager" \
  && chmod -R a-w /opt/facility-corepack \
  && rm -f /tmp/facility-root-package.json

WORKDIR /app
COPY --from=bind-broker-build /facility-bind-broker /usr/local/bin/facility-bind-broker
COPY runner/package.json runner/package-lock.json runner/tsconfig.json ./
COPY packages/run-objective/package.json /packages/run-objective/
COPY packages/run-objective/src /packages/run-objective/src
COPY runner/src ./src
COPY runner/runner-entrypoint.sh runner/codebuild-runner.sh runner/find-descendant.awk /app/
RUN npm ci && npm run build && npm prune --omit=dev

# Run non-root: agent CLIs (Claude Code) refuse bypass-permissions as root, and
# a rogue agent process should never hold uid 0.
RUN mkdir -p /work/.facility-package-cache \
  && chown -R node:node /work \
  && chown -R root:root /app \
  && chmod -R a-w /app \
  && chmod 0755 /app/runner-entrypoint.sh /app/codebuild-runner.sh
ENV HOME=/work
WORKDIR /work
USER node
ENTRYPOINT ["/app/runner-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
