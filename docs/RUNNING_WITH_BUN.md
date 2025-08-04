# Running DWN Server with Bun

## Prerequisites

First, install Bun on your system:
```bash
curl -fsSL https://bun.sh/install | bash
```

## Running the Server

The DWN server can be run directly with Bun without building:

```bash
cd packages/dwn-server

# Run with default settings (port 3000)
bun run src/main.ts

# Run with custom port and debug logging
PORT=8080 DWN_SERVER_LOG_LEVEL=debug bun run src/main.ts

# Run with in-memory storage (for testing)
DWN_STORAGE=:memory: bun run src/main.ts
```

## Why it might hang

If the server appears to hang without output, it's likely:

1. **Starting successfully** - By default, it only logs at INFO level. The server shows:
   ```
   HttpServer listening on port 3000
   WebSocketServer ready...
   ```

2. **Waiting for storage setup** - The default storage uses LevelDB at `level://data`. If this takes time to initialize, the server might appear to hang.

3. **Missing logs** - Use `DWN_SERVER_LOG_LEVEL=debug` to see more details.

## Configuration

The server uses these environment variables:

- `PORT` - HTTP port (default: 3000)
- `DWN_STORAGE` - Storage location (default: `level://data`)
  - Use `:memory:` for in-memory storage
  - Use `sqlite://path/to/db.sqlite` for SQLite
  - Use `level://path/to/leveldb` for LevelDB
- `DWN_SERVER_LOG_LEVEL` - Log level: trace/debug/info/warn/error (default: info)
- `DS_WEBSOCKET_SERVER` - Enable WebSocket support: on/off (default: on)

## Quick Test

To quickly test if the server is working:

```bash
# Terminal 1: Start the server
PORT=3000 DWN_SERVER_LOG_LEVEL=info DWN_STORAGE=:memory: bun run src/main.ts

# Terminal 2: Test the health endpoint
curl http://localhost:3000/health
```

## Development Mode

For development with auto-reload:

```bash
bun --watch src/main.ts
```

## Common Issues

1. **No output** - The server is likely running fine. Check http://localhost:3000/health

2. **Port already in use** - Change the port with `PORT=8080`

3. **Storage errors** - Use in-memory storage for testing: `DWN_STORAGE=:memory:`

4. **Import errors** - Bun handles `.js` imports in TypeScript files automatically. If you see import errors, make sure you're using Bun v1.0+