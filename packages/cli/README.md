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
import { CliConnectHandler, Enbox } from '@enbox/cli';

const { enbox, session } = await Enbox.connect({
  connectHandler: CliConnectHandler({
    appName          : 'Notes CLI',
    connectServerUrl : 'https://your-dwn.example/connect',
  }),
  protocols: [NotesProtocol],
});
```

The handler uses the existing encrypted relay flow:

1. The CLI pushes an encrypted request to the connect relay.
2. The CLI prints a QR code and link for the wallet approval page.
3. The user approves in the wallet and enters the wallet-displayed PIN in the terminal.
4. The handler returns the delegated DID and grants to `Enbox.connect()`.

Set `openBrowser: true` to open the generated wallet URL on the same machine
instead of printing a QR code.
