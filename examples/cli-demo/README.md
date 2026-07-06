# Enbox CLI Demo

This example exercises the CLI wallet-connect lifecycle:

1. Connect with `CliConnectHandler` through the relay QR/link flow.
2. Write one protocol record as the delegated session.
3. Shut down the auth manager to simulate a process restart.
4. Restore the persisted session and write another record.
5. Disconnect, requesting self-revocation for the session grants.

Run it from the repository root after `bun install`:

```bash
ENBOX_CONNECT_SERVER_URL=https://your-dwn.example/connect \
  bun examples/cli-demo/src/connect.ts
```

Use `--open` to open the wallet approval URL in the local browser instead of
printing only a terminal QR code:

```bash
ENBOX_CONNECT_SERVER_URL=https://your-dwn.example/connect \
  bun examples/cli-demo/src/connect.ts --open
```

The demo imports the local `packages/cli/src` entrypoint so it runs before
`@enbox/cli` is published. Downstream apps should import from `@enbox/cli`.
