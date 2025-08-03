# Enbox DID

A comprehensive library for working with Decentralized Identifiers (DIDs) in the Enbox ecosystem.

## Overview

This package provides tools and utilities for creating, resolving, and managing Decentralized Identifiers (DIDs) across various DID methods. It supports multiple DID methods including DHT, JWK, and others.

## Installation

```bash
npm install @enbox/dids
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

## Project Resources

| Resource                                                                            | Description                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [CODEOWNERS](https://github.com/enboxorg/enbox/blob/main/CODEOWNERS)              | Outlines the project lead(s)                                                 |
| [CODE_OF_CONDUCT.md](https://github.com/enboxorg/enbox/blob/main/CODE_OF_CONDUCT.md) | Expected behavior for project contributors, promoting a welcoming environment |
| [CONTRIBUTING.md](https://github.com/enboxorg/enbox/blob/main/CONTRIBUTING.md)    | Developer guide to build, test, run, access CI, chat, discuss, file issues   |
| [GOVERNANCE.md](https://github.com/enboxorg/enbox/blob/main/GOVERNANCE.md)        | Project governance                                                            |
| [LICENSE](https://github.com/enboxorg/enbox/blob/main/LICENSE)                    | Apache License, Version 2.0                                                   |