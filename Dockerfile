# =============================================================================
# Production Dockerfile for @enbox/dwn-server
#
# 3-stage build: deps -> build -> runtime
# Single image, differentiated at runtime by DS_WEBSOCKET_SERVER=on/off
#
# Build:   docker build -t enbox-dwn-server .
# Run:     docker run -p 3000:3000 enbox-dwn-server
# HTTP-only: docker run -e DS_WEBSOCKET_SERVER=off -p 3000:3000 enbox-dwn-server
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: deps — install only production + build dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copy workspace root config (needed for bun install to resolve workspaces)
COPY package.json bun.lock bunfig.toml ./

# Copy only package.json for each workspace package that dwn-server needs.
# This enables Docker layer caching — deps only reinstall when package.json changes.
COPY packages/common/package.json          packages/common/
COPY packages/crypto/package.json          packages/crypto/
COPY packages/dids/package.json            packages/dids/
COPY packages/dwn-sdk-js/package.json      packages/dwn-sdk-js/
COPY packages/dwn-sql-store/package.json   packages/dwn-sql-store/
COPY packages/dwn-clients/package.json     packages/dwn-clients/
COPY packages/dwn-server-admin-ui/package.json packages/dwn-server-admin-ui/
COPY packages/dwn-server/package.json      packages/dwn-server/
COPY packages/dwn-relay/package.json       packages/dwn-relay/

# Also copy package.json for excluded packages so bun workspace resolution
# and lockfile integrity checks succeed. Only source is excluded via .dockerignore.
COPY packages/agent/package.json             packages/agent/
COPY packages/api/package.json               packages/api/
COPY packages/browser/package.json           packages/browser/
COPY packages/protocols/package.json         packages/protocols/
COPY packages/protocol-codegen/package.json  packages/protocol-codegen/
COPY packages/dwn-relay/package.json         packages/dwn-relay/

RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build — compile only the packages dwn-server needs
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules          ./node_modules
COPY --from=deps /app/packages/common/node_modules          packages/common/node_modules/
COPY --from=deps /app/packages/crypto/node_modules          packages/crypto/node_modules/
COPY --from=deps /app/packages/dids/node_modules            packages/dids/node_modules/
COPY --from=deps /app/packages/dwn-sdk-js/node_modules      packages/dwn-sdk-js/node_modules/
COPY --from=deps /app/packages/dwn-sql-store/node_modules   packages/dwn-sql-store/node_modules/
COPY --from=deps /app/packages/dwn-clients/node_modules     packages/dwn-clients/node_modules/
COPY --from=deps /app/packages/dwn-server-admin-ui/node_modules packages/dwn-server-admin-ui/node_modules/
COPY --from=deps /app/packages/dwn-server/node_modules      packages/dwn-server/node_modules/

# Copy workspace config
COPY package.json bun.lock bunfig.toml tsconfig.json ./

# Copy build/ directory (browser-bundle.js referenced by package build scripts)
COPY build/ ./build/

# Copy source for each required package
COPY packages/common/          packages/common/
COPY packages/crypto/          packages/crypto/
COPY packages/dids/            packages/dids/
COPY packages/dwn-sdk-js/      packages/dwn-sdk-js/
COPY packages/dwn-sql-store/   packages/dwn-sql-store/
COPY packages/dwn-clients/     packages/dwn-clients/
COPY packages/dwn-server-admin-ui/ packages/dwn-server-admin-ui/
COPY packages/dwn-server/      packages/dwn-server/

# Copy package.json for excluded packages (workspace resolution)
COPY packages/agent/package.json             packages/agent/
COPY packages/api/package.json               packages/api/
COPY packages/browser/package.json           packages/browser/
COPY packages/dwn-relay/package.json         packages/dwn-relay/
COPY packages/protocols/package.json         packages/protocols/
COPY packages/protocol-codegen/package.json  packages/protocol-codegen/
COPY packages/dwn-relay/package.json         packages/dwn-relay/

