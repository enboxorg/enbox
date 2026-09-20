# Enbox Lab

`@enbox/lab` is the private controller and proof workspace for isolated local Enbox environments. P0 contains executable boundary proofs; it is not yet the finished controller or UI.

Run the local prerequisites and source catalog checks from the repository root:

```sh
bun packages/lab/src/cli.ts doctor --json
bun packages/lab/src/cli.ts catalog --mode source --json
bun packages/lab/src/cli.ts prepare --artifact dwn-server-0.1.43 --output /tmp/enbox-lab-artifacts --json
```

The fixture catalog check deliberately returns a nonzero `unsupported` verdict until immutable historical images, the observer launcher and runtime evidence exist:

```sh
bun packages/lab/src/cli.ts catalog --mode fixture --json
```

The routing proof creates randomly named, ownership-labeled Docker resources and removes its exact resources when it finishes:

```sh
bun packages/lab/src/cli.ts routing --json
bun packages/lab/src/cli.ts did-runtime --json
```

It uses a distinct `http://localhost:<actor-port>` origin for each actor. The host gateway publishes those ports, while actor-local IPv4/IPv6 forwarders preserve the same URLs inside containers. Actors stay on per-lab internal networks; only the gateway also joins a host-ingress network. See [`src/proofs/routing/README.md`](src/proofs/routing/README.md) for the decision and evidence boundary.

The durable Pkarr adapter stores only upstream-accepted signed public packets. It serializes publication, restoration and maintenance per key, rejects stale or conflicting equal-sequence packets, retains exact bytes and 64-bit sequence precision, restores before readiness, and never serves resolution from the journal. A publisher whose different update receives an equal-sequence conflict must create a later signed version; the adapter cannot alter a signed sequence. See the DID runtime proof README for the remaining cache-bypass and retention gates.

The connect proof keeps popup origin/source checks and ephemeral request decryption in the provider page, then binds the validated request to a short-lived one-shot worker capability. See [`src/proofs/connect/README.md`](src/proofs/connect/README.md).

Package validation:

```sh
bun run --filter @enbox/lab lint
bun run --filter @enbox/lab build
bun run --filter @enbox/lab test:node
```

All proof reports use `pass`, `fail`, and `unsupported`. Unsupported evidence never counts as a passing P0 or release gate.
