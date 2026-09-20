# P0 addressing and ownership proof

This proof tests the contained localhost-port contract selected after the wildcard-subdomain candidate failed in Bun's Linux container runtime.

Each actor receives a distinct canonical `http://localhost:<port>` origin. On the host, the lab gateway publishes those loopback ports. In each container, a byte-preserving TCP forwarder owns the same actor port and connects to the gateway over the lab's private Docker network. Distinct ports preserve browser origin isolation without public DNS or machine hosts-file changes. HTTP and two successive WebSocket connections must preserve the canonical `Host` value from both runtimes.

The proof also launches Chromium without web-security exceptions and checks secure-context status, cross-origin preflight, service-worker traffic, popup origin, and WebSocket reconnects. It creates two identically named labs plus explicit unmanaged sentinels, deletes one lab by its immutable ownership label, and verifies the other lab, an occupied host port, and the unmanaged resources remain available.

Run it from the repository root after `enbox-lab doctor` can reach Docker:

```bash
bun packages/lab/src/cli.ts routing --json
```

The report uses only `pass`, `fail`, and `unsupported`. A native run proves only its current OS and architecture. Linux evidence cannot satisfy the macOS gate; the report keeps `A04-macos-evidence` unsupported until the same harness runs there.

This is a boundary proof, not the finished gateway. The route remains a candidate until real wallets, both server runtimes, forwarding, and native macOS pass the same contract.
