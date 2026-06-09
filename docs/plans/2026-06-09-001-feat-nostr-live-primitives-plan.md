---
title: "feat: NOSTR ephemeral-broadcast primitives (#983 implementation)"
type: feat
status: active
date: 2026-06-09
worktree: .claude/worktrees/realtime-fast-follows
related: implements #983; depends on #972/#973 (durable core); consumed by notesd live-edit (notesd docs/plans/2026-06-09-001)
---

# feat: NOSTR ephemeral-broadcast primitives (#983 implementation)

Enbox-side primitives for the **NOSTR ephemeral data plane**. The DWN is the control plane (authz'd `liveSession` records signal/attest/negotiate); NOSTR is the dumb, fast data plane. These primitives are **generic and CRDT-agnostic** — notesd (live-edit) is the first consumer, but nothing here is notesd- or Yjs-specific. Each phase lands as its own **PR** (the review/merge/publish gate).

See the consumer plan (notesd `docs/plans/2026-06-09-001-feat-live-edit-nostr-plan.md`) for the end-to-end architecture and the execution loop.

## Scope

- **In:** ephemeral `secp256k1`/Schnorr identity under the agent; NIP-44 crypto; a NOSTR relay client; the `enbox.live` facade (DWN↔NOSTR bridge); a relay-advertisement convention. Authenticated (plaintext) first; group-key **encryption** as a later, gated phase.
- **Out (separate):** #972/#973 (durable core — their own plan); self-hosted relay / NIP-42 allowlist / gift-wrap (ops, P5); the dapp's protocol records + editor wiring (notesd).
- **Dependency:** the collaborator (cross-tenant) `liveSession` write needs **#973**; the **own-tenant** (single-identity multi-device) path works without it, so the facade is buildable/testable before #973 lands.

## Key Technical Decisions

- **KTD-A — DWN bootstraps trust; NOSTR transports.** Acceptance of a NOSTR event is gated by the **roster**: the event's pubkey must appear in a current `liveSession` record authored by a DID the page protocol authorizes. The relay stays dumb (public relays usable for test). Confidentiality is a separate, later layer (encryption).
- **KTD-B — Ephemeral DID-attested key.** A fresh `secp256k1` key per session, Schnorr-signs events; the DID key never does Schnorr — it *attests* via the `liveSession` `RecordsWrite`. Un-attested keys (future privacy mode) ride the same code for pseudonymous broadcast.
- **KTD-C — CRDT-agnostic opaque payloads.** The facade carries opaque bytes + a generic `kind` (`content | presence`). No Yjs/notesd concept crosses the API.
- **KTD-D — Authenticated first, encrypted later.** v1 = signed + roster-verified (plaintext) so we can test on public relays immediately; group-key encryption (NIP-44) is a gated follow-on for private-page confidentiality and cryptographic revocation. Owner is the v1 key authority.
- **KTD-E — Wrap, don't reinvent.** Use `nostr-tools` / `@noble/{curves,ciphers}` for BIP-340 Schnorr, NIP-01 events, and NIP-44 — with known-answer + official interop vectors in CI. No bespoke crypto.

## Implementation Units

### Phase NL-1 — Crypto + ephemeral identity (PR 1)

- [ ] **Unit NL-1: Schnorr + NIP-44 crypto primitives**
  - **Files:** `@enbox/crypto` (or a new `@enbox/nostr` crypto submodule) — add BIP-340 Schnorr sign/verify over `secp256k1` and NIP-44 v2 (ChaCha20 + HKDF + HMAC) encrypt/decrypt, sourced from `@noble/curves`/`@noble/ciphers` or `nostr-tools`. Tests alongside.
  - **Tests:** BIP-340 reference test vectors; NIP-44 official test vectors (round-trip + cross-impl); tamper/negative cases.
  - **Verification:** vectors pass; the curve set is documented as additive (does not touch the DID `Ed25519|secp256k1|P-256` signing registry).
- [ ] **Unit NL-2: Ephemeral broadcast-identity service (agent)**
  - **Files:** `@enbox/agent` — a service to **mint / import / rotate** a session-scoped `secp256k1` keypair; expose its x-only pubkey; `sign(bytes)` via Schnorr (NL-1); TTL lifecycle; in-memory (not a DID verification method, not persisted as a DID key).
  - **Tests:** mint→sign→verify; rotate invalidates prior; import an existing nsec; TTL expiry.
  - **Verification:** an ephemeral pubkey + Schnorr signer usable by the facade; never co-mingled with DID keys.

### Phase NL-2 — NOSTR relay client (PR 2)

- [ ] **Unit NL-3: NOSTR client module**
  - **Files:** new `@enbox/nostr` (or `@enbox/api` submodule) — relay WebSocket client (NIP-01 `EVENT`/`REQ`/`EOSE`/`CLOSE`/`OK`), event build/sign(NL-2)/verify, ephemeral kinds (20000–29999), filter by topic tag + author set, NIP-44 (NL-1) encrypt/decrypt, **optional** NIP-42 AUTH. Thin wrapper over `nostr-tools`.
  - **Tests:** against a **local ephemeral relay** (test fixture) — publish/subscribe round-trip; reject bad signature; ephemeral kinds not stored; reconnect/backoff. (Public relays = manual smoke only, not CI.)
  - **Verification:** publish a signed ephemeral event to a relay and receive it on a second subscription, verified.

### Phase NL-3 — `enbox.live` facade + relay convention (PR 3)

- [ ] **Unit NL-4: Relay-advertisement convention**
  - **Files:** `@enbox/api` (+ DID-doc helper) — read/write a `NostrRelay` service endpoint in the DID document and a `relays` field on the `liveSession` record shape; a resolver that unions them.
  - **Tests:** advertise + resolve; default/fallback relay; precedence (liveSession over DID-doc default).
- [ ] **Unit NL-5: `enbox.live.session(...)` facade**
  - **Files:** `@enbox/api` — `enbox.live.session({ target, protocol, contextId, contentPath, relays?, encrypt:false }) → { publish(bytes, { kind }), on(kind, handler), peers(), leave() }`. Responsibilities: mint ephemeral key (NL-2); write own `liveSession` (own-tenant now; cross-tenant via #973 when `target ≠ self`); read + **subscribe** peers' `liveSession` to maintain the trusted-pubkey **roster**; resolve relays (NL-4); connect (NL-3); publish signed **plaintext** ephemeral events (topic = `hash(contextId)`); verify inbound against the roster; dispatch by `kind`; `leave`/expiry.
  - **Tests:** roster built from `liveSession`; inbound from an attested pubkey delivered; inbound from an **unattested** pubkey dropped; own-tenant two-instance exchange.
  - **Verification:** two sessions (same identity, two instances) exchange `content`+`presence` on a local relay; trust is roster-gated.
- [ ] **Unit NL-6: Integration + the consumer surface**
  - **Files:** integration tests; export `enbox.live` on the `Enbox` class + barrel.
  - **Tests:** two clients on a local relay converge; unattested rejected; a simulated durable-drop is healed by a re-publish (proves the degrade-to-durable contract at the seam).
  - **Verification:** the facade is consumable by notesd; CRDT-agnostic (opaque payload test with non-Yjs bytes).

### Phase NL-4 — Group-key encryption (GATED — PR 4, after the encryption go/no-go)

- [ ] **Unit NL-7: Group key + encrypted payloads**
  - **Files:** `@enbox/api` — owner mints a per-epoch group key `Gk`; delivers it to each attested peer over **NIP-44 pairwise** (NL-1) bootstrapped by the roster pubkeys (Gk never touches the DWN); symmetric-encrypt/decrypt payloads with `Gk`; `rotateKey()`.
  - **Tests:** key delivery to a new attested peer; encrypted round-trip; a peer without `Gk` cannot read; rotation excludes a revoked peer.
- [ ] **Unit NL-8: Revocation-by-rotation**
  - **Files:** wire roster-change (peer left / role revoked) → `rotateKey()` → redistribute to remaining.
  - **Tests:** revoked peer's post-rotation traffic is undecryptable; remaining peers continue seamlessly.
  - **Verification:** confidentiality holds on a public relay (relay sees only ciphertext); revocation is cryptographic.

## Risks & dependencies

- **Crypto correctness** — mitigated by wrapping audited libs + official vectors (KTD-E); PR gate includes crypto review (G2).
- **#973 dependency** — collaborator `liveSession`/durable writes are cross-tenant; own-tenant path unblocks early build/test.
- **Public-relay reliability/metadata** — CI uses a local relay; public relays are manual smoke; metadata privacy is Phase 5 (out of scope here).
- **Group-key management** — start simple (per-epoch, owner authority); MLS/Marmot reserved (KTD-D).
- **SDK publish ordering** — notesd consumes a published `@enbox` bump; each PR merge + publish is the gate before the dapp loop proceeds.

## Sources

- Issue: #983 (NOSTR ephemeral layer). Durable core: #972/#973 + `docs/plans/2026-06-08-001`.
- NIPs: NIP-01, NIP-44 (Cure53-audited), NIP-42, ephemeral kinds 20000–29999. Libs: `nostr-tools`, `@noble/curves`, `@noble/ciphers`.
- Consumer + architecture + execution loop: notesd `docs/plans/2026-06-09-001-feat-live-edit-nostr-plan.md`.
