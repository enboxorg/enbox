---
"@enbox/agent": patch
---

feat(agent): connect approval ceremony performs encryption upgrades and fail-closed remote protocol verification

`executeConnectApproval`'s per-protocol preparation (new `connect-protocol-preparation.ts`) now owns what wallets previously had to do before calling the ceremony: it rejects requester-supplied `$keyAgreement`/`$encryption` metadata and non-normalized protocol URIs, verifies installed definitions against the request (and installed `$keyAgreement` public keys against the provider's key deriver by JWK thumbprint), re-configures policy-identical installs that are missing encryption keys (encryption upgrade), verifies every reachable owner DWN endpoint before configuring (a reachable endpoint rejecting the query, a remote definition/key conflict, or zero reachable endpoints abort the approval), and fans the configure out with a fail-closed convergence postcondition. Wallets no longer need their own pre-approval `prepareProtocol` step.

Behavior changes: an approval against a provider whose resolved endpoints are all unreachable now fails during protocol preparation instead of at grant delivery, and an installed-but-unencrypted protocol is now actually upgraded (previously the ceremony skipped any locally installed protocol, so encrypted writes against it kept failing after connect).
