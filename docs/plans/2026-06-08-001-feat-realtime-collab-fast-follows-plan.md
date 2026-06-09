---
title: "feat: cross-tenant durable fast-follows (#972, #973)"
type: feat
status: active
date: 2026-06-08
worktree: .claude/worktrees/realtime-fast-follows
branch: feat/realtime-fast-follows
---

# feat: cross-tenant durable fast-follows (#972, #973)

> **Scope change (2026-06-09):** the ephemeral realtime channel (formerly Phase 3 / #977) has been **removed from this plan**. That problem is now solved by **NOSTR** as the ephemeral broadcast layer — see **#983** (#977 closed as superseded). This plan now covers only the **core durable** Enbox changes: #972 and #973. They stand on their own and were always independent of the ephemeral layer.

## Overview

Two enbox monorepo changes extend the **durable** record substrate that any collaborative dapp needs. They are independent and shippable separately, ordered by size:

- **Phase 1 — #972 typed `squash` exposure** (~2 LOC + test): let the typed `records.create` carry `squash: true` so a consumer can write a compacting snapshot through the typed API instead of the low-level escape hatch.
- **Phase 2 — #973 cross-tenant writes** (client-only): let a connected client author a record **into another tenant's DWN** over `from:` + `protocolRole` (or a delegated grant), mirroring the read side. This unlocks durable collaborator authorship — a shared-page collaborator publishing their own signed deltas to the owner's DWN. **Verification confirmed this needs NO server or agent changes** — the relay already authorizes role-invoked non-owner writes and the agent already supports remote dispatch + grant resolution; only the API-layer `records.write`/typed `create` wrappers omit `from` and force local dispatch.

Both phases touch adjacent code in `packages/api` and should sequence 1→2 to avoid conflicts. The realtime/ephemeral plane (live cursors, presence, keystroke ops) is **not** here — it is the NOSTR broadcast layer in #983.

## Requirements Trace

- **R1 — Typed squash.** `proto.records.create(path, { data, squash: true })` reaches the write message with `squash: true` (today it is silently dropped). *(Phase 1.)*
- **R2 — Cross-tenant authored writes.** A client holding a role grant (or delegated grant) can write a record into another tenant's DWN via `from:` + `protocolRole`; the write is remotely dispatched, signed by the connected (grantee) DID, and accepted by the owner's relay under the existing authorization. *(Phase 2.)*
- **R3 — Cross-tenant create surface.** Both the low-level `records.write` and the typed `records.create` expose `from` + `protocolRole`, and the returned record carries `remoteOrigin` so a follow-up **read** (`.data`) targets the owner tenant; a follow-up **update** targets the owner tenant only when the caller passes an explicit `from` (Unit 3b — cross-tenant update is opt-in, it does **not** inherit `remoteOrigin` for routing). *(Cross-tenant **delete** is `Record.delete()` — a third local-only method; it is **out of scope** for v1 (no consumer needs collaborator cross-tenant delete) and is a trivial same-pattern follow-on if one arises — explicitly not promised here.)* *(Phase 2, Units 2–3.)*
- **R3b — Cross-tenant update.** Typed `update` is a **separate code path** (`Record.update()` → `record.ts`, today local-only — it has no `from` and always targets/processes the connected DID). Cross-tenant update (the collaborator co-updating the owner's derived `document`/`meta` singletons) is delivered as its own unit, not folded into R3. **Cross-tenant update requires an explicit `from` on the call and does NOT silently inherit the record's `_remoteOrigin` for routing — this preserves existing local-update behavior with zero regression.** *(Phase 2, Unit 3b.)*

## Scope Boundaries

- **No new protocol types; no dwn-sdk-js authorization changes.** Both phases reuse the existing role/grant authz untouched. The entire change is additive optional fields on the API-layer write/create/update wrappers.
- **#973 Tier 2 (foreign-tenant scoped sync)** — replicating a shared subtree into the grantee's *local* DWN for offline editing — is **out**. Phase 2 is online-only cross-tenant authoring. (Tracked separately on #973.)
- **Ephemeral realtime plane is out of this plan** — live cursors/presence/keystroke ops are the NOSTR broadcast layer (#983), not a DWN/relay change here.
- **No notesd client integration in this plan** — the squash/cross-tenant consumer swaps live in the notesd repo. This plan delivers the enbox primitives those consume; consumer follow-ups are noted per phase.

## Context & Research

All claims below were source-verified in the enbox monorepo during planning (file paths are relative to the repo root).

### Relevant code and patterns

- `packages/api/src/dwn-api.ts` — the low-level `records.{write,read,query,delete,subscribe}` implementations. Read/query/delete already accept `from` and branch `if (from) sendDwnRequest else processDwnRequest`; **write does not** (hardcodes `target: this.connectedDid`, dispatches `processDwnRequest` unconditionally). `RecordsWriteRequest` type omits `from`. The low-level write already forwards `squash` (it survives the `Partial<DwnMessageParams[RecordsWrite]>`).
- `packages/api/src/typed-enbox.ts` — `TypedCreateRequest` (~lines 114–175) and the typed `create` (~lines 955–985), which forwards an **explicit enumerated field list** to `this._dwn.records.write`. `protocolRole` is **already** in `TypedCreateRequest` and the forward list (~lines 172, 979) — so the only typed-create gaps are `squash` (Unit 1) and `from` (Unit 3); the list omits both.
- `packages/api/src/record.ts` — `Record.update()` (~line 581) builds params with no `from`, always targets/processes the connected DID locally, and mutates `this` in place returning a new record (~line 605). `_remoteOrigin` is `private readonly`.
- `packages/agent/src/dwn-api.ts` (`AgentDwnApi`) — `processRequest` vs `sendRequest`/`sendDwnRpcRequest` routing (`this._dwn ? processMessage : sendDwnRpcRequest`); `constructDwnMessage` already handles `granteeDid` + delegated-grant resolution and signs with the grantee's key (`request.granteeDid ? getSigner(granteeDid) : getSigner(author)`); `sendDwnRpcRequest` already streams record data over RPC. **No agent change needed.**
- `packages/dwn-sdk-js/src/interfaces/records-write.ts` — `RecordsWriteOptions` already has `protocolRole?` and `delegatedGrant?`.
- `packages/dwn-sdk-js/src/handlers/records-write.ts` (`authorizeRecordsWrite`) — acceptance paths: owner-delegate, `author === tenant`, permission-grant, and protocol role-invocation (`ProtocolAuthorization.authorizeWrite` → `verifyInvokedRole`). A non-owner author with a valid invoked role or delegated grant **is already accepted**. No server change needed.

### Institutional learnings / prior art

- The notesd v3 plan's KTD-6 originally concluded cross-tenant writes were "blocked" pending a remote-dispatch write path plus grant/role invocation. Source verification corrected this (KTD-1 below): it is client-only.
- The realtime/ephemeral exploration that lived here (and on #977) was superseded by the PDS/Broadcast-layer split — NOSTR for the ephemeral plane (#983). #972/#973 were always the independent durable core.

## Key Technical Decisions

### KTD-1 — Phase 2 is client-only (corrects the earlier "blocked" framing)
The notesd v3 plan's KTD-6 concluded cross-tenant writes needed "a remote-dispatch write path PLUS grant/role invocation, not merely a `target` field." Verification shows that was pessimistic: the agent **already** remote-dispatches and resolves grants, `RecordsWrite` **already** carries `protocolRole`, and the relay **already** authorizes role-invoked non-owner writes. The block is *only* that `packages/api/src/dwn-api.ts`'s `records.write` wrapper omits `from` and forces local dispatch. Phase 2 mirrors the read side in that one wrapper (+ the typed `create`). No agent, no server, no protocol changes.

### KTD-2 — Authoring mechanism: support both role-invocation and delegated-grant, lead with role
Both are server-accepted. **Role-invocation** (`protocolRole` + an existing role record with `recipient = grantee`) is the right primary mechanism for "a collaborator writes into a page they were shared on" — it's symmetric, protocol-defined, and is exactly what the notesd `collaborator` `$role` already grants. **Delegated-grant** (`granteeDid` + `delegatedGrant`/`permissionGrantId`) is the asymmetric alternative the agent already resolves; Phase 2 must not *break* it (it flows through the same `from` dispatch). The API change is mechanism-agnostic: expose `from` + `protocolRole`; `granteeDid`/grant params continue to flow through `messageParams` as today.

### KTD-3 — Cross-tenant `update` is explicit-`from`, not `_remoteOrigin`-defaulted
Cross-tenant routing on `Record.update()` fires **only** when the caller passes an explicit `from` differing from the connected DID; `_remoteOrigin` stays `private readonly` and a read-remote-then-update caller stays **local** unless it passes `from`. Defaulting `from` to `_remoteOrigin` would silently re-route any existing read-remote-then-update caller for zero v1 benefit (there is no cross-tenant-update caller today). The only persisted effect is the **returned** record carrying `remoteOrigin: from ?? this._remoteOrigin` so its own `.data` re-reads target the owner tenant.

## Open Questions

### Resolved during planning (via source verification)
- *Is #973 client-only or client+server?* → **Client-only** (KTD-1). Server + agent already support it.
- *Role-invocation or delegated-grant for cross-tenant authoring?* → **Both accepted; lead with role-invocation** (KTD-2).
- *Does cross-tenant `update` inherit `_remoteOrigin` for routing?* → **No — explicit `from` only** (KTD-3).

## Implementation Units

Units are dependency-ordered; each is a single landable commit.

### Phase 1 — #972 typed squash

- [ ] **Unit 1: Expose `squash` on the typed create path**

**Goal:** `proto.records.create(path, { data, squash: true })` reaches the write message with `squash: true`.

**Requirements:** R1.

**Dependencies:** none.

**Files:**
- Modify: `packages/api/src/typed-enbox.ts` — add `squash?: true` to `TypedCreateRequest`; add `squash: request.squash` to the enumerated field list forwarded to `this._dwn.records.write` (~line 985).
- Test: the api package's existing typed-create test suite (locate `typed-enbox`/`records.create` specs under `packages/api/tests/`).

**Approach:** Two-line change. The low-level `records.write` already forwards `squash` (it survives the `Partial`), so nothing else is needed. Mirror how an adjacent optional field (e.g. `recipient`, `tags`) is both typed and forwarded.

**Test scenarios:**
- Happy: `create(path, { data, squash: true })` produces a write message whose descriptor carries `squash: true` (assert via a mocked/agent-captured message).
- Edge: omitting `squash` produces no `squash` field (not `false`) — parity with today.
- Edge (optional, integration): against an in-memory dwn with a `$squash: true` path, a `create({squash:true})` purges older siblings (reuses the dwn-sdk-js squash test harness).

**Verification:** A typed `create` with `squash: true` is observably a squashing write; existing typed-create tests still pass.

**Consumer follow-up (notesd):** swap `src/store/delta-repo.ts` `writeDelta({snapshot})`'s raw-API branch to the typed path (one-line internal change behind the existing seam).

### Phase 2 — #973 cross-tenant writes (client-only)

- [ ] **Unit 2: Low-level `records.write` — `from` + remote dispatch + `protocolRole`**

**Goal:** `records.write` can target another tenant (`from`), routes remotely when `from` is set, signs as the connected (grantee) DID, threads `protocolRole`, **and stamps the returned record with `remoteOrigin: from`** so a follow-up **data read** (`.data`) on it targets the owner tenant. *(Precise per KTD-3: `remoteOrigin` drives **reads**, not routing for **update** — cross-tenant `update` requires an explicit `from` (Unit 3b); cross-tenant `delete` is out of scope.)*

**Requirements:** R2, R3.

**Dependencies:** Unit 1 (adjacent edits in the same files; sequence to avoid conflict).

**Files:**
- Modify: `packages/api/src/dwn-api.ts` — add `from?: string` (and ensure `protocolRole?` flows) to `RecordsWriteRequest`; in `write()`: `target = from ?? this.connectedDid` (author stays `this.connectedDid` — grantee signs as self); dispatch `if (from) sendDwnRequest else processDwnRequest`, mirroring `records.read`/`query`/`delete`; **construct the returned `Record` with `remoteOrigin: from`** (read/query already do this at the cited lines — the write path currently omits it).
- Test: `packages/api/tests/` records-write specs (+ a new cross-tenant write spec).

**Approach:** Mirror the read path exactly — copy its `from`/dispatch selection **and its `remoteOrigin` stamping** into `write`. `protocolRole` is already a valid `RecordsWriteOptions` field; ensure the wrapper passes it through `messageParams` (it may already; confirm). Do **not** touch the agent or server. Preserve the existing `granteeDid`/delegated-grant flow (it rides the same dispatch).

**Execution note:** Add a failing integration test first (a write with `from` set must hit `sendDwnRequest`, not `processDwnRequest`, and the returned record must carry `remoteOrigin`).

**Test scenarios:**
- Happy: `write({ from: ownerDid, protocolRole, data, protocol, protocolPath, parentContextId })` dispatches via `sendDwnRequest` with `target = ownerDid`, `author = connectedDid` (assert the agent request shape).
- Happy: no `from` → unchanged local `processDwnRequest` path, no `remoteOrigin` (regression guard).
- Happy (remoteOrigin): the returned record has `remoteOrigin === ownerDid`; a follow-up `record.data.bytes()` on it targets the owner tenant (not the local one) — assert the dispatch target. *(Follow-up `update` is covered by Unit 3b; `delete` is out of scope — do not assert remote delete.)*
- Integration (in-memory two-tenant or mocked agent): a role-authorized cross-tenant create is **accepted** (the owner tenant has a matching `$role` record with `recipient = grantee`); a non-role, non-grant cross-tenant write is **rejected** (401/403 surfaces, not swallowed).
- Edge: a write carrying record **data** routes remotely with the payload intact — the agent's `sendDwnRequest` requires the data as a `Blob` (traced: `dwn-api.ts` throws "DataStream must be provided as a Blob"), which the write path already produces via `dataToBlob`; assert the data survives `sendDwnRequest`.
- Note (traced): the returned record sets `remoteOrigin: from` but keeps `connectedDid = this.connectedDid` (the connected/grantee DID is always the author) — matching the read path's record construction.
- Edge: delegated-grant write (`granteeDid` + grant) with `from` still works (no regression to the grant path).

**Verification:** A grantee client writes a record into an owner tenant's DWN over `from` + `protocolRole`, the owner's relay stores it, and the returned record correctly remembers its remote origin; non-authorized writes fail visibly.

- [ ] **Unit 3: Typed `create` — expose `from`**

**Goal:** The typed `proto.records.create` exposes `from` so consumers author cross-tenant **creates** (the collaborator-delta case — deltas are create-only) without dropping to the low-level API. *(`protocolRole` is already supported on typed create — verified; update is a separate path — Unit 3b.)*

**Requirements:** R3.

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/api/src/typed-enbox.ts` — add `from?: string` to `TypedCreateRequest` and forward it in the enumerated field list (same site as Unit 1's `squash`). **`protocolRole` is already present (~lines 172, 979) — do not re-add it.**
- Test: `packages/api/tests/` typed-create specs (+ cross-tenant typed-create assertions).

**Approach:** Same enumerated-forward pattern as Unit 1 — add only `from` (the typed wrapper already forwards `protocolRole`; it strips only `squash` and `from`). **Do not** touch the typed update path here — typed `update` delegates to `Record.update()` (`record.ts`), a separate local-only path handled in Unit 3b; claiming create+update parity in one change is the over-promise the review caught.

**Test scenarios:**
- Happy: typed `create({ from, protocolRole, data })` forwards both `from` and the already-supported `protocolRole` to `records.write` (assert via captured low-level request).
- Edge: typed `create` without `from` is unchanged (regression).
- Integration: a typed cross-tenant create against a role-granting owner tenant is accepted (reuses Unit 2's harness through the typed layer), and the returned typed record carries `remoteOrigin`.

**Verification:** A consumer authors cross-tenant **creates** through `enbox.using(Protocol).records.create({ from, protocolRole, ... })`.

- [ ] **Unit 3b: Cross-tenant `Record.update` — `from`/remote-origin dispatch**

**Goal:** `record.update()` can target another tenant so a collaborator can **co-update** the owner's derived `document`/`meta` singletons (the co-update action the owner's protocol already authorizes).

**Requirements:** R3b.

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/api/src/record.ts` — `update()` currently builds params with no `from`, always targets/processes `this._connectedDid` locally (~line 581), and **mutates `this` in place**, returning a new record that keeps the existing `_remoteOrigin` (~line 605). Add an **explicit** `from?: string` + thread `protocolRole`; when `from` is set and differs from the connected DID, dispatch remotely (`sendDwnRequest`) and sign as the connected (grantee) DID; otherwise the path is **unchanged** (local dispatch). **Do NOT default `from` to `_remoteOrigin`** — a record that was merely *read* from a remote tenant still updates **locally** unless the caller passes `from`, preserving today's documented behavior. Stamp the **returned** record with `remoteOrigin: from ?? this._remoteOrigin` (via its constructor) so a subsequent `.data` re-read hits the owner tenant; `_remoteOrigin` can stay `private readonly` (no `readonly` drop needed — the routing decision is the explicit `from`, not the stored origin).
- Modify: `packages/api/src/typed-record.ts` (~line 295) — expose `from`/`protocolRole` on the typed update request and forward to `Record.update()`.
- Test: `packages/api/tests/` record-update + typed-record specs (+ cross-tenant update).

**Approach:** Mirror Unit 2's write changes in the update method, but as a **strictly opt-in** cross-tenant path: cross-tenant routing happens **only** when the caller passes an explicit `from` that differs from the connected DID; sign as the connected (grantee) DID. **No `from ?? _remoteOrigin` default.** This deliberately *keeps* today's behavior in which the read/query path sets a remote-fetched record's `connectedDid` to the *local* DID so `record.update()` runs locally even for remote-origin records (`_remoteOrigin` is used only for large-data re-reads) — so **no existing caller changes behavior**. The only persisted effect is that the **returned** record carries `remoteOrigin: from ?? this._remoteOrigin` so its own subsequent `.data` re-reads target the owner tenant. **Consumer audit (do before relying on it):** grep notesd/web-wallet for `.update()` on records obtained via a `from` read and confirm none expect implicit cross-tenant routing (none should — the surface is new).

**Test scenarios:**
- **Regression (the reason for the explicit-`from` choice):** a record with `_remoteOrigin = ownerDid` updated with **no** `from` dispatches **locally** (unchanged from today), **not** to `ownerDid` — assert no silent cross-tenant routing.
- Happy: explicit `from = ownerDid` dispatches remotely (`sendDwnRequest`, `target = ownerDid`, `author = connectedDid`); `protocolRole` threads through; the returned record carries `remoteOrigin = ownerDid` so its next `.data.bytes()` targets `ownerDid`.
- Integration: a collaborator co-updates an owner-authored singleton (`document`/`meta`) via explicit `from` under a `co-update` role rule → accepted; a non-`co-update` role → rejected.
- Edge: a purely-local record (no `from`) updates locally and stays local (regression).

**Verification:** A collaborator updates a record on the owner's tenant via role-authorized `co-update`; local updates are unchanged.

**Consumer follow-up (notesd):** route `src/sharing/remote-page.ts` `publishDelta` (the `NotSupportedYet` seam) through the new `from` create for **deltas** (Unit 3), and the cross-tenant `Record.update` (passing an explicit `from: ownerDid`) for **derived `document`/`meta` co-updates** (Unit 3b); enable the dormant collaborator write actions (delta create/squash, derived co-update). Per the #973 sequencing note: collaborator *snapshot* writes must carry `squash` (via #972's typed path or the raw seam) so collaborator snapshots actually compact. If Unit 3b is deferred, the consumer still gets durable collaborator **deltas** (creates), and the owner's derived records simply refresh whenever any updater flushes — a documented v1 staleness, not data loss.

## System-Wide Impact

- **Interaction graph.** Both phases touch only the API wrappers — the agent and server are unchanged, so the blast radius is the typed/low-level request shapes (additive optional fields).
- **Error propagation.** Cross-tenant write rejections must surface as thrown errors / explicit rejections, never silent empties — the consuming dapp distinguishes "unauthorized/revoked" from "transient."
- **API surface parity.** Keep the low-level and typed surfaces consistent (`from` + `protocolRole` on both).
- **Integration coverage.** The load-bearing cross-layer test: a role-authorized cross-tenant write traverses api→agent→relay→store and is accepted, while an unauthorized one is rejected. This proves what mocks cannot.

## Risks & Dependencies

- **Cross-tenant write data-over-RPC.** Writes carry data; the read-side `sendDwnRequest` is proven, but a write with a large payload over RPC is a newer path for this wrapper. Mitigation: explicit data-payload integration test (Unit 2).
- **Consumer sequencing.** notesd's #973 follow-up must land collaborator snapshot writes through a `squash`-carrying path (#972) — noted on #973; the enbox side here is independent, but the consumer integration depends on both phases.
- **Greenfield-but-shipped surfaces.** The API wrappers serve real tenants; changes are additive optional fields, gated by the `packages/api` + `packages/dwn-sdk-js` CI suites.

## Documentation / Operational Notes

- Each phase ships as its own PR referencing its issue (#972 / #973). Both are small and unblock notesd immediately.
- The ephemeral realtime plane is tracked separately in **#983** (NOSTR broadcast layer); it is not part of this plan or these PRs.

## Sources & References

- **Issues:** [enboxorg/enbox#972](https://github.com/enboxorg/enbox/issues/972) (typed squash), [#973](https://github.com/enboxorg/enbox/issues/973) (cross-tenant writes). Ephemeral plane: [#983](https://github.com/enboxorg/enbox/issues/983) (NOSTR; supersedes the closed #977).
- **API:** `packages/api/src/{dwn-api,typed-enbox,record,typed-record}.ts`.
- **Agent:** `packages/agent/src/dwn-api.ts` (`processRequest`/`sendRequest`/`constructDwnMessage`).
- **dwn-sdk-js:** `src/handlers/records-write.ts`, `src/interfaces/records-write.ts`, `src/core/protocol-authorization-action.ts`.
- **Consumer plan:** notesd `docs/plans/2026-06-05-002-feat-crdt-collab-foundation-plan.md` (KTD-1/KTD-6 corrected by this plan's KTD-1).
