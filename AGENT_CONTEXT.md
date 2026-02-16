# AI/LLM Agent Context - Enbox Monorepo

## Repository Purpose & Overview

This is the **Enbox monorepo** - a consolidated collection of decentralized identity and data management packages that were previously scattered across multiple repositories and namespaces. The repository serves as a unified platform for Web5/DWN (Decentralized Web Node) development.

## Migration History & Context

### Previous State (Broken)
- **Multiple repositories**: `dwn-sdk-js`, `dwn-sql-store`, `dwn-server`, `web5-js`
- **Inconsistent namespaces**: `@tbd54566975` (deprecated) and `@web5` (partially migrated)
- **Version mismatches**: Different packages referenced different versions of dependencies
- **Repository references**: All pointed to old `TBD54566975` GitHub organization
- **Scattered architecture**: Related packages split across separate repos

### Current State (Consolidated)
- **Single monorepo**: All packages under `@enbox` namespace
- **Unified repository**: `github.com/enboxorg/enbox`
- **Workspace dependencies**: Internal packages use `workspace:*` references
- **Consistent versioning**: All packages properly coordinated
- **Bun runtime**: Uses Bun as runtime, package manager, and script runner
- **ESM-only**: All packages output ESM only (CJS builds removed)

## Architecture & Dependency Flow

### Core System Architecture
```
User Application
    |
@enbox/api (main entry point)
    |
@enbox/agent
    |
@enbox/dwn-sdk-js (client/server compatible)
    |
@enbox/dwn-server (Express.js server)
    |
@enbox/dwn-sql-store (SQL implementation via Kysely + bun:sqlite)
    |
SQL Database
```

### Package Dependencies

#### Core DWN Packages
- **`@enbox/dwn-sdk-js`**: Core DWN SDK (client/server compatible)
  - Depends on: `@enbox/dids`
  - Used by: `@enbox/dwn-sql-store`, `@enbox/dwn-server`, `@enbox/agent`

- **`@enbox/dwn-sql-store`**: SQL-backed implementations
  - Depends on: `@enbox/dwn-sdk-js` (workspace:*)
  - Provides: `bun-sqlite-adapter.ts` for Kysely compatibility with `bun:sqlite`
  - Used by: `@enbox/dwn-server`

- **`@enbox/dwn-server`**: Express.js server implementation
  - Depends on: `@enbox/dwn-sdk-js`, `@enbox/dwn-sql-store`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

#### Web5 SDK Packages
- **`@enbox/api`**: Main entry point for Web5 SDK

- **`@enbox/agent`**: Agent implementation for decentralized identity (consolidated from former user-agent, identity-agent, proxy-agent)
  - Depends on: `@enbox/dwn-sdk-js`, `@enbox/common`, `@enbox/crypto`, `@enbox/dids` (all workspace:*)

#### Foundation Packages
- **`@enbox/common`**: Shared utilities and common functionality
- **`@enbox/crypto`**: Cryptographic library
- **`@enbox/dids`**: Decentralized Identifiers (DID) library
- **`@enbox/browser`**: Browser-specific tools and features

## Development Workflow

### Typical Usage Pattern
1. **Server Setup**: Run `@enbox/dwn-server` connected to a SQL database
2. **Client Integration**: Import `@enbox/api` in frontend applications
3. **Communication**: The API uses `@enbox/dwn-sdk-js` + agents to communicate with the DWN server

### Key Commands
```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test:node

# Lint code
bun run lint
bun run lint:fix
```

## Repository Structure

```
enbox/
├── package.json              # Root monorepo configuration (workspaces)
├── bunfig.toml              # Bun configuration
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
    ├── dids/              # DID library
    └── browser/           # Browser tools
```

## Important Notes for AI/LLM Agents

### Namespace Migration
- All packages now use `@enbox` namespace (previously `@tbd54566975` and `@web5`)
- All import statements updated from `@web5/` to `@enbox/`
- All repository URLs updated to `github.com/enboxorg/enbox`

### Workspace Dependencies
- Internal package dependencies use `workspace:*` syntax
- This ensures packages use local versions during development
- External dependencies remain as version numbers

### Build System
- Uses **Bun** as runtime and package manager
- **TypeScript** compiled via `tsc` (run through Bun)
- **esbuild** for browser bundles (polyfill plugins for Node API shimming)
- **ESM-only** output (CJS builds removed)
- **ESLint** for code quality
- **Mocha** for testing (run via `bunx mocha`)

### SQLite
- Uses **`bun:sqlite`** (Bun's built-in SQLite) via a Kysely adapter
- The adapter is in `packages/dwn-sql-store/src/dialect/bun-sqlite-adapter.ts`
- Replaces the previous `better-sqlite3` native addon (no more node-gyp builds)

### Key-Value Storage
- Uses `level` (LevelDB) for agent-side key-value stores
- Relies on Bun's N-API compatibility for the `classic-level` native bindings
- SQL backends available as alternative for DWN stores

### Docker
- Dockerfile uses `oven/bun:1` base image
- Multi-stage build: builder + slim runner
- Fly.io deployment supported via `fly.toml`

### Key Architectural Decisions
1. **Monorepo consolidation**: All related packages in one repository
2. **Unified namespace**: Consistent `@enbox` namespace across all packages
3. **Workspace dependencies**: Internal packages use workspace references
4. **Bun runtime**: Full migration from Node.js/pnpm to Bun
5. **ESM-only**: Dropped CJS dual builds for simplicity
6. **Native SQLite**: Uses `bun:sqlite` instead of `better-sqlite3`

## For Future Development

When working on this repository:
1. **Always use workspace dependencies** for internal packages
2. **Maintain the dependency flow** described above
3. **Update both package.json and source imports** when changing namespaces
4. **Always run lint and build before committing**: `bun run lint` and `bun run build` (or `bun run --filter '*' lint` / `bun run --filter '*' build` from root). Fix any errors before pushing.
5. **Consider the monorepo structure** when adding new packages
6. **Run scripts with `bun run`**, not `npm run` or `pnpm`
7. **Import attributes**: Use `import ... with { type: 'json' }` (the standard syntax) for JSON imports — we use `@typescript-eslint` v8 which fully supports the `with` keyword.

This repository represents a successful consolidation of a previously broken, scattered architecture into a unified, maintainable monorepo structure.
