# Enbox Agent

> **Research Preview** — Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/agent.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

The agent framework for decentralized identity management — handles identities, keys, DWN storage, sync, and wallet connect.

## Overview

The agent is the core runtime that ties everything together. It manages:

- **Identity vault** — BIP-39 seed phrase + password-encrypted agent DID (`HdIdentityVault`)
- **Key management** — In-process key generation, import/export, HD derivation, ECIES decryption (`LocalKeyManager`)
- **DWN operations** — Read/write/query records, module installation, encryption callbacks (`AgentDwnApi`)
- **Identity lifecycle** — Create, list, import/export identities and DIDs (`AgentIdentityApi`, `AgentDidApi`)
- **Sync** — Bidirectional sync between local and remote DWNs (`SyncEngineLevel`)
- **Permissions** — DWN permission grants, requests, and revocations (`AgentPermissionsApi`)
- **Wallet connect** — Enbox Connect approval ceremony granting delegated access to external apps (`executeConnectApproval`)

Durable `grantKey` records hydrate delegate decryption keys for encrypted read grants.
They are usable only while the referenced permission grant is active. Revocation is
observed from the grantee's local DWN state, so enforcement follows delivery or sync
of the revocation record.

## Installation

```bash
bun add @enbox/agent
```

## Usage

```typescript
import { EnboxUserAgent } from '@enbox/agent';

// Create and initialize a new agent
const agent = await EnboxUserAgent.create();
await agent.initialize({ password: 'user-password' });
await agent.start({ password: 'user-password' });

// Create an identity
const identity = await agent.identity.create({
  didMethod : 'dht',
  metadata  : { name: 'Alice' },
});

// Store a record in the agent's local DWN
const response = await agent.dwn.processRequest({
  author      : identity.did.uri,
  target      : identity.did.uri,
  messageType : DwnInterface.RecordsWrite,
  messageParams : {
    dataFormat : 'application/json',
  },
  dataStream : new Blob([JSON.stringify({ hello: 'world' })]),
});

// Sync with remote DWN(s)
await agent.sync.sync();
```

## Owner authentication during Connect

`executeConnectAuthentication({ agent, providerDid, request, verifiedRequesterOrigin })`
approves an identity-only `requestType: 'authenticate'` request. It signs with
the selected locally owned DID's authentication key through the key manager,
and returns `authenticationProof` plus an ephemeral envelope signer. It does
not create a data delegate, install modules, write grants, or open a session.
Pass the result as `approval` to `ConnectProvider.sealAuthenticationResponse`.

An authentication-bearing delegation request goes through
`executeConnectApproval` and returns the proof alongside its grants. Pass the
original full request and the separately verified requester origin; rewriting
request metadata would change the proof's transaction binding. The ceremony
uses the verified origin for stored session metadata. The origin must come
from the popup transport or a trusted, service-owned relay policy, never from
`applicationId`, the claimed audience, or other request display hints. Parsing
`new URL(request.authentication.audience).origin` does not establish trust.

For relay authentication, a wallet policy must independently establish the
request's provenance: fetch the registered transaction request from the
authentication service's HTTPS origin, reject redirects, bind that fetched
request to the observed origin, and require the audience's origin to match.
An arbitrary upload to a public relay does not meet that requirement. The SDK
accepts the policy's result; it does not authenticate a relay by accepting an
origin string. Show the service audience prominently in consent and ask the
user to approve only a transaction they initiated. Provenance alone does not
prevent an attacker from forwarding a real service's QR transaction; a branded
origin type alone would not prevent that either.

Owner authentication requires an HTTPS audience, including during local
development. Use a local HTTPS origin or an HTTPS development tunnel. The
shared origin validator also accepts HTTP for ordinary delegation; this does
not enable owner authentication from `http://localhost`.

The receiving service must call `verifyOwnerAuthenticationProof` with its
stored full request and a separate `expected: { audience, challenge }`: take
the audience from service configuration and the challenge from its issued,
pending transaction. Never take either expected value from an incoming proof
or client-supplied request. Require atomic consumption of that issued
transaction when establishing an account session or issuing an OAuth code.
A replay store must reject unknown, expired, consumed or mismatched bindings;
remembering previously seen proofs is insufficient. DWN delegation and owner
authentication remain distinct even when approved together.

