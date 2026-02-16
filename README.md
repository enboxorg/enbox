# Enbox

A comprehensive toolkit for decentralized identity and data management.

## Architecture Overview

This monorepo contains the following packages under the `@enbox` namespace:

### Core DWN (Decentralized Web Node) Packages
- **`@enbox/dwn-sdk-js`** - Core DWN SDK implementation (client/server compatible)
- **`@enbox/dwn-sql-store`** - SQL-backed implementations of DWN MessageStore, DataStore, and EventLog
- **`@enbox/dwn-server`** - Express.js server implementation for DWN

### SDK Packages
- **`@enbox/api`** - Main API entry point for building decentralized applications
- **`@enbox/agent`** - Agent implementation for decentralized identity management
- **`@enbox/common`** - Shared utilities and common functionality
- **`@enbox/crypto`** - Cryptographic library and JOSE implementation
- **`@enbox/dids`** - Decentralized Identifiers (DID) library
- **`@enbox/browser`** - Browser-specific tools and features

## System Flow

The system is designed to work as follows:

1. **Server Setup**: Run `@enbox/dwn-server` connected to a SQL database
2. **Client Integration**: Import `@enbox/api` in frontend applications
3. **Communication**: The API uses `@enbox/dwn-sdk-js` + agents to communicate with the DWN server

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) >= 1.0

### Installation
```bash
# Clone the repository
git clone https://github.com/enboxorg/enbox.git
cd enbox

# Install dependencies
bun install

# Build all packages
bun run build
```

### Development
```bash
# Run tests
bun run test:node

# Lint code
bun run lint
bun run lint:fix

# Clean build artifacts
bun run clean
```

## Docker Setup

The easiest way to get started with the DWN server is using Docker Compose, which sets up both the DWN server and PostgreSQL database.

### Quick Start with Docker
```bash
# Start the DWN server with PostgreSQL
docker-compose up -d

# View logs
docker-compose logs -f dwn-server

# Stop services
docker-compose down
```

The DWN server will be available at `http://localhost:3000` with the following endpoints:
- `/info` - Server information
- `/` - DWN protocol endpoints

### Customizing the Setup
Copy `docker.env.example` to `.env` and customize the configuration:
```bash
cp docker.env.example .env
# Edit .env with your preferred settings
```

### Data Persistence
Both PostgreSQL data and DWN data are persisted in Docker volumes:
- `postgres_data` - PostgreSQL database files (accessible on port 5433)
- `dwn_data` - DWN server data files

### Port Configuration
- **DWN Server**: `http://localhost:3000`
- **PostgreSQL**: `localhost:5433` (avoids conflicts with package-level testing)

### Production Considerations
For production deployments:
1. Change default passwords in `.env`
2. Use external PostgreSQL service for better scalability
3. Set up SSL/TLS termination (reverse proxy)
4. Configure backup strategies
5. Set resource limits for containers

## Fly.io Deployment

Deploy the DWN server to Fly.io with managed PostgreSQL:

### Setup
See the complete [Fly.io Deployment Guide](./FLY.md) for detailed instructions.

**Quick summary:**
1. Fork this repository
2. Create a Fly app and Postgres cluster
3. Attach Postgres and configure secrets
4. Deploy with `fly deploy`

### Fly.io Benefits
- Managed PostgreSQL with automatic failover
- Global edge deployment across 30+ regions
- SSL certificates automatically managed
- Git-based deployments via GitHub Actions
- Built-in metrics, logs, and monitoring
- WebSocket and UDP support

For complete Fly.io deployment instructions, troubleshooting, and production tips, see **[FLY.md](./FLY.md)**.

## Package Dependencies

### Internal Dependencies
- `@enbox/dwn-sql-store` depends on `@enbox/dwn-sdk-js`
- `@enbox/dwn-server` depends on `@enbox/dwn-sdk-js` and `@enbox/dwn-sql-store`
- `@enbox/api` depends on `@enbox/agent`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids`
- `@enbox/agent` depends on `@enbox/dwn-sdk-js`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids`
- All packages use workspace dependencies for internal packages

## Repository Structure

```
enbox/
├── package.json              # Root monorepo configuration
├── bunfig.toml              # Bun configuration
├── tsconfig.json            # TypeScript configuration
├── eslint.config.cjs        # ESLint configuration
├── README.md                # This file
├── AGENT_CONTEXT.md         # AI/LLM context documentation
├── .gitignore              # Git ignore rules
└── packages/               # All packages
    ├── dwn-sdk-js/        # Core DWN SDK
    ├── dwn-sql-store/     # SQL implementations
    ├── dwn-server/        # Express server
    ├── api/               # Main API entry point
    ├── agent/             # Agent implementation
    ├── common/            # Shared utilities
    ├── crypto/            # Cryptographic library
    ├── dids/              # DID library
    └── browser/           # Browser tools
```

## Contributing

This repository consolidates packages from the decentralized identity ecosystem. For detailed contribution guidelines, see the original repositories:

- [dwn-sdk-js Contributing](https://github.com/decentralized-identity/dwn-sdk-js/blob/main/CONTRIBUTING.md)
- [decentralized-identity Contributing](https://github.com/decentralized-identity/web5-js/blob/main/CONTRIBUTING.md)

## License

Apache-2.0

## Related Resources

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [DID Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and the web5-js monorepo.*
