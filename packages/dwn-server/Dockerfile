# Stage 1: Builder - Build the entire monorepo
FROM node:20.10.0-bookworm AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy monorepo configuration files
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY tsconfig.json ./

# Copy all packages (since dwn-server depends on other packages in the monorepo)
COPY packages/ ./packages/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Build all packages
RUN pnpm --recursive --stream build

# Stage 2: Runner - Use full node image to avoid installing build tools
FROM node:20.10.0-bookworm AS runner

ARG DS_PORT
ENV DS_PORT=${DS_PORT:-3000}

WORKDIR /app

# Copy the entire built monorepo (simpler and avoids module resolution issues)
COPY --from=builder /app ./

# Install better-sqlite3 in a clean environment with proper native bindings
# Using the full node image means we don't need to install build tools
RUN cd /app/node_modules && \
    npm rebuild better-sqlite3 --build-from-source

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