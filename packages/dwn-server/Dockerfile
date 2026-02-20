# Stage 1: Builder - Build the entire monorepo
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

# Install all dependencies
RUN bun install --frozen-lockfile

# Build all packages
RUN bun run --filter '*' build

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
