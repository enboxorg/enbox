# Build stage
FROM node:20-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml* ./

# Copy web-wallet package files
COPY examples/web-wallet/package.json ./examples/web-wallet/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy web-wallet source
COPY examples/web-wallet ./examples/web-wallet

# Build the application
WORKDIR /app/examples/web-wallet
RUN pnpm build

# Production stage
FROM nginx:alpine

# Install gettext for envsubst
RUN apk add --no-cache gettext

# Copy built assets from builder
COPY --from=builder /app/examples/web-wallet/dist /usr/share/nginx/html

# Create nginx template
RUN echo 'server { \
    listen ${PORT}; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/templates/default.conf.template

# Create startup script
RUN echo '#!/bin/sh\n\
export PORT=${PORT:-80}\n\
envsubst '\''${PORT}'\'' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf\n\
nginx -g "daemon off;"' > /start.sh && chmod +x /start.sh

# Start nginx with PORT from environment
CMD ["/start.sh"]