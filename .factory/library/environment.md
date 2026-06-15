# Environment

Required env vars, external dependencies, and setup notes for the eager-send-drain mission.

**What belongs here:** Env var names and expected values, external service dependencies beyond the `services.yaml` manifest, dependency quirks, platform notes.
**What does NOT belong here:** Service ports/start/stop commands — those are in `.factory/services.yaml`.

---

## Required env vars for agent tests

| Var | Value | Why |
|---|---|---|
| `DID_DHT_GATEWAY_URI` | `http://localhost:7527` | Required by `@enbox/agent` tests (~115 tests fail without it: `DidError: internalError: Failed to put Pkarr record`). Points to the Pkarr relay in `docker-compose.test.yaml`. |
| `NATS_URL` | `nats://localhost:4222` | Required by dwn-server NatsEventBus plugin tests. Not strictly needed for the agent tests this mission modifies, but set by `init.sh` for completeness. |

## DWN server on :3000

A local DWN server is required by most agent tests. `init.sh` starts one if `GET http://localhost:3000/info` does not respond. The server uses the postgres-dwn service (localhost:5433) for storage.

If the server is running but misbehaving, stop it via `lsof -ti :3000 | xargs -r kill` and let `init.sh` restart it.

## Bun runtime

Runtime: `bun >= 1.0.0` (per repo root `package.json`). All test commands use `bun test`. `bunx` is Bun's npx-equivalent.

Do NOT use `npm` or `npx` for test commands — they miss the Bun-specific test runner semantics that this codebase relies on (bun:test's parallel-within-file behavior, unhandled-rejection reporting format, etc.).

## Platform

Linux only (per system info: `linux 6.8.0-71-generic`). macOS/Windows have NOT been verified for this mission. `docker-compose.test.yaml` assumes a Linux Docker daemon.

## Changeset

The mission's final feature adds a `.changeset/*.md` with `@enbox/agent: patch`. Do NOT run `bunx changeset version` locally — that is CI's job.
