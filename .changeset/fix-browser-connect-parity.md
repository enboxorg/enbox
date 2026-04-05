---
"@enbox/browser": patch
---

fix: browser DWeb Connect client now parses full ConnectResult including delegate encryption artifacts

The browser popup connect flow was only extracting delegateDid, connectedDid, and
grants from the wallet's postMessage response — missing delegateDecryptionKeys,
delegateContextKeys, delegateMultiPartyProtocols, and sessionRevocations. Without
these, the delegate session had no decryption material, causing encrypted records
to be unreadable after page refresh and key-delivery protocol closure failures.
