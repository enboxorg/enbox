# DWN Server

> **Research Preview** — Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dwn-server.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

A multi-tenant Decentralized Web Node exposed via JSON-RPC over HTTP and WebSocket, powered by `Bun.serve()`.

- [Supported DBs](#supported-dbs)
- [Installation](#installation)
- [Running the Server](#running-the-server)
- [JSON-RPC API](#json-rpc-api)
- [Configuration](#configuration)
- [Hosting Your Own DWN Server](#hosting-your-own-dwn-server)
- [Registration Requirements](#registration-requirements)

## Supported DBs

- LevelDB
- SQLite
- MySQL
- PostgreSQL

See [Storage Options](#storage-options) for details.

## Installation

```bash
bun add @enbox/dwn-server
```

## Package Usage

```typescript
import { DwnServer } from '@enbox/dwn-server';

const server = new DwnServer();
server.start();
```

## Running the Server

### Via Docker

```bash
docker run -p 3000:3000 -v myvolume:/dwn-server/data ghcr.io/enboxorg/dwn-server:main
```

This can run on AWS, GCP, VPS, home server (with ngrok or Cloudflare tunnel), Fly.io, Render, etc. Use a persistent volume so data is kept (or synced back from another DWN instance).

To run a specific version, [see published images](https://github.com/enboxorg/enbox/pkgs/container/dwn-server/versions):

```bash
docker pull ghcr.io/enboxorg/dwn-server@sha256:<hash>
```

### Locally for Development

```bash
git clone https://github.com/enboxorg/enbox.git
cd enbox
bun install
bun run --filter @enbox/dwn-server build
bun run --filter @enbox/dwn-server server
```

### Building a Docker Image Locally

```bash
docker build -t dwn-server .
```

## JSON-RPC API

[JSON-RPC](https://www.jsonrpc.org/specification) is a lightweight RPC protocol using JSON, language-independent and transport-agnostic.

### `dwn.processMessage`

Used to send DWeb Messages to the server.

#### Params

| Property      | Required | Description                                                               |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `target`      | Y        | The DID that the message is intended for                                  |
| `message`     | Y        | The DWeb Message                                                          |
| `encodedData` | N        | Data associated to the message (e.g. data associated to a `RecordsWrite`) |

#### Example Request

```json
{
  "jsonrpc": "2.0",
  "id": "b23f9e31-4966-4972-8048-af3eed43cb41",
  "method": "dwn.processMessage",
  "params": {
    "message": {
      "recordId": "bafyreidtix6ghjmsbg7eitexsmwzvjxc7aelagsqasybmql7zrms34ju6i",
      "descriptor": {
        "interface": "Records",
        "method": "Write",
        "dataCid": "bafkreidnfo6aux5qbg3wwzy5hvwexnoyhk3q3v47znka2afa6mf2rffkbi",
        "dataSize": 32,
        "dateCreated": "2023-04-30T22:49:37.713976Z",
        "dateModified": "2023-04-30T22:49:37.713976Z",
        "dataFormat": "application/json"
      },
      "authorization": { "..." : "..." }
    },
    "target": "did:key:z6Mku1h4LdkhXW3HnnBKANxgUaQ162cvWmRuzcbd2Ye8VstZ",
    "encodedData": "ub3-FwUsSs4GgZWqt5eXSH41RKlwCx41y3dgio9Di74"
  }
}
```

#### Example Success Response

```json
{
  "jsonrpc": "2.0",
  "id": "18eb421f-4750-4e31-a062-412b71139546",
  "result": {
    "reply": {
      "status": { "code": 202, "detail": "Accepted" }
    }
  }
}
```

#### Example Error Response

```json
{
  "jsonrpc": "2.0",
  "id": "1c7f6ed8-eaaf-447c-aaf3-b9e61f3f59af",
  "error": {
    "code": -50400,
    "message": "Unexpected token ';', \";;;;@!#@!$$#!@%\" is not valid JSON"
  }
}
```

#### Transporting Large Data

`RecordsWrite` data can be of any size. Large data can be streamed over HTTP by:

- Including the JSON-RPC request message in a `dwn-request` request header
- Setting `content-type` to `application/octet-stream`
- Sending binary data in the request body

#### Receiving Large Data

`RecordsWrite` messages returned from a `RecordsQuery` include `encodedData` only if the data is under ~9.77KB. Larger data must be fetched via `RecordsRead` over HTTP, which returns:

- The JSON-RPC response in a `dwn-response` header
- The binary data in the response body

## Configuration

All configuration is via environment variables:

| Env Var                                           | Description                                                                                                                    | Default                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `DS_PORT`                                         | Port the server listens on                                                                                                     | `3000`                 |
| `DS_MAX_RECORD_DATA_SIZE`                         | Maximum size for `RecordsWrite` data (`b`, `kb`, `mb`, `gb`)                                                                   | `1gb`                  |
| `DS_WEBSOCKET_SERVER`                             | Enable WebSocket listener: `on` / `off`                                                                                        | `on`                   |
| `DWN_BASE_URL`                                    | Base external URL of this DWN                                                                                                  | `http://localhost`     |
| `DWN_STORAGE`                                     | Default storage URL. See [Storage Options](#storage-options)                                                                   | `level://data`         |
| `DWN_STORAGE_MESSAGES`                            | Message store URL (overrides `DWN_STORAGE`)                                                                                    | value of `DWN_STORAGE` |
| `DWN_STORAGE_DATA`                                | Data store URL (overrides `DWN_STORAGE`)                                                                                       | value of `DWN_STORAGE` |
| `DWN_STORAGE_RESUMABLE_TASKS`                     | Resumable task store URL                                                                                                       | value of `DWN_STORAGE` |
| `DWN_STORAGE_STATE_INDEX`                         | State index store URL                                                                                                          | value of `DWN_STORAGE` |
| `DWN_EVENT_BUS_PLUGIN_PATH`                       | Path to custom EventBus plugin for cross-process durable-log wakes                                                              | unset                  |
| `DWN_REGISTRATION_STORE_URL`                      | URL for registered DID storage. Unset = open for all                                                                           | unset                  |
| `DWN_REGISTRATION_PROOF_OF_WORK_ENABLED`          | Require proof-of-work for registration                                                                                         | `false`                |
| `DWN_REGISTRATION_PROOF_OF_WORK_SEED`             | Seed for challenge nonce (cluster consistency)                                                                                  | unset                  |
| `DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH` | Initial max hash (64 char hex). More leading zeros = higher difficulty                                                          | `000000FF...`          |
| `DWN_TERMS_OF_SERVICE_FILE_PATH`                  | Path to terms of service file. Unset = no ToS requirement                                                                      | unset                  |
| `DWN_TTL_CACHE_URL`                               | TTL cache URL (SQL databases only)                                                                                             | `sqlite://`            |

### Storage Options

| Database   | Example                                               | Notes                                                                            |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| LevelDB    | `level://data`                                        | Two slashes for relative paths, three for absolute                               |
| SQLite     | `sqlite://dwn.db`                                     | Two slashes for relative paths, three for absolute                               |
| MySQL      | `mysql://user:pass@host/db?debug=true&timezone=-0700` | [Options](https://github.com/mysqljs/mysql#connection-options)                   |
| PostgreSQL | `postgres:///dwn`                                     | Also supports [standard env vars](https://node-postgres.com/features/connecting) |

### Plugins

Custom implementations of `DataStore`, `MessageStore`, `ResumableDataStore`, `StateIndex`, or `EventStream` can be loaded by pointing the corresponding env var to the absolute path of a `.js` file. The file must default-export a class with a no-arg constructor.

## Hosting Your Own DWN Server

By default, `Enbox.connect()` uses bootstrap DWN nodes. You can run your own for yourself or your community. DWNs can run anywhere you can run Bun or Docker — HTTP and WebSocket must be reachable.

### With ngrok

```bash
docker run -p 3000:3000 -v myvolume:/dwn-server/data ghcr.io/enboxorg/dwn-server:main

# In another terminal:
ngrok http 3000
```

### With Cloudflare Tunnel

```bash
# Start the server, then:
cloudflared tunnel --url http://localhost:3000
```

### On Render.com

Fork this repo, create a "Web service" on Render, point it at the fork, choose the starter size, and mount a 1GB+ disk at `/dwn-server/data`.

## Registration Requirements

Optional registration gates (all disabled by default). Tenants that haven't completed registration get a 401. Registration is tracked in a SQL database (LevelDB not supported). Current requirements are exposed at `/info`.

- **Proof of Work** (`DWN_REGISTRATION_PROOF_OF_WORK_ENABLED=true`): GET `/registration/proof-of-work` for a challenge, compute a nonce where `sha256(challenge + nonce)` starts with the required number of zeros, POST it back. Challenges expire after 5 minutes.

- **Terms of Service** (`DWN_TERMS_OF_SERVICE_FILE_PATH=/path/to/tos.txt`): GET `/registration/terms-of-service`, display to user, POST `{ termsOfServiceHash, did }` on acceptance. Changing the file invalidates old acceptances.

## Server Info

The `/info` endpoint returns:

```json
{
  "server": "@enbox/dwn-server",
  "maxFileSize": 1073741824,
  "registrationRequirements": ["proof-of-work-sha256-v0", "terms-of-service"],
  "version": "0.1.5",
  "sdkVersion": "0.2.6",
  "webSocketSupport": "true"
}
```

## Development

```bash
bun run build        # compile TypeScript
bun run test         # run tests
bun run lint         # lint
bun run lint:fix     # auto-fix lint issues
bun run server       # start the server
```

## License

Apache-2.0
