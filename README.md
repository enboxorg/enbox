# Enbox

A comprehensive monorepo containing all the packages needed for decentralized identity and data management.

## 🏗️ **Architecture Overview**

This monorepo contains the following packages under the `@enbox` namespace:

### Core DWN (Decentralized Web Node) Packages
- **`@enbox/dwn-sdk-js`** - Core DWN SDK implementation (client/server compatible)
- **`@enbox/dwn-sql-store`** - SQL-backed implementations of DWN MessageStore, DataStore, and EventLog
- **`@enbox/dwn-server`** - Express.js server implementation for DWN

### Web5 SDK Packages
- **`@enbox/api`** - Main entry point for Web5 SDK
- **`@enbox/agent`** - Agent implementation for decentralized identity management
- **`@enbox/identity-agent`** - Identity agent for credential management
- **`@enbox/user-agent`** - User agent for decentralized applications
- **`@enbox/proxy-agent`** - Proxy agent for secure communication
- **`@enbox/common`** - Shared utilities and common functionality
- **`@enbox/crypto`** - Cryptographic library
- **`@enbox/crypto-aws-kms`** - AWS KMS integration for cryptography
- **`@enbox/dids`** - Decentralized Identifiers (DID) library
- **`@enbox/credentials`** - Verifiable Credentials implementation
- **`@enbox/browser`** - Browser-specific tools and features

## 🔄 **System Flow**

The system is designed to work as follows:

1. **Server Setup**: Run `@enbox/dwn-server` connected to a SQL database
2. **Client Integration**: Import `@enbox/api` in frontend applications
3. **Communication**: The API uses `@enbox/dwn-sdk-js` + agents to communicate with the DWN server

## 🚀 **Quick Start**

### Prerequisites
- Node.js >= 18
- pnpm

### Installation
```bash
# Clone the repository
git clone https://github.com/enboxorg/enbox.git
cd enbox

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Development
```bash
# Run tests
pnpm test:node

# Lint code
pnpm lint
pnpm lint:fix

# Clean build artifacts
pnpm clean
```

## 📦 **Package Dependencies**

### Internal Dependencies
- `@enbox/dwn-sql-store` depends on `@enbox/dwn-sdk-js`
- `@enbox/dwn-server` depends on `@enbox/dwn-sdk-js` and `@enbox/dwn-sql-store`
- `@enbox/api` depends on `@enbox/agent`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids`, `@enbox/user-agent`
- `@enbox/agent` depends on `@enbox/dwn-sdk-js`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids`
- All packages use workspace dependencies for internal packages

## 📁 **Repository Structure**

```
enbox/
├── package.json              # Root monorepo configuration
├── pnpm-workspace.yaml      # Workspace configuration
├── tsconfig.json            # TypeScript configuration
├── eslint.config.cjs        # ESLint configuration
├── README.md                # This file
├── AGENT_CONTEXT.md         # AI/LLM context documentation
├── .gitignore              # Git ignore rules
└── packages/               # All packages
    ├── dwn-sdk-js/        # Core DWN SDK
    ├── dwn-sql-store/     # SQL implementations
    ├── dwn-server/        # Express server
    ├── api/               # Main Web5 entry point
    ├── agent/             # Agent implementation
    ├── identity-agent/    # Identity agent
    ├── user-agent/        # User agent
    ├── proxy-agent/       # Proxy agent
    ├── common/            # Shared utilities
    ├── crypto/            # Cryptographic library
    ├── crypto-aws-kms/    # AWS KMS integration
    ├── dids/              # DID library
    ├── credentials/       # Verifiable credentials
    └── browser/           # Browser tools
```

## 🤝 **Contributing**

This repository consolidates packages from the decentralized identity ecosystem. For detailed contribution guidelines, see the original repositories:

- [dwn-sdk-js Contributing](https://github.com/decentralized-identity/dwn-sdk-js/blob/main/CONTRIBUTING.md)
- [web5-js Contributing](https://github.com/decentralized-identity/web5-js/blob/main/CONTRIBUTING.md)

## 📄 **License**

MIT

## 🔗 **Related Resources**

- [Decentralized Web Node Specification](https://identity.foundation/decentralized-web-node/spec/)
- [Web5 Documentation](https://developer.tbd.website/)
- [DID Specification](https://www.w3.org/TR/did-core/)

---

*This monorepo consolidates packages from the [decentralized-identity](https://github.com/decentralized-identity) organization, including [dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js), [dwn-server](https://github.com/decentralized-identity/dwn-server), [dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store), and [web5-js](https://github.com/decentralized-identity/web5-js).* 