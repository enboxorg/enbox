# `@enbox/connect`

Shared request, wallet, and relay primitives for Enbox Connect.

## Connect v3 device pairing

Connect v3 supports headless applications without sending a PIN through a
terminal, MCP conversation, or hosted page. The application and wallet use the
existing Enbox relay for opaque frames and display the same six-digit
comparison code. The wallet creates grants only after both trusted UIs confirm
the code.

The legacy Connect flow remains available during migration. V3 clients use the
v3 endpoints explicitly and do not downgrade to the PIN flow.

### Requester

```ts
import { ConnectPairingClient } from '@enbox/connect';

const client = new ConnectPairingClient({
  relayOrigin  : 'https://relay.example',
  pairingUiUrl : 'https://connector.pages.dev/pair',

  onPairingReady({ interactionUrl }) {
    // Open this URL, copy it, or render it as a QR code.
    showPairingUrl(interactionUrl);
  },

  async confirmVerificationCode({ verificationCode, walletOrigin }, signal) {
    return await confirmCode({ verificationCode, walletOrigin, signal });
  },
});

const result = await client.connect({
  appName,
  applicationId,
  delegatePortableDid, // requester-owned did:jwk with private keys
  permissionRequests,  // at least one permission scope
});
```

The returned response has passed the v3 transcript checks. Process and validate
its provider-signed grants before activating the session. `AuthManager` remains
the recommended activation boundary for applications.

### Wallet

```ts
import { ConnectPairingProvider } from '@enbox/connect';

await ConnectPairingProvider.handle({
  pairingUri,
  walletOrigin: window.location.origin,

  async decide(request, verificationCode) {
    // Trusted wallet UI selects a profile, shows permissions and the code,
    // then returns only after the user approves and confirms a match.
    return await reviewPairing(request, verificationCode);
  },

  async approve(request, providerDid) {
    return await executeConnectApproval({
      agent,
      providerDid,
      request,
      transport: 'relay',
    });
  },
});
```

`approve` is called exactly once, after the wallet user and requester both
confirm the comparison code. A denial or mismatch creates no grants.

## Relay requirements

The relay must run a compatible `@enbox/dwn-server` exposing
`/connect/v3/pairings`. Pairings expire after ten minutes. The public pairing
URL contains only an opaque locator; requester and wallet bearer capabilities
remain outside URLs, while signed requests, decisions, and responses are
encrypted end to end.
