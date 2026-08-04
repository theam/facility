FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    git \
    gh \
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
    util-linux \
    xfonts-scalable \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

# Pinned 2026-07-19 after `npm view`: claude-code 2.1.215, codex 0.144.6.
RUN npm i -g @anthropic-ai/claude-code@2.1.215 @openai/codex@0.144.6

# Create the package-manager shims while the image is still writable. Runtime
# sandboxes mount /work as a writable tmpfs and keep the image root read-only;
# baking the shims makes a later `corepack enable` idempotent instead of trying
# (and failing) to write /usr/local/bin. Package downloads still use $HOME in
# writable /work.
RUN corepack enable

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY runner-entrypoint.sh codebuild-runner.sh /app/
RUN npm ci && npm run build && npm prune --omit=dev

# Run non-root: agent CLIs (Claude Code) refuse bypass-permissions as root, and
# a rogue agent process should never hold uid 0.
RUN mkdir -p /work \
  && chown -R node:node /work /app \
  && chmod 0755 /app/runner-entrypoint.sh /app/codebuild-runner.sh
ENV HOME=/work
WORKDIR /work
USER node
ENTRYPOINT ["/app/runner-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