An owner proof expires 300 seconds after signing. The response envelope has a
separate 600-second lifetime after sealing; the earlier deadline governs a
successful authentication. Relay PIN entry happens before decryption, so a
slow PIN entry can reveal a still-valid envelope containing an expired proof.
Login must fail in that case. Start a fresh authentication transaction and
reconcile any already-approved grants before retrying combined mode; never
extend the proof's lifetime because the envelope remains valid.

`ConnectAuthenticationError` has a fixed public message and code. A signer
acquisition failure retains its original error as `cause` for trusted local
diagnostics. Causes may contain implementation or key-manager details; do not
serialize them as part of the public authentication error response.

Combined approval is not atomic across DWN writes and the final authentication
signature. If signing fails after grant delivery, the promise rejects and no
successful combined result is returned, but modules or grants may already
exist. The caller must reconcile the outcome and revoke or reuse approved
delegation as appropriate; it must not report rollback or retry grant creation
blindly. The service must not complete login without a verified owner proof.

Wallet capability discovery/negotiation is not implemented by these helpers.
Older wallets reject the identity-only request type. An older wallet receiving
a combined request may create the explicitly requested grants while omitting
the proof, causing the client to reject login afterward. Enable combined mode
only for wallets whose authentication support is known until an advertisement
and preflight capability check is available.

## Key Classes

| Class | Purpose |
|---|---|
| `EnboxUserAgent` | Main agent — composes all sub-APIs into a single runtime |
| `HdIdentityVault` | Seed phrase vault, password-encrypts agent DID as CompactJWE |
| `LocalKeyManager` | In-process key management with HD derivation and ECIES |
| `AgentDwnApi` | DWN message processing, encryption/decryption callbacks |
| `AgentDidApi` | DID creation (`did:dht`, `did:jwk`), resolution, import/export |
| `AgentIdentityApi` | Identity CRUD (DID + metadata) |
| `AgentPermissionsApi` | Permission grant/request/revocation management |
| `SyncEngineLevel` | LevelDB-backed bidirectional sync engine from `@enbox/agent/level` |
| `DwnKeyStore` | Encrypted private key storage in DWN |
| `DwnDidStore` | DID storage in DWN |
| `DwnIdentityStore` | Identity metadata storage in DWN |
| `PlatformAgentTestHarness` | Test infrastructure from `@enbox/agent/test` |

## Browser Runtime

`@enbox/agent` is isomorphic. Its root export declares a browser condition that
points browser-aware bundlers at `dist/browser.mjs`, so apps and service workers
do not need Node global shims for the package entrypoint.

The default persistent stores are still Level-backed. In Node, `level` uses
`classic-level` on the filesystem. In browsers, it resolves to `browser-level`
over IndexedDB. That IndexedDB-backed Level stack is intentional: multiple app
tabs, workers, and service workers can open and write the same origin database
concurrently, with the browser coordinating transactions.

Use injected agent components only when you are deliberately replacing part of
the runtime. Avoid in-memory stores for production browser apps, because they
lose persistence and cross-context write coordination.

Direct access to Level-backed implementation classes lives under
`@enbox/agent/level`; test utilities live under `@enbox/agent/test`. Keeping
those modules off the root export prevents bare browser imports from resolving
the Level stack before an agent is actually created.

## Development

```bash
# Build (rebuild dwn-sdk-js first if it changed)
bun run --filter @enbox/dwn-sdk-js build
bun run --filter @enbox/agent build

# Start test infrastructure (Pkarr relay, Postgres, MySQL, NATS) from repo root
docker compose -f docker-compose.test.yaml up -d --wait
export DID_DHT_GATEWAY_URI=http://localhost:7527
export DID_DHT_ALLOW_PRIVATE_GATEWAY=1

# Full agent test suite (bun:test)
bun run test:node

# Single test file
bun test tests/store-key.spec.ts

# Filter by test name
bun test tests/dwn-api.spec.ts -t 'AgentDwnApi.drainPendingEagerSends'

# Lint (from repo root)
bun run lint
```

Tests use the native `bun test` runner (see `bun:test` + `sinon` in each spec file).
`PlatformAgentTestHarness.clearStorage()` and `closeStorage()` drain any in-flight
eager-send coroutines before releasing storage, so downstream consumers can safely
tear down between tests without `LEVEL_DATABASE_NOT_OPEN` noise.

## License

Apache-2.0
