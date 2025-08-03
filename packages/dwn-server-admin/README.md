# DWN Server Admin UI

A standalone web application for managing DWN Server instances.

## Features

- Server statistics and monitoring
- Tenant management (view, delete)
- Real-time metrics
- Secure authentication via bearer token

## Installation

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

This will start the development server with hot reloading.

## Building

```bash
pnpm build
```

This will create a production build in the `dist` directory.

## Deployment

The admin UI is a static web application that can be deployed to any static hosting service:

### Vercel

```bash
npx vercel dist
```

### Netlify

```bash
npx netlify deploy --dir=dist
```

### Docker

```dockerfile
FROM nginx:alpine
COPY dist /usr/share/nginx/html
EXPOSE 80
```

### Local Preview

```bash
pnpm preview
```

## Configuration

The admin UI will prompt for:

1. **Server URL**: The URL of your DWN Server (e.g., `https://dwn.example.com`)
2. **Admin Secret**: The value of the `DWN_ADMIN_API_SECRET` environment variable on your server

## Server Setup

Ensure your DWN Server has the admin API enabled:

```bash
# Enable admin API
DWN_ADMIN_API_ENABLED=true

# Set a secure admin secret (required)
DWN_ADMIN_API_SECRET=your-secure-secret-here
```

## Security

- The admin API uses bearer token authentication
- All API requests are made over HTTPS in production
- The admin secret is hashed with SHA256 before transmission
- CORS is configured to allow requests from any origin (configure this in production)

## API Endpoints

The admin UI communicates with these server endpoints:

- `POST /admin/auth` - Authenticate and receive token
- `GET /admin/stats` - Server statistics
- `GET /admin/tenants` - List all tenants
- `GET /admin/tenants/:did` - Get tenant details
- `DELETE /admin/tenants/:did` - Delete a tenant
- `POST /admin/clear-all-data` - Clear all data (requires confirmation)