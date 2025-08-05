# Local Development Setup

This guide helps you set up the monorepo and example applications for local development.

## Prerequisites

- Node.js 20.10.0 (use nvm to install: `nvm install 20.10.0`)
- pnpm 8.15.0 (`npm install -g pnpm@8.15.0`)

## Quick Setup

1. Clone the repository with submodules:
   ```bash
   git clone --recursive https://github.com/enboxorg/enbox.git
   cd enbox
   ```

2. If you've already cloned without submodules, initialize them:
   ```bash
   git submodule update --init --recursive
   ```

3. Install dependencies:
   ```bash
   pnpm install
   ```

4. Set up example applications:
   ```bash
   pnpm run setup:examples
   ```

## Running Example Applications

### Web Wallet
```bash
pnpm run dev:web-wallet
```
The web wallet will be available at http://localhost:5173

### DApp Demo
```bash
pnpm run dev:dapp-demo
```

## Troubleshooting

### Process polyfill issues
If you encounter errors about `process/` imports, ensure the vite.config.js has the alias:
```javascript
resolve: {
    alias: {
        "process/": "process",
    },
}
```

### Vite crashes in background
Use the provided start scripts (start-dev.sh) which run vite in non-interactive mode.

### PWA Assets Generator Warning
The "No preset for assets generator found" warning is non-critical and can be ignored.

## Notes

- The monorepo packages are configured to work in both Node.js and browser environments
- The example applications are git submodules and need to be installed separately
- Railway deployments use a different configuration and should continue to work as before