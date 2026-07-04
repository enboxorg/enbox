# Enbox DID

> **Research Preview** — Enbox is under active development. APIs may change without notice.

[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/LiranCohen/02d15f39a46173a612a8862ec6d7cfcf/raw/dids.json)](https://github.com/enboxorg/enbox/actions/workflows/ci.yml)

A comprehensive library for working with Decentralized Identifiers (DIDs) in the Enbox ecosystem.

## Overview

This package provides tools and utilities for creating, resolving, and managing Decentralized Identifiers (DIDs) across various DID methods. It supports multiple DID methods including DHT, JWK, and others.

## Installation

```bash
bun add @enbox/dids
```

## Usage

```typescript
import { DidDht, DidJwk } from '@enbox/dids';

// Create a new DID
const did = await DidDht.create();
console.log(did.uri); // did:dht:...

// Resolve a DID
const resolution = await DidDht.resolve(did.uri);
console.log(resolution.didDocument);
```

Level-backed resolver caching is exported from `@enbox/dids/resolver-cache-level` so DID consumers that only need creation and resolution APIs do not load LevelDB dependencies by default.

## DID DHT Gateway Configuration

In Node/Bun, `DidDht.create()` and `DidDht.resolve()` read
`DID_DHT_GATEWAY_URI` as the default Pkarr gateway when no `gatewayUri` option is
provided. `DID_DHT_ALLOW_PRIVATE_GATEWAY=1` is a separate dev/CI opt-in that
allows private gateway URLs such as local relays.

These environment variables are Node-only defaults. Browser callers should pass
`gatewayUri` and, when intentionally using a private development relay,
`allowPrivateGatewayUri: true` explicitly.

## Project Resources

| Resource                                                                            | Description                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [AGENTS.md](https://github.com/enboxorg/enbox/blob/main/AGENTS.md) | Contributor workflow, style, testing, and release rules |
| [LICENSE](https://github.com/enboxorg/enbox/blob/main/LICENSE)     | Apache License, Version 2.0                             |
