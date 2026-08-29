FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS bind-broker-build

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
FROM docker:29-dind-rootless@sha256:8a213afdd096a44dff403aaf8eb58b7a96a63113f18a4b094b98b7d0ed7d948b AS docker-tools

# Rebuild the exact Go-based releases shipped by Docker with the first Go
# toolchain that contains the reviewed standard-library fixes. The upstream
# image still supplies its shell bootstrap and docker-init; every Go binary
# that crosses into the runner is rebuilt from a checksum-pinned source commit.
FROM golang:1.26.6-trixie@sha256:b75d466dd608587fd66cca705a307ba65b889827d06ad61d6a75f0482b51b7c7 AS go-tools-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libseccomp-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*

# Keep these stages in a dependency chain so BuildKit cannot materialize eight
# complete Go source trees and compiler caches at once. Each successful stage
# retains only /out before the next source build begins.
FROM go-tools-base AS moby-build
ARG MOBY_VERSION=29.7.2
ARG MOBY_COMMIT=6a43e3d5afddf4111da0f864bbc7cae5d7e95001
ARG MOBY_SOURCE_SHA256=ab454c0ace36c1091f36f8750d857f1370a4af3f222f39a88de90a2f6a7e480b
RUN archive=/tmp/moby.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/moby/moby/archive/${MOBY_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$MOBY_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=golang.org/x/mod=golang.org/x/mod@v0.40.0 \
  && VERSION="$MOBY_VERSION" DOCKER_GITCOMMIT="$MOBY_COMMIT" \
    EXCLUDE_AUTO_BUILDTAG_JOURNALD=1 SOURCE_DATE_EPOCH=1785456000 \
    GOFLAGS=-mod=mod ./hack/make.sh binary-daemon binary-proxy \
  && install -m 0755 bundles/binary-daemon/dockerd /out/dockerd \
  && install -m 0755 bundles/binary-proxy/docker-proxy /out/docker-proxy \
  && test "$(/out/dockerd --version | awk '{print $3}' | tr -d ',')" = "$MOBY_VERSION" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM moby-build AS docker-cli-build
ARG DOCKER_CLI_VERSION=29.7.2
ARG DOCKER_CLI_COMMIT=a7dcaa6fdb6ed04aacbfdc76357fdae01605609e
ARG DOCKER_CLI_SOURCE_SHA256=6e5c91d3a5a79db78cf989d07727d00e757aa0da4d135a3ce4b86061b83fb511
RUN archive=/tmp/docker-cli.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/docker/cli/archive/${DOCKER_CLI_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$DOCKER_CLI_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && mkdir -p /go/src/github.com/docker \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && ln -s /src /go/src/github.com/docker/cli \
  && cd /go/src/github.com/docker/cli \
  && VERSION="$DOCKER_CLI_VERSION" GITCOMMIT="$DOCKER_CLI_COMMIT" \
    CGO_ENABLED=0 GO_LINKMODE=static DISABLE_WARN_OUTSIDE_CONTAINER=1 \
    SOURCE_DATE_EPOCH=1785456000 ./scripts/build/binary \
  && install -m 0755 "build/docker-linux-$(go env GOARCH)" /out/docker \
  && test "$(/out/docker --version | awk '{print $3}' | tr -d ',')" = "$DOCKER_CLI_VERSION" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod /go/src/github.com/docker/cli

FROM docker-cli-build AS containerd-build
ARG CONTAINERD_VERSION=2.3.3
ARG CONTAINERD_COMMIT=aad11006b869517fcd3009450b6f82da282e1a9b
ARG CONTAINERD_SOURCE_SHA256=86793eec0b23ea8f7331ea61c5ef1e56ed6f8071de5ede9ce89b13310a1a072b
RUN archive=/tmp/containerd.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/containerd/containerd/archive/${CONTAINERD_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$CONTAINERD_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=golang.org/x/net=golang.org/x/net@v0.56.0 \
  && go mod edit -replace=golang.org/x/mod=golang.org/x/mod@v0.40.0 \
  && make VERSION="v${CONTAINERD_VERSION}" REVISION="$CONTAINERD_COMMIT" STATIC=1 \
    GO_BUILD_FLAGS='-mod=mod -trimpath' \
    bin/containerd bin/containerd-shim-runc-v2 bin/ctr \
  && install -m 0755 bin/containerd bin/containerd-shim-runc-v2 bin/ctr /out/ \
  && test "$(/out/containerd --version | awk '{print $3}')" = "v${CONTAINERD_VERSION}" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM containerd-build AS rootlesskit-build
ARG ROOTLESSKIT_COMMIT=19f94521be524ae7b61e380a814d2aa0a3ef40a9
ARG ROOTLESSKIT_SOURCE_SHA256=ce3a9857719b83f669c5889a69965b9faaba09f36d720e27bcbe4abf288a3b22
RUN archive=/tmp/rootlesskit.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/rootless-containers/rootlesskit/archive/${ROOTLESSKIT_COMMIT}.tar.gz" \
    --output "$archive" \
  && printf '%s  %s\n' "$ROOTLESSKIT_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=golang.org/x/net=golang.org/x/net@v0.56.0 \
  && CGO_ENABLED=0 go build -mod=mod -trimpath -ldflags='-s -w' -o /out/rootlesskit ./cmd/rootlesskit \
  && test "$(/out/rootlesskit --version | awk '{print $3}')" = "3.0.2" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM rootlesskit-build AS buildx-build
ARG BUILDX_VERSION=v0.36.1
ARG BUILDX_COMMIT=1d8dde89b8aba914e05e45366770736fea1fd690
ARG BUILDX_SOURCE_SHA256=fb28b5c2a198d05482f0656dfb7ee161240a904e36697bf7108e5d517f23854b
RUN archive=/tmp/buildx.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/docker/buildx/archive/${BUILDX_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$BUILDX_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=github.com/moby/go-archive=github.com/moby/go-archive@v0.3.0 \
  && go mod edit -replace=golang.org/x/mod=golang.org/x/mod@v0.40.0 \
  && CGO_ENABLED=0 go build -mod=mod -trimpath \
    -ldflags="-s -w -X github.com/docker/buildx/version.Version=${BUILDX_VERSION} \
      -X github.com/docker/buildx/version.Revision=${BUILDX_COMMIT} \
      -X github.com/docker/buildx/version.Package=github.com/docker/buildx" \
    -o /out/docker-buildx ./cmd/buildx \
  && test "$(/out/docker-buildx version | awk '{print $2}')" = "$BUILDX_VERSION" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM buildx-build AS compose-build
ARG COMPOSE_VERSION=v5.4.0
ARG COMPOSE_COMMIT=ef61d7410a0c816a71705026e638ec256a591d69
ARG COMPOSE_SOURCE_SHA256=19bf54c1e4f6effdcc6e3f81356f0ca1d2a1dd447458d7e2ac8138fc38b4148b
RUN archive=/tmp/compose.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/docker/compose/archive/${COMPOSE_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$COMPOSE_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=golang.org/x/mod=golang.org/x/mod@v0.40.0 \
  && CGO_ENABLED=0 GOMAXPROCS=1 go build -p=1 -mod=mod -trimpath -tags=e2e \
    -ldflags="-s -w -X github.com/docker/compose/v5/internal.Version=${COMPOSE_VERSION}" \
    -o /out/docker-compose ./cmd \
  && test "$(/out/docker-compose version --short)" = "${COMPOSE_VERSION#v}" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM compose-build AS runc-build
ARG RUNC_COMMIT=bb14dabeb7185bb72c8c86735d090dcb20f36587
ARG RUNC_SOURCE_SHA256=0128f07fa8bd2ce25d3debf7b52961a2cdc7fbd5fa2da6e76f460d280641fb1b
RUN archive=/tmp/runc.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/opencontainers/runc/archive/${RUNC_COMMIT}.tar.gz" \
    --output "$archive" \
  && printf '%s  %s\n' "$RUNC_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && make -C /src runc \
  && test "$(/src/runc --version | awk '/^go:/{print $2}')" = "go1.26.6" \
  && install -m 0755 /src/runc /out/runc \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

FROM runc-build AS gh-build
ARG GH_VERSION=2.97.0
ARG GH_COMMIT=55dbb4dc6b7edb10b48e3d7fc5bccd32318d1b55
ARG GH_SOURCE_SHA256=c4ee0ab20406291616de45ad771c8b8a927bc8f3fd00ca61a50d0e8ffa582130
RUN archive=/tmp/gh.tar.gz \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/cli/cli/archive/${GH_COMMIT}.tar.gz" --output "$archive" \
  && printf '%s  %s\n' "$GH_SOURCE_SHA256" "$archive" | sha256sum --check --strict \
  && mkdir -p /src /out \
  && tar -xzf "$archive" --strip-components=1 -C /src \
  && cd /src \
  && go mod edit -replace=golang.org/x/mod=golang.org/x/mod@v0.40.0 \
  && CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=mod -trimpath \
    -ldflags="-s -w -X github.com/cli/cli/v2/internal/build.Version=${GH_VERSION} \
      -X github.com/cli/cli/v2/internal/build.Date=2026-07-31" \
    -o /out/gh ./cmd/gh \
  && test "$(/out/gh --version | awk 'NR == 1 {print $3}')" = "$GH_VERSION" \
  && rm -rf /src "$archive" /root/.cache/go-build /go/pkg/mod

# Keep the toolchain claim executable: fail the image build if any copied Go
# binary was not produced by the patched compiler, or if the two projects that
# pinned vulnerable x/net code did not resolve the reviewed replacement.
FROM gh-build AS go-tools-audit
RUN for binary in /out/*; do \
    test "$(go version -m "$binary" | awk 'NR == 1 {print $2}')" = "go1.26.6"; \
  done \
  && for binary in /out/containerd /out/containerd-shim-runc-v2 /out/ctr /out/rootlesskit; do \
    go version -m "$binary" | awk \
      '$1 == "=>" && $2 == "golang.org/x/net" && $3 == "v0.56.0" { found = 1 } END { exit !found }'; \
  done \
  && for binary in /out/dockerd /out/containerd /out/ctr /out/docker-buildx /out/docker-compose /out/gh; do \
    go version -m "$binary" | awk \
      '$1 == "=>" && $2 == "golang.org/x/mod" && $3 == "v0.40.0" { found = 1 } END { exit !found }'; \
  done \
  && go version -m /out/docker-buildx | awk \
    '$1 == "=>" && $2 == "github.com/moby/go-archive" && $3 == "v0.3.0" { found = 1 } END { exit !found }'

# The full Node image inherits buildpack-deps and silently carries unrelated
# database, image-processing, DNS, and web-server development stacks. Agents
# need a native compiler toolchain, not that entire transitive surface, so start
# from the official slim variant and install the small explicit toolchain below.
FROM node:24-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0 AS runner-base

# The digest-pinned Node base can lag Debian security uploads, while BuildKit
# correctly caches an earlier apt upgrade against the unchanged base digest.
# Bump this audited epoch only when a scanner identifies a distro fix that the
# official image has not incorporated yet; using it in the command makes that
# refresh explicit and reproducible instead of disabling the whole build cache.
ARG DEBIAN_SECURITY_REFRESH=20260828
RUN test -n "$DEBIAN_SECURITY_REFRESH" \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    build-essential \
    busybox-static \
    ca-certificates \
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
    libseccomp2 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    pkg-config \
    procps \
    python3 \
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
COPY --from=go-tools-audit \
  /out/docker /out/dockerd /out/docker-proxy /out/containerd \
  /out/containerd-shim-runc-v2 /out/ctr /out/rootlesskit /out/runc /out/gh \
  /usr/local/bin/
COPY --from=go-tools-audit /out/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=go-tools-audit /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=go-tools-audit /out/docker-compose /usr/local/bin/docker-compose
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
# npm's download cache duplicates the large native Claude/Codex packages in
# the final layer. It is not used at runtime, would push this layer above VCR's
# 500 MB compressed limit, and makes every registry transfer needlessly slow.
RUN cd /opt/facility-agent-clis \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /root/.npm \
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
# Repository-runner source changes are frequent and do not change the locked
# runtime dependency graph. Keep npm ci in its own cacheable layer so an agent
# telemetry or lifecycle edit rebuilds the small bundle instead of reinstalling
# and auditing the same dependencies.
RUN npm ci
COPY runner/src ./src
# The runtime image consumes JavaScript only. Declaration generation remains in
# the workspace build/typecheck gates and previously added about a minute to
# every cache-miss runner image build without changing runtime bytes.
RUN npm run build:runtime && npm prune --omit=dev

# Run non-root: agent CLIs (Claude Code) refuse bypass-permissions as root, and
# a rogue agent process should never hold uid 0.
RUN mkdir -p /work/.facility-package-cache \
  && chown -R node:node /work \
  && chown -R root:root /app \
  && chmod -R a-w /app
# Shell bootstrap changes must not invalidate the dependency install, bundle,
# or recursive application hardening layer.
COPY --chown=root:root --chmod=0555 \
  runner/runner-entrypoint.sh runner/codebuild-runner.sh runner/find-descendant.awk /app/
COPY --chown=root:root --chmod=0555 runner/facility-delivery.sh /usr/local/bin/facility-delivery
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["/app/runner-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]

# Vercel custom-image commands start as the image's declared user and its SDK
# implements `sudo` by invoking a binary. Keep sudo out of the image: start only
# the trusted bootstrap as root, then codebuild-runner.sh demotes every custom
# command and repository/model child to UID 1000 before execution.
FROM runner-base AS vercel-runner
USER root

# The default/local image retains the existing non-root boundary. Keep this as
# the last stage so ordinary `docker build` and ECR publishing remain unchanged.
FROM runner-base AS runner
USER node
