# Stage 1: Build the static SPA with Bun
FROM oven/bun:1 AS build

WORKDIR /app

# Copy package manifest and lockfile first for better layer caching
COPY examples/web-wallet/package.json ./
COPY examples/web-wallet/bun.lock ./

# Install dependencies with Bun
RUN bun install --frozen-lockfile

# Copy the rest of the app source
COPY examples/web-wallet/ ./

# Build the production bundle
RUN bun run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our SPA-friendly nginx config
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from the build stage
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
