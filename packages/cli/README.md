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
  Enbox,
  defineApplicationManifest,
  getApplicationProtocolRequests,
} from '@enbox/cli';

const application = defineApplicationManifest({ protocols: [NotesProtocol] });

const { enbox, session } = await Enbox.connect({
  connectHandler: CliConnectHandler({
    appName          : 'Notes CLI',
    connectServerUrl : 'https://your-dwn.example/connect',
  }),
  protocols: getApplicationProtocolRequests(application),
});

await enbox.protocols.ensureReady({ application, publication: 'required' });
```

Await readiness before running protocol-backed commands. Owner sessions
publish the exact local protocol artifact; delegated sessions verify and
import the wallet-owned artifact without publishing it.

The handler uses the existing encrypted relay flow:

1. The CLI pushes an encrypted request to the connect relay.
2. The CLI prints a QR code and link for the wallet approval page.
3. The user approves in the wallet and enters the wallet-displayed PIN in the terminal.
4. The handler returns the delegated DID and grants to `Enbox.connect()`.

The relay URL resolves from `connectServerUrl`, then `connectServerUrlProvider`,
then the wallet origin's `/.well-known/enbox-connect` document
(`{ "connectServerUrl": "https://dwn.example/connect" }`), then an interactive
prompt. Sessions request a 30-day TTL by default; wallets may clamp it.

Set `openBrowser: true` to open the generated wallet URL on the same machine
instead of printing a QR code.
