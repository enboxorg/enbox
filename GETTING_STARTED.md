# Getting Started with Enbox

## Prerequisites

This project uses **Volta** to manage Node.js and pnpm versions automatically.

### Install Volta (one-time setup)

```bash
# macOS/Linux
curl https://get.volta.sh | bash

# Windows
winget install Volta.Volta
```

### Quick Start

1. **Clone and enter the project:**
   ```bash
   git clone https://github.com/enboxorg/enbox.git
   cd enbox
   ```

2. **Volta will automatically install the correct Node.js and pnpm versions** when you enter the directory for the first time.

3. **Install dependencies:**
   ```bash
   pnpm install
   ```

4. **Build all packages:**
   ```bash
   pnpm build
   ```

5. **Run tests:**
   ```bash
   pnpm test:node
   ```

## Alternative Version Managers

If you prefer other tools:

- **nvm**: `nvm use` (reads `.nvmrc`)
- **asdf**: `asdf install` (reads `.tool-versions`)  
- **pnpm only**: The `.pnpmrc` enforces Node version requirements

## Verified Versions

- **Node.js**: 20.3.0
- **pnpm**: 8.15.0

These versions are automatically used when Volta is installed.