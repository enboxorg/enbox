# Enbox API SDK

The high-level SDK for building decentralized applications with identity and data management.

## Installation

```bash
bun add @enbox/api
```

## Quick Start

```javascript
import { Enbox } from '@enbox/api';

const { enbox, did: myDid } = await Enbox.connect();

// Create a record
const { record } = await enbox.dwn.records.create({
  data    : 'Hello World!',
  message : { dataFormat: 'text/plain' },
});

// Send it to your remote DWN
await record.send(myDid);
```

## API Documentation

### **`Enbox.connect(options)`**

Connects to a user's local identity agent or generates an in-app DID.

```javascript
const { enbox, did: myDid } = await Enbox.connect();
```

#### Options (all optional)

- **`agent`** - `EnboxAgent` instance. Defaults to a local `EnboxUserAgent`.
- **`connectedDid`** - `string`: an existing DID to connect to.
- **`sync`** - `string`: sync interval (any value accepted by [`ms`](https://www.npmjs.com/package/ms)), or `'off'` to disable. Default: `'2m'`.
- **`techPreview.dwnEndpoints`** - `string[]`: DWN endpoints for the created DID. Default: `['https://enbox-dwn.fly.dev']`.

#### Response

- **`enbox`** - `Enbox` instance with access to DWN operations and DID methods.
- **`did`** - `string`: the DID that was created or connected to.

---

### Record Instances

Methods like `create`, `write`, and `query` return `Record` instances with:

**Properties**: `id`, `contextId`, `dataFormat`, `dateCreated`, `dateModified`, `datePublished`, `encryption`, `protocol`, `protocolPath`, `recipient`, `schema`, `dataCid`, `dataSize`, `published`.

**Methods**:
- **`data.blob()`** / **`data.bytes()`** / **`data.json()`** / **`data.stream()`** / **`data.text()`** - read record data in various formats.
- **`send(did)`** - send the record to a DID's DWN endpoints.
- **`update(request)`** - overwrite the record with new data.

---

### **`enbox.dwn.records.query(request)`**

Query your own or another DID's DWN for records.

```javascript
// Query your own DWN
const { records } = await enbox.dwn.records.query({
  message: {
    filter: {
      schema     : 'https://schema.org/Playlist',
      dataFormat : 'application/json',
    },
  },
});

// Query Bob's DWN
const { records } = await enbox.dwn.records.query({
  from: 'did:example:bob',
  message: {
    filter: {
      protocol   : 'https://music.org/protocol',
      schema     : 'https://schema.org/Playlist',
      dataFormat : 'application/json',
    },
  },
});
```

**Filter properties**: `recordId`, `protocol`, `protocolPath`, `contextId`, `parentId`, `recipient`, `schema`, `dataFormat`.

**Pagination**: `{ limit: number, cursor: string }`. The response includes a `cursor` if more results exist.

---

### **`enbox.dwn.records.subscribe(request)`**

Subscribe to record changes on your own or another DID's DWN.

```javascript
const { status } = await enbox.dwn.records.subscribe({
  message: {
    filter: { protocol: 'https://schema.org/protocols/social' },
  },
  subscriptionHandler: (record) => {
    console.log('received', record);
  },
});
```

---

### **`enbox.dwn.records.create(request)`**

Create a new record and optionally store it locally.

```javascript
const { record } = await enbox.dwn.records.create({
  data    : 'Hello World!',
  message : { dataFormat: 'text/plain' },
});

await record.send(myDid);               // send to your remote DWN
await record.send('did:example:bob');    // send to Bob's DWN
```

Pass `store: false` to create without storing locally (e.g., for records you only send to others).

---

### **`enbox.dwn.records.write(request)`**

Alias for `create()` — same request object.

---

### **`enbox.dwn.records.read(request)`**

Read a specific record by filter (most commonly `recordId`).

```javascript
const { record } = await enbox.dwn.records.read({
  message: {
    filter: { recordId: 'bfw35evr6e54c4cqa4c589h4cq3v7w4nc534c9w7h5' },
  },
});

console.log(await record.data.text());
```

Use `from: 'did:example:bob'` to read from another DID's DWN.

---

### **`enbox.dwn.records.delete(request)`**

Delete a record by ID.

```javascript
await enbox.dwn.records.delete({
  message: { recordId: 'bfw35evr6e54c4cqa4c589h4cq3v7w4nc534c9w7h5' },
});
```

---

### **`enbox.dwn.protocols.configure(request)`**

Install a protocol definition on your DWN.

```javascript
const { protocol } = await enbox.dwn.protocols.configure({
  message: {
    definition: {
      protocol  : 'https://photos.org/protocol',
      published : true,
      types: {
        album : { schema: 'https://photos.org/album', dataFormats: ['application/json'] },
        photo : { schema: 'https://photos.org/photo', dataFormats: ['application/json'] },
        image : { dataFormats: ['image/png', 'image/jpeg', 'image/gif'] },
      },
      structure: {
        album: {
          $actions: [{ who: 'recipient', can: 'read' }],
        },
        photo: {
          $actions: [{ who: 'recipient', can: 'read' }],
          image: {
            $actions: [{ who: 'author', of: 'photo', can: 'write' }],
          },
        },
      },
    },
  },
});

await protocol.send(myDid); // sync to remote DWNs
```

---

### **`enbox.dwn.protocols.query(request)`**

Query a DID's DWN for installed protocols.

```javascript
const { protocols } = await enbox.dwn.protocols.query({
  from: 'did:example:bob',
  message: {
    filter: { protocol: 'https://music.org/protocol' },
  },
});
```

---

### **`enbox.did.create(method, options)`**

Generate a DID using a supported method (`'dht'` or `'jwk'`).

```javascript
const myDid = await enbox.did.create('dht');
```

Pass `store: false` in options to skip storing the DID's keys in the agent.

---

### **`enbox.did.resolve(didUri)`**

Resolve a DID to its DID Document.

```javascript
const { didDocument } = await enbox.did.resolve(
  'did:dht:qftx7z968xcpfy1a1diu75pg5meap3gdtg6ezagaw849wdh6oubo'
);
```

## License

Apache-2.0
