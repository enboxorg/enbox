# P0 real Pkarr persistence proof

This harness runs the repository-pinned `synonymsoft/pkarr-relay` image by digest with the exact `pkarr-relay --testnet` command. It gives the relay a randomly named, labeled bridge with IP masquerading disabled and exposes only a random loopback port to the host-side publication adapter. Testnet mode supplies the private in-container DHT; disabling masquerading prevents ordinary container egress while retaining host port publishing.

The proof creates and publishes a fresh `did:dht`, resolves it through the real relay, deletes the exact upstream container, creates a distinct relay container with no retained upstream state, and starts a new adapter over the existing SQLite journal. Adapter startup replays the exact accepted signed packet before admitting traffic; it receives neither the DID signer nor a publisher callback. A second SDK resolution must reproduce the original DID document. The finalizer removes only the exact generated container, network, and journal directory. The digest-pinned image is shared input and is deliberately preserved.

Run from the repository root with Docker Engine available:

```bash
bun packages/lab/src/cli.ts did-runtime --json
```

A successful short run still reports `unsupported`. The post-replay SDK resolution starts with a fresh SDK call and a recreated relay, but replay itself can populate the relay's cache; it is not a cache-bypassing, network-only DHT read. The harness also does not wait beyond the upstream retention window or exercise host sleep/wake. Those cache and long-soak obligations remain separate gates, and this proof does not claim them.
