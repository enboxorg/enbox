# Electrobun DWN

Desktop package that runs `@enbox/dwn-server` inside an Electrobun native app.

Closing the app window does **not** stop the DWN server. The process keeps
running in the background so local clients can continue sending requests.
To stop it, quit the app process.

## Run

From the repo root:

```bash
bun install
bun run --filter @enbox/electrobun-dwn dev
```

To start from a clean slate (wipe local DWN storage + renderer DID/auth storage):

```bash
bun run --filter @enbox/electrobun-dwn dev:clean
```

This is intended for local development/testing only.

## Build

```bash
bun run --filter @enbox/electrobun-dwn build
```
