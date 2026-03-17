# Stage 1: Builder - Build dwn-server and its dependencies
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy monorepo configuration files
COPY bun.lock ./
COPY bunfig.toml ./
COPY package.json ./
COPY tsconfig.json ./

# Copy scripts directory (needed for build)
COPY scripts/ ./scripts/

# Copy build directory (browser-bundle.js is referenced by package build scripts)
COPY build/ ./build/

# Copy all packages (since dwn-server depends on other packages in the monorepo)
COPY packages/ ./packages/

# Copy apps workspace package.json files for bun workspace resolution
COPY apps/docs/package.json ./apps/docs/

# Install all dependencies (--ignore-scripts to skip fumadocs-mdx postinstall)
RUN bun install --frozen-lockfile --ignore-scripts

# Build only packages needed by dwn-server (others have src/ excluded via .dockerignore)
RUN bun run --filter '@enbox/common' --filter '@enbox/crypto' --filter '@enbox/dids' \
    --filter '@enbox/dwn-sdk-js' --filter '@enbox/dwn-sql-store' --filter '@enbox/dwn-clients' \
    --filter '@enbox/dwn-server-admin-ui' --filter '@enbox/dwn-server' build

# Stage 2: Runner - Slim bun image
FROM oven/bun:1-slim AS runner

ARG DS_PORT
ENV DS_PORT=${DS_PORT:-3000}

WORKDIR /app

# Copy the entire built monorepo (simpler and avoids module resolution issues)
COPY --from=builder /app ./

# Set working directory to dwn-server for the entrypoint
WORKDIR /app/packages/dwn-server

# Copy and setup entrypoint script
COPY packages/dwn-server/entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create data directory
RUN mkdir -p data

# Copy package.json to expected location for /info endpoint
RUN mkdir -p /dwn-server && cp package.json /dwn-server/package.json

# Expose port
EXPOSE ${DS_PORT}

# Start the server
ENTRYPOINT ["./entrypoint.sh"]
