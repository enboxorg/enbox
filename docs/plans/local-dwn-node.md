# Local DWN node — v1 implementation plan

Tracking epic: [#1162](https://github.com/enboxorg/enbox/issues/1162) · Decided 2026-07-06

## Goal

A browser dapp on Chromium or Firefox detects a paired local DWN node, drains its in-process DWN into it, and runs storeless against `localhost` — reversibly, with the mobile-first wallet untouched as the holder of master keys. v1 ships as a macOS tray app (`@enbox/electrobun-dwn`) plus a headless CLI node that runs on every OS.

The problem this solves: today each dapp origin runs its own in-process DWN in IndexedDB and syncs it to a remote DWN. Dapps connected to the same identity each replicate the same records per origin, each with its own sync loop. With a local node, one machine holds one copy and dapps hold none.

## Background — what exists today

- **Remote mode exists but is unexercised.** `EnboxUserAgent.create({ localDwnEndpoint })` skips the in-process DWN and routes all DWN operations over RPC (`packages/agent/src/enbox-user-agent.ts:193-208`, `packages/agent/src/dwn-api.ts:484-546`). No example or e2e path uses it.
- **Discovery machinery exists but the trigger is dead.** `AuthManager.create()` runs `discoverLocalDwn()` before agent creation (`packages/auth/src/auth-manager.ts:166-180`); the only initiator, `requestLocalDwnDiscovery()` (a `dwn://connect` redirect dance), has no non-test callers. Endpoint validation is `GET /info` returning `server === '@enbox/dwn-server'` — spoofable by any local process.
- **The desktop app embeds a stock server.** `electrobun-dwn` runs `DwnServer` on `127.0.0.1` (candidate ports `[3000, 55500–55509]`), writes a `~/.enbox/dwn.json` discovery file, and handles `dwn://` links. It has no single-instance lock, no launch-at-login, no pairing, and its webview port-probes a hardcoded list because the bun process cannot pass the selected port to it.
- **The server has no local trust model.** `dwn-server` hardcodes `Access-Control-Allow-Origin: *`, does no Origin/Host validation, and admits any tenant when no registration store is configured.
- **Sync is agent-driven and multi-remote.** `SyncEngineLevel` keeps per-`(tenant, endpoint)` checkpoints and supports several remotes concurrently; the connect flow always mints `Messages Query/Read/Subscribe` grants, so connected dapps already hold sync authority.
- **Browser constraints (2026).** Chromium (142/147+) and Firefox (149/151+) allow https-page → `http://127.0.0.1` fetch and WebSocket behind a one-time per-origin Local Network Access permission prompt. Safari blocks plain http/ws to loopback entirely; its only channel is WebTransport with pinned rotating certificates.

## Decision record

1. **The node is dumb.** A stock multi-tenant `dwn-server` holding **zero identity key material** — only transport pairing secrets. Master keys stay in the wallet (mobile-first). Dapps keep driving sync with grants they already hold, so the node stays fresh while any dapp is open — the same freshness today's in-process DWNs have. Rejected alternatives: desktop-as-wallet (anchors identity to one machine; contradicts the mobile-wallet direction) and device-delegate-in-v1 (forces the grant-TTL problem into v1).
2. **Detect-only UX.** The app starts at login; dapps probe after a user gesture. Total prompts: one browser LNA prompt per origin, one desktop pairing consent per origin. `dwn://` wake-up is a fast-follow (needs single-instance URL forwarding); install nudges never ship in the SDK — dapps get a status API and build their own.
3. **Reversible eject; a reachable remote DWN stays the durable anchor** (hosted or self-hosted — whatever the DID document's `#dwn` service lists). Eject = drain → verify parity → flip → delete local DWN stores. Fallback re-materializes the in-process DWN at session boundaries. Mid-session node death = pause/retry with events, no hot switch. Node reappears = auto re-eject without re-consent.
4. **Platform matrix.** macOS tray app + headless CLI node everywhere; Chromium + Firefox; Safari and other gaps fall back silently to today's path, and the SDK distinguishes `unsupported` from `not-found`.
5. **Shell.** Electrobun for v1 (macOS is its strong zone; the bun process runs the server in-process). The node core is shell-agnostic so the shell is swappable; a time-boxed Electrobun-vs-Electron decision gate runs at the Windows fast-follow (Windows signing + scheme registration + second-instance forwarding must prove out, else port the thin shell to Electron with a compiled Bun sidecar).
6. **v2 (designed-for now, built later): replication-only device delegate.** Per identity, opt-in: a delegate holding only `Messages Query/Read/Subscribe` grants — no Records authority, no grantKeys — so the node syncs ciphertext in the background without any dapp open. Blocked on long-lived/renewable grants (today's delegate grants: 24h TTL, no renewal) and wallet-side device management/revocation UX.

## v1 architecture

```
mobile wallet (master keys) ──connect: delegate DID + grants──▶ dapps
                                                                 │  localhost RPC + WS
                                                                 │  (per-origin pairing token)
                                                                 ▼
                local node = stock dwn-server, multi-tenant, no identity keys
                (macOS tray app or headless CLI; discovery file; pairing broker)
                                                                 ▲
             dapp sync engines replicate: local node ⇄ reachable remote DWN
```

**Pairing flow.** Dapp probes `GET /info` on the shared port list (gesture-triggered; LNA prompt on first probe) → `POST /local/pair` with app name/icon; the request is rate-limited and coalesced per origin → node surfaces consent UI (tray/native dialog, origin displayed verbatim) → approval mints a per-origin bearer token, returned via poll of `GET /local/pair/:id` → dapp persists `{ endpoint, token }` and attaches the token to every HTTP request and WS connect.

**Boot flow.** Persisted pairing → silent revalidation (`/info` + token) → remote-mode agent. No pairing or validation failure → in-process DWN exactly as today.

**Eject flow.** Pairing succeeds mid-session → localhost endpoint added as an extra sync target → push to parity (push checkpoint contiguous-applied reaches local event-log head for every registered tenant) → flip persisted; remote mode engages at next session start or an SDK-offered one-time reload → local DWN/sync stores deleted. The vault and auth session storage are never deleted.

**Failure flow.** Mid-session RPC failures → bounded retry/backoff, `local-dwn-unavailable` event, operations fail visibly after retries. Next session start with the node still gone → in-process fallback (re-hydrates from the remote via sync). Node back → drain (mostly duplicate-skips) → flip at next boundary.

## Phases

### Phase 0 — Harden remote mode + foundations ([#1163](https://github.com/enboxorg/enbox/issues/1163))

Remote mode is the seam everything rides on; it gets proven first.

- Integration suite running the agent test matrix against a live in-process `DwnServer` via `localDwnEndpoint`: full sync cycle with the node as the "local side" (push/pull, checkpoints), WS subscriptions through the node, multi-tenant behavior.
- Resolve the `sync-admit-closure.ts:263-267` remote-mode degradation: determine what admission validation loses without a local message store, fix or explicitly bound it.
- Centralize the port candidate list in one exported constant (today duplicated in `electrobun-dwn/src/bun/index.ts:20` and `electrobun-dwn/src/mainview/services/server-status.ts:8`); reorder dedicated range (`555xx`) first, `3000` last.
- Reconcile the `localDwnStrategy` default divergence (`'prefer'` at `dwn-api.ts:212` vs documented `'off'` at `auth/types.ts:304-309`) with the new semantics: discovery never probes without a persisted pairing or an explicit gesture call.
- The `DeliveryService` empty-body forwarding bug (`packages/dwn-server/src/delivery-service.ts:690`) is tracked separately as [#1169](https://github.com/enboxorg/enbox/issues/1169) — adjacent, not in this epic's path.

### Phase 1 — Trust layer: local-node profile + `@enbox/local-node` ([#1164](https://github.com/enboxorg/enbox/issues/1164))

All server changes are behind an opt-in local-node profile; zero impact on cloud deployments.

- `dwn-server` middleware: `Host` header validation against loopback names (DNS-rebinding defense); per-origin bearer tokens required on every request except `GET /info` and the pairing endpoints, enforced on HTTP and WS upgrade; CORS reflects paired origins only (replaces `*` under the profile).
- Pairing endpoints: `POST /local/pair` → `{ requestId }`; poll `GET /local/pair/:id` → approved (token, once) / denied / expired. Rate-limited + coalesced per origin.
- `/info` additions: `localNode: true` + pairing endpoint pointer; nothing tenant-specific.
- New package `@enbox/local-node`: composes `DwnServer` (local profile) + pairing store + `PairingBroker` interface (TTY prompt in CLI, native dialog in the app) + discovery-file writer + single-instance check (discovery-file PID + `/info` liveness) + status API. Ships a `bin` (headless node) with `--allow-origin` for dev/CI. Non-browser local clients (no `Origin`) authenticate via a token carried in the discovery file.
- Wire the package into the build/lint/turbo graph.

### Phase 2 — SDK: detection + pairing client ([#1165](https://github.com/enboxorg/enbox/issues/1165))

- `probeLocalDwn()` in `@enbox/auth`: gesture-triggered, walks the shared port list, feature-detects Safari/insecure contexts up front; returns `unsupported | not-found | found-unpaired | paired`. Delete `requestLocalDwnDiscovery()` and the `dwn://connect` redirect detection path (the `dwn://` scheme stays reserved for the wake-up fast-follow).
- Pairing client: initiate + poll, persist `{ endpoint, token }` (extends the existing `STORAGE_KEYS.LOCAL_DWN_ENDPOINT` handling in `packages/auth/src/discovery.ts`).
- `dwn-clients`: per-endpoint auth attachment — bearer token on HTTP requests and WS connect — threaded through `EnboxRpcClient` / `HttpEnboxRpcClient` / `WebSocketEnboxRpcClient`.
- `AuthManager`: silent revalidation + remote-mode boot with token auth; `enableLocalNode()` orchestration for the first-time gesture flow; node-status API and pairing-state events alongside the existing `local-dwn-available`/`local-dwn-unavailable`.

### Phase 3 — Eject, fallback, auto re-eject ([#1166](https://github.com/enboxorg/enbox/issues/1166))

- `drainTo(endpoint)`: register the paired endpoint as an additional sync target; report progress; completion = push checkpoint contiguous-applied at local event-log head for every registered tenant.
- Flip: persisted ejected marker; remote mode engages at the next session boundary or an SDK-offered one-time reload. Create-time switching only — no live agent surgery.
- Delete after verified drain + successful remote-mode boot: `DWN_MESSAGESTORE`, `DWN_DATASTORE`, `SYNC_STORE` Level stores only. Never the vault or auth session storage.
- Fallback: in-process boot when probe/validation fails (existing default path, now tested against post-eject state); mid-session bounded retry/backoff + events.
- Auto re-eject: persisted pairing + node reappears → drain and flip at next boundary, no re-consent.

### Phase 4 — Desktop app rework (`electrobun-dwn`) ([#1167](https://github.com/enboxorg/enbox/issues/1167))

- Delete the identity runtime from the app (identity-create wizard, pin-pad, identity-switcher, the mainview `AuthManager`). The node holds no identity keys; dormant wallet code contradicts the trust story. Git history preserves it.
- Rebuild mainview: node status (port, storage, tenants), paired-apps list + revoke, pairing consent dialog (also reachable from tray notification).
- Embed `@enbox/local-node` in the bun process; pass the selected port to mainview over Electrobun RPC; delete the `server-status.ts` port-probing workaround.
- Single-instance via the local-node liveness check; launch-at-login (macOS `LaunchAgent`/`SMAppService`) with a UI toggle.
- Signing + notarization via the Electrobun CLI; wire the Electrobun updater if cheap, else first fast-follow.

### Phase 5 — Prove end-to-end + ship ([#1168](https://github.com/enboxorg/enbox/issues/1168))

- Modern example dapp (new example or dapp-demo refresh — the submodule is pinned to the pre-`Enbox` API generation) demonstrating connect → detect → pair → eject → kill-the-node fallback → auto re-eject.
- Docs: dapp-developer guide (status API, UX around the LNA prompt) + headless-node note for self-hosters; manual QA checklist for the flows CI cannot automate (LNA grant, consent dialogs, login-item behavior).
- Changesets for every touched package (all patch).

## Security requirements (acceptance criteria for phases 1–2)

Loopback bind only · `Host` validation · Origin + token on every non-`/info` request including WS upgrade · CORS reflects paired origins only · pairing rate-limit and per-origin coalescing · consent UI displays the requesting origin verbatim · no exec/install/update endpoints on the local API · revocation takes effect immediately · `/info` reveals nothing tenant-specific.

## Verify during implementation

1. Remote-mode sync completeness — Phase 0's purpose; the plan's largest assumption.
2. Whether `applyReplicatedMessage` imposes caller-level authority beyond each message's self-authorization (affects drain now, the v2 delegate later).
3. Whether Messages grants can be tenant-wide rather than per-protocol (shapes v2 enrollment; cheap to check while in the code).

## Out of scope for v1

- `dwn://` wake-up + Windows app — bundled fast-follow, with the shell decision gate (Decision 5).
- Linux tray app — the headless CLI node covers Linux meanwhile.
- Safari / WebTransport channel — parked pending demand; Safari users keep today's in-process path.
- v2 replication delegate, grant TTL/renewal, wallet device management — designed-for, not built.
- Desktop-anchored identity — deleted from the app, not parked.

## Sequencing

0 → 1 → 2 → 3 serial (each consumes the previous); 4 parallel from Phase 1 onward; 5 closes. Heavy: 1 and 3. Medium: 0 and 2. Medium-light: 4 after the identity-runtime deletion. Light but gating: 5.
