# Getting Started with Enbox

## Prerequisites

This project uses [Bun](https://bun.sh) as its runtime and package manager.

### Install Bun (one-time setup)

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### Quick Start

1. **Clone and enter the project:**
   ```bash
   git clone https://github.com/enboxorg/enbox.git
   cd enbox
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Build all packages:**
   ```bash
   bun run build
   ```

4. **Run tests:**
   ```bash
   bun run test:node
   ```

## Alternative Version Managers

If you use a version manager:

- **asdf**: `asdf install` (reads `.tool-versions`)

## Verified Versions

- **Bun**: >= 1.0.0

The `.tool-versions` file pins the exact Bun version used by this project.