# Build packages in dependency order.
# common -> crypto -> dids -> dwn-sdk-js -> dwn-sql-store, dwn-clients, admin-ui -> dwn-server
RUN bun run --filter @enbox/common build && \
    bun run --filter @enbox/crypto build && \
    bun run --filter @enbox/dids build && \
    bun run --filter @enbox/dwn-sdk-js build && \
    bun run --filter @enbox/dwn-sql-store build && \
    bun run --filter @enbox/dwn-clients build && \
    bun run --filter @enbox/dwn-server-admin-ui build && \
    bun run --filter @enbox/dwn-server build

# ---------------------------------------------------------------------------
# Stage 3: runtime — minimal image with only built artifacts
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS runtime

# Install tini for proper PID 1 signal handling and curl for healthcheck
RUN apk add --no-cache tini curl

WORKDIR /app

# Create non-root user
RUN addgroup -S dwn && adduser -S dwn -G dwn

# Copy node_modules (runtime dependencies)
COPY --from=deps /app/node_modules          ./node_modules
COPY --from=deps /app/packages/common/node_modules          packages/common/node_modules/
COPY --from=deps /app/packages/crypto/node_modules          packages/crypto/node_modules/
COPY --from=deps /app/packages/dids/node_modules            packages/dids/node_modules/
COPY --from=deps /app/packages/dwn-sdk-js/node_modules      packages/dwn-sdk-js/node_modules/
COPY --from=deps /app/packages/dwn-sql-store/node_modules   packages/dwn-sql-store/node_modules/
COPY --from=deps /app/packages/dwn-clients/node_modules     packages/dwn-clients/node_modules/
COPY --from=deps /app/packages/dwn-server-admin-ui/node_modules packages/dwn-server-admin-ui/node_modules/
COPY --from=deps /app/packages/dwn-server/node_modules      packages/dwn-server/node_modules/

# Copy built dist/ and package.json for each package
COPY --from=build /app/packages/common/dist/          packages/common/dist/
COPY --from=build /app/packages/common/package.json   packages/common/
COPY --from=build /app/packages/crypto/dist/          packages/crypto/dist/
COPY --from=build /app/packages/crypto/package.json   packages/crypto/
COPY --from=build /app/packages/dids/dist/            packages/dids/dist/
COPY --from=build /app/packages/dids/package.json     packages/dids/
COPY --from=build /app/packages/dwn-sdk-js/dist/      packages/dwn-sdk-js/dist/
COPY --from=build /app/packages/dwn-sdk-js/package.json packages/dwn-sdk-js/
COPY --from=build /app/packages/dwn-sql-store/dist/   packages/dwn-sql-store/dist/
COPY --from=build /app/packages/dwn-sql-store/package.json packages/dwn-sql-store/
COPY --from=build /app/packages/dwn-clients/dist/     packages/dwn-clients/dist/
COPY --from=build /app/packages/dwn-clients/package.json packages/dwn-clients/
COPY --from=build /app/packages/dwn-server-admin-ui/dist/ packages/dwn-server-admin-ui/dist/
COPY --from=build /app/packages/dwn-server-admin-ui/package.json packages/dwn-server-admin-ui/
COPY --from=build /app/packages/dwn-server/dist/      packages/dwn-server/dist/
COPY --from=build /app/packages/dwn-server/package.json packages/dwn-server/

# Copy package.json to the expected location for the /info endpoint
RUN mkdir -p /dwn-server && cp packages/dwn-server/package.json /dwn-server/package.json

# Create data directory with correct ownership
RUN mkdir -p /app/data && chown -R dwn:dwn /app/data

# Default environment
ENV DS_PORT=3000
ENV NODE_ENV=production

# Switch to non-root user
USER dwn

EXPOSE 3000

# Healthcheck: hit the /health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${DS_PORT}/health || exit 1

# Use tini as init process for proper signal forwarding
ENTRYPOINT ["tini", "--"]
CMD ["bun", "packages/dwn-server/dist/esm/src/main.js"]
