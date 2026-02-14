# AI/LLM Agent Context - Enbox Monorepo

## 🎯 **Repository Purpose & Overview**

This is the **Enbox monorepo** - a consolidated collection of decentralized identity and data management packages that were previously scattered across multiple repositories and namespaces. The repository serves as a unified platform for Web5/DWN (Decentralized Web Node) development.

## 📋 **Migration History & Context**

### **Previous State (Broken)**
- **Multiple repositories**: `dwn-sdk-js`, `dwn-sql-store`, `dwn-server`, `web5-js`
- **Inconsistent namespaces**: `@tbd54566975` (deprecated) and `@web5` (partially migrated)
- **Version mismatches**: Different packages referenced different versions of dependencies
- **Repository references**: All pointed to old `TBD54566975` GitHub organization
- **Scattered architecture**: Related packages split across separate repos

### **Current State (Consolidated)**
- **Single monorepo**: All packages under `@enbox` namespace
- **Unified repository**: `github.com/enboxorg/enbox`
- **Workspace dependencies**: Internal packages use `workspace:*` references
- **Consistent versioning**: All packages properly coordinated
- **Monorepo structure**: 14 packages managed together

## 🏗️ **Architecture & Dependency Flow**

### **Core System Architecture**
```
User Application
    ↓
@enbox/api (main entry point)
    ↓
    ↓
@enbox/dwn-sdk-js (client/server compatible)
    ↓
@enbox/dwn-server (Express.js server)
    ↓
@enbox/dwn-sql-store (SQL implementation)
    ↓
SQL Database
```

### **Package Dependencies**

#### **Core DWN Packages**
- **`@enbox/dwn-sdk-js`**: Core DWN SDK (client/server compatible)
  - Depends on: `@enbox/dids`
  - Used by: `@enbox/dwn-sql-store`, `@enbox/dwn-server`, `@enbox/agent`

- **`@enbox/dwn-sql-store`**: SQL-backed implementations
  - Depends on: `@enbox/dwn-sdk-js` (workspace:*)
  - Used by: `@enbox/dwn-server`

- **`@enbox/dwn-server`**: Express.js server implementation
  - Depends on: `@enbox/dwn-sdk-js`, `@enbox/dwn-sql-store`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

#### **Web5 SDK Packages**
- **`@enbox/api`**: Main entry point for Web5 SDK

- **`@enbox/agent`**: Agent implementation for decentralized identity
  - Depends on: `@enbox/dwn-sdk-js`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

  - Depends on: `@enbox/agent`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

  - Depends on: `@enbox/agent`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

  - Depends on: `@enbox/agent`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

#### **Foundation Packages**
- **`@enbox/common`**: Shared utilities and common functionality
- **`@enbox/crypto`**: Cryptographic library
- **`@enbox/crypto-aws-kms`**: AWS KMS integration for cryptography
- **`@enbox/dids`**: Decentralized Identifiers (DID) library
- **`@enbox/credentials`**: Verifiable Credentials implementation
- **`@enbox/browser`**: Browser-specific tools and features

## 🔧 **Development Workflow**

### **Typical Usage Pattern**
1. **Server Setup**: Run `@enbox/dwn-server` connected to a SQL database
2. **Client Integration**: Import `@enbox/api` in frontend applications
3. **Communication**: The API uses `@enbox/dwn-sdk-js` + agents to communicate with the DWN server

### **Key Commands**
```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test:node

# Lint code
pnpm lint
pnpm lint:fix
```

## 📁 **Repository Structure**

```
enbox/
├── package.json              # Root monorepo configuration
├── pnpm-workspace.yaml      # Workspace configuration
├── tsconfig.json            # TypeScript configuration
├── eslint.config.cjs        # ESLint configuration
├── README.md                # Main documentation
├── AGENT_CONTEXT.md         # This file - AI/LLM context
├── .gitignore              # Git ignore rules
└── packages/               # All packages
    ├── dwn-sdk-js/        # Core DWN SDK
    ├── dwn-sql-store/     # SQL implementations
    ├── dwn-server/        # Express server
    ├── api/               # Main Web5 entry point
    ├── agent/             # Agent implementation
    ├── common/            # Shared utilities
    ├── crypto/            # Cryptographic library
    ├── crypto-aws-kms/    # AWS KMS integration
    ├── dids/              # DID library
    ├── credentials/       # Verifiable credentials
    └── browser/           # Browser tools
```

## 🚨 **Important Notes for AI/LLM Agents**

### **Namespace Migration**
- All packages now use `@enbox` namespace (previously `@tbd54566975` and `@web5`)
- All import statements updated from `@web5/` to `@enbox/`
- All repository URLs updated to `github.com/enboxorg/enbox`

### **Workspace Dependencies**
- Internal package dependencies use `workspace:*` syntax
- This ensures packages use local versions during development
- External dependencies remain as version numbers

### **Build System**
- Uses **pnpm** as package manager
- **TypeScript** for type safety
- **ESLint** for code quality
- **Mocha** for testing

### **Current Issues**
- One TypeScript error in `dwn-sdk-js` related to `abstract-level` dependency version
- ESLint peer dependency warnings (non-critical)
- Some deprecated package warnings (normal)

### **Key Architectural Decisions**
1. **Monorepo consolidation**: All related packages in one repository
2. **Unified namespace**: Consistent `@enbox` namespace across all packages
3. **Workspace dependencies**: Internal packages use workspace references
4. **Preserved architecture**: Original dependency flow maintained
5. **Migration-friendly**: Easy to understand what changed and why

## 🎯 **For Future Development**

When working on this repository:
1. **Always use workspace dependencies** for internal packages
2. **Maintain the dependency flow** described above
3. **Update both package.json and source imports** when changing namespaces
4. **Test the full build** after making changes
5. **Consider the monorepo structure** when adding new packages

This repository represents a successful consolidation of a previously broken, scattered architecture into a unified, maintainable monorepo structure. 