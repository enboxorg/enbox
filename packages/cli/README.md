# Enbox CLI

> **Research Preview** — Enbox is under active development. APIs may change without notice.

`@enbox/cli` provides Node/Bun-specific helpers for terminal applications that
need Enbox sessions.

## Install

```bash
bun add @enbox/cli
```

## Usage

```ts
import {
  CliConnectHandler,
  createConnectionStore,
  defineApplicationManifest,
} from '@enbox/cli';

const application = defineApplicationManifest({
  protocols: [{ protocol: NotesProtocol, permissions: ['write'] }],
} as const);
const store = createConnectionStore({
  application,
  connectHandler: CliConnectHandler({
    appName          : 'Notes CLI',
    connectServerUrl : 'https://your-dwn.example/connect',
  }),
});

let snapshot = await store.initialize();
if (snapshot.phase === 'disconnected') {
  snapshot = await store.connect();
}
if (snapshot.phase !== 'connected') {
  throw snapshot.error ?? new Error('Connection was not established.');
}

const enbox = snapshot.enbox!;

// ...use enbox...

await store.disconnect();
await store.dispose();
```

The handler uses the existing encrypted relay flow:

1. The CLI pushes an encrypted request to the connect relay.
2. The CLI prints a QR code and link for the wallet approval page.
3. The user approves in the wallet and enters the wallet-displayed PIN in the terminal.
4. The handler returns the delegated DID and grants to the connection store.

The relay URL resolves from `connectServerUrl`, then `connectServerUrlProvider`,
then the wallet origin's `/.well-known/enbox-connect` document
(`{ "connectServerUrl": "https://dwn.example/connect" }`), then an interactive
prompt. Sessions request a 30-day TTL by default; wallets may clamp it.

Set `openBrowser: true` to open the generated wallet URL on the same machine
instead of printing a QR code.
