# Proposal: DWN-to-DWN Sync and Multi-Party Record Delivery

## Status

Draft — capturing research and design direction for future implementation.

## Problem Statement

DWN synchronization today is entirely **agent-initiated**. The user's agent (running on their device) holds a local DWN and orchestrates bidirectional sync with each remote DWN listed in their DID document's `#dwn` service endpoint:

```
Agent (local DWN)  <--pull/push-->  Remote DWN A (provider 1)
Agent (local DWN)  <--pull/push-->  Remote DWN B (provider 2)
```

This creates two related problems:

### Problem 1: Cross-Provider Sync

If a user has DWN endpoints at two providers, those providers cannot sync with each other. All data must flow through the agent:

```
Provider A  <---agent--->  Agent  <---agent--->  Provider B
```

- The agent must be online for data to propagate between providers
- Every byte flows through the user's device twice
- Mobile/constrained agents become a bottleneck
- If the agent is offline, providers diverge until the next agent sync

### Problem 2: Multi-Party Record Delivery

Multi-party protocols use an owner-centric model. A chat thread with 5,000 participants:

```
Alice creates the thread in HER DWN
Bob writes a chat message to ALICE'S DWN
Carol writes a chat message to ALICE'S DWN
...all 5,000 participants read/write to Alice's DWN
```

There is no delivery mechanism. When Bob writes a chat message to Alice's DWN, Carol doesn't get notified unless she's actively subscribed or her agent is polling. There's nothing pushing that message to Carol's DWN.

Both problems involve a DWN server **proactively sending messages to another DWN server**. The difference is:

- **Sync**: messages flow between servers that host the same DID's data
- **Delivery**: messages flow between servers that host different DIDs who participate in the same protocol context

For a large provider, both can be handled by the same outbound delivery infrastructure.

---

## Part 1: Provider-to-Provider Sync (Same-Tenant, Cross-Provider)

### Approach: Delegated Sync Grants

The agent grants each provider DWN a permission to sync on its behalf with the tenant's other DWN endpoints. The provider runs a `ServerSyncEngine` that uses the existing `MessagesSync`/`MessagesRead` protocol, authenticated via delegated grants.

#### How It Works

1. During registration (or via a new protocol message), the agent creates permission grants for the provider's server DID:
   - `Messages/Sync` -- compare tree state on peer DWNs
   - `Messages/Read` -- fetch missing messages from peer DWNs

2. The provider resolves the tenant's DID document `#dwn` service endpoints to discover peer DWN URLs.

3. The provider runs a `ServerSyncEngine` per tenant that:
   - Performs SMT tree-walk against each peer DWN (same algorithm as `SyncEngineLevel.walkTreeDiff()`)
   - Pulls missing messages from peers via `MessagesRead` and writes them locally via `processMessage()`
   - Pushes local messages to peers — **the messages are already signed by their original authors**, so the receiving DWN authorizes based on the original signature, not the provider's identity
   - Uses `MessagesSubscribe` on peers for real-time sync (live mode)

```
Provider A  <--MessagesSync/Read (delegated grant)-->  Provider B
     |                                                      |
     +-- Agent grants sync delegation to both providers ----+
```

#### Why No RecordsWrite Grant Is Needed

The messages being synced are **already signed by their original author**. When Provider A pushes a message to Provider B, it sends the original `RecordsWrite` (with the author's signature intact). Provider B's `processMessage()` validates the original author's signature and authorization. The provider only needs:

- **`Messages/Sync`** -- to run the SMT tree-walk against the peer
- **`Messages/Read`** -- to fetch the full message + data from the peer by `messageCid`

This means the delegation is **read-only sync authority** -- the provider can read and relay messages between peers but cannot fabricate new writes. This is a much smaller trust surface.

#### Fan-Out on Receipt

When a provider receives a message via sync from a peer, it **SHOULD NOT** trigger outbound delivery/fan-out for that message. Only messages received via direct author writes trigger delivery. This prevents amplification loops. A convention or flag distinguishes "written by an author" from "arrived via sync."

#### What Needs to Change

- **Agent**: New `registerSyncDelegation()` method that creates and distributes the grants
- **DWN Server**: New `ServerSyncEngine` class (reuses `walkTreeDiff` and `pullMessages`/`pushMessages` logic from the agent's `SyncEngineLevel`)
- **DWN Server**: Tenant registry extended with peer DWN URLs and grant references
- **Spec**: No changes -- everything uses existing message types and authorization

---

## Part 2: Multi-Party Record Delivery

### Foundational Properties

Two properties of DWN make delivery tractable:

1. **Messages are self-certifying.** The original author's signature travels with the message. Any intermediary can relay it. The receiving DWN verifies the author's signature and protocol `$actions` independently -- no trust in the relay required.

2. **`processMessage()` is idempotent.** Duplicates return 409. Over-delivery is free (just wasted bandwidth), eliminating the need for exactly-once coordination and allowing layered strategies where fast-path and slow-path overlap without correctness risk.

### Context Establishment (The Bootstrap)

Before any delivery strategy works, the participant's DWN needs the minimum viable context:

- The **thread/channel root record**
- The participant's own **role record**
- The participant's **context encryption key** (if the protocol uses encryption)

This initial fan-out happens at **participant-add time** using direct delivery, regardless of the ongoing delivery strategy. When Alice writes a `thread/participant` role record with `recipient: bob.did`:

1. Alice's provider delivers to Bob's DWN:
   - The thread root record
   - Bob's participant role record
   - The context key record (for decryption)
2. Bob's DWN now has everything it needs to authorize subsequent messages via standard protocol `$actions`

This is the "join handshake" that sets up everything else.

### Determining Delivery Targets

A provider can determine who needs a message entirely from local data:

```
Given a new RecordsWrite for (protocol, protocolPath, contextId):

1. Explicit recipient: descriptor.recipient (if present)

2. Role-based discovery:
   - Get $actions rules at this protocolPath from the protocol definition
   - For each rule with a role granting "read":
     Query locally for role records:
       { protocol, protocolPath: <rolePath>,
         isLatestBaseState: true,
         contextId: <prefix matching parent context> }
   - Each matching record's descriptor.recipient is a delivery target

3. Actor-based discovery:
   - For rules with who: "author"/"recipient" of: <path>:
     Walk the record chain via parentId to find the ancestor
     Extract the author or recipient of that ancestor

4. Group targets by DWN service endpoint (resolved from DID documents)
```

All routing metadata (`protocol`, `protocolPath`, `contextId`, `recipient`, role records) is in **cleartext** on the message. Encrypted data payloads are opaque bytes. Relays never need to decrypt. All three delivery strategies work identically for encrypted and unencrypted protocols.

### Delivery Strategy: `$delivery`

Protocol authors declare a delivery strategy at the protocol path level using a new `$delivery` directive. Different paths in the same protocol can use different strategies.

---

### Strategy 1: Direct Delivery (`$delivery: "direct"`)

**For: Small participant sets (2-50 participants) across a handful of providers.**

The provider hosting the DWN where a write lands resolves the participant set, groups them by provider, and pushes the message directly to each provider.

#### Flow

```
1. RecordsWrite arrives at Alice's DWN on Provider A
2. Provider A queries the participant set for this context
3. Groups participants by DWN service endpoint
4. For each distinct provider endpoint:
   - Sends the original signed message (+ data) once
   - Includes a delivery manifest: tenant DIDs at that provider who should receive it
5. Receiving provider calls processMessage(tenantDid, message) for each listed tenant
   - 202: stored
   - 409: already have it (no-op)
6. Co-located participants (also on Provider A): local processMessage()
```

#### Cost

O(P) cross-network messages where P = number of distinct providers. For 30 participants across 4 providers, that's 3 outbound requests (the 4th is local).

#### Best For

DMs, small group chats, request/response workflows (credential issuance, purchase flows), any protocol with a small, explicit participant set.

---

### Strategy 2: Provider-Relay Delivery (`$delivery: "relay"`)

**For: Medium to large participant sets (50-10,000+) spread across many providers (10-100+).**

Delivery responsibility is **shared** across participating providers using deterministic relay assignment, so no single provider bears the full fan-out cost.

#### Core Mechanism: Rendezvous Hashing

When a message needs delivery across P providers:

```
1. Compute the set of participating providers for this context
   (derived from participant DIDs -> DWN service endpoints, cached)
2. For each provider Pi, compute:
   score_i = HMAC-SHA256(contextId || messageCid, Pi.endpoint)
3. Sort providers by score descending
4. Top-k providers are "relay coordinators" (k = ceil(log2(P)), min 2, max 5)
5. Origin sends message to the k relay coordinators
6. Each coordinator forwards to a deterministic subset of remaining providers
```

Properties of rendezvous hashing:
- **Deterministic**: every provider independently computes the same assignment with no coordination
- **Resilient**: when a provider goes down, its responsibilities redistribute automatically
- **Stable**: adding/removing providers only affects 1/P of the assignments
- **No shared state**: requires only a shared list of participating providers

#### Flow

```
1. RecordsWrite arrives at Alice's DWN on Provider A
2. Provider A computes relay assignment:
   - Relay coordinators: [Provider A (self), Provider C, Provider F]
   - Provider A's relay targets: [B, D, E]
   - Provider C's relay targets: [G, H, I, J]
   - Provider F's relay targets: [K, L, M]
3. Provider A delivers to:
   - Local tenants (processMessage)
   - Providers B, D, E (direct, as relay coordinator)
   - Providers C and F (with relay manifest -- they forward to their targets)
4. Provider C receives, delivers locally, forwards to G, H, I, J
5. Provider F receives, delivers locally, forwards to K, L, M
```

#### Overlap for Reliability

Each relay coordinator also delivers to one target from an adjacent coordinator's list. Since `processMessage()` is idempotent, this means a few duplicates in exchange for fault tolerance -- if a coordinator is down, the overlap ensures its targets still get the message within one hop.

#### Cost

- Origin load: O(k) where k = ceil(log2(P)), typically 2-5
- Total cross-network messages: P - 1 (same as direct, but load distributed)
- Max latency: 2 hops (origin -> coordinator -> final provider)

#### Provider Set Caching

The mapping from contextId -> participant DIDs -> provider endpoints changes only when participants are added/removed. Providers cache this mapping and invalidate on role record writes/deletes for the context.

#### Topology Considerations

- **3-4 big providers**: k=2 coordinators, minimal overhead -- barely different from direct
- **100 small providers**: k=5 coordinators each forward to ~20 -- manageable, well-distributed
- The rendezvous hashing distributes evenly regardless of provider size asymmetry

#### Best For

Group chats, community channels, collaborative workspaces, any protocol with a medium-to-large participant set where the participant set is enumerable via role records.

---

### Strategy 3: Subscribed Delivery (`$delivery: "subscribe"`)

**For: Asymmetric fan-out (few writers, many readers), public/broadcast contexts, or contexts where enumerating participants is impractical.**

This inverts the push model. Participant providers **subscribe** to the origin DWN for new records in the protocol context, using DWN's existing `RecordsSubscribe` infrastructure.

#### When This Makes Sense

- A social media feed: one user posts, thousands follow
- A protocol with `$actions: [{ who: "anyone", can: ["read"] }]` -- you can't enumerate "everyone"
- A bulletin board / announcement channel where readers vastly outnumber writers
- Any context where `published: true` records are the norm

#### Flow

```
1. Carol's provider wants records from Alice's DWN for context X
   (Carol has a role granting read, or records are published)
2. Carol's provider opens a RecordsSubscribe WebSocket to Alice's DWN:
   - filter: { protocol, contextId, protocolPath }
   - protocolRole: "thread/participant" (or omitted for published records)
   - cursor: last known position (for catch-up)
3. Alice's DWN streams matching events:
   - Catch-up: replay stored events since cursor
   - EOSE marker
   - Live: new events as they occur
4. Carol's provider calls processMessage(carol.did, message) locally
5. On disconnect, Carol's provider reconnects with last cursor (gapless resume)
```

#### Provider-Grouped Subscriptions

If Provider B hosts 500 users who follow Alice, Provider B opens **one** subscription to Alice's DWN (not 500). Provider B distributes locally. This mirrors the Matrix "send once per server" and ActivityPub "shared inbox" optimizations.

#### Hybrid With Push

For latency-sensitive records (mentions, direct replies with an explicit `recipient`), the origin provider MAY additionally perform direct delivery -- even in a subscribe-mode context. Subscribe handles bulk fan-out; direct delivery handles notifications.

#### Cost

- O(1) from origin's perspective per subscribing provider (WebSocket + event stream)
- The cost is borne by the subscriber's provider, not the origin
- Origin's work is constant regardless of how many providers subscribe

#### Best For

Social feeds, broadcast announcements, public bulletin boards, any protocol with asymmetric write/read ratios or `who: "anyone"` read rules.

---

## Strategy Comparison

| Dimension | Direct | Relay | Subscribe |
|---|---|---|---|
| Participants | 2-50 | 50-10,000+ | Unbounded |
| Providers (P) | 2-10 | 10-100+ | Any |
| Origin load per message | O(P) | O(k), k ~ log(P) | O(1) per subscriber |
| Delivery latency | 1 hop | 2 hops max | Subscription latency |
| Coordination needed | None | Deterministic (rendezvous hash) | Subscription management |
| Works offline? | Queue + retry + SMT | Queue + retry + SMT | Cursor-based catch-up |
| Push/Pull | Push | Push (distributed) | Pull (with push option) |
| Best for | DMs, small groups | Group chats, communities | Feeds, broadcasts |

## Mixing Strategies Within a Protocol

Different paths in the same protocol can use different strategies:

```json
{
  "protocol": "https://example.com/community",
  "structure": {
    "community": {
      "member": { "$role": true },
      "announcement": {
        "$delivery": "subscribe",
        "$actions": [{ "role": "community/member", "can": ["read"] }]
      },
      "channel": {
        "participant": { "$role": true },
        "message": {
          "$delivery": "relay",
          "$actions": [{ "role": "channel/participant", "can": ["create", "read"] }]
        }
      },
      "dm": {
        "$delivery": "direct",
        "$actions": [
          { "who": "author", "of": "community/dm", "can": ["read"] },
          { "who": "recipient", "of": "community/dm", "can": ["read", "create"] }
        ]
      }
    }
  }
}
```

- **Announcements**: subscribe -- one admin writes, thousands of members read
- **Channel messages**: relay -- hundreds of active participants, dozens of providers
- **DMs**: direct -- two participants, two providers

## The Universal Backstop: SMT Reconciliation

Regardless of delivery strategy, all providers periodically perform SMT reconciliation per protocol context:

```
Every 30-60s (configurable, with backoff when converged):
  For each (remoteProvider, protocol, contextId) tuple:
    Compare SMT roots
    If divergent: tree walk -> identify missing CIDs -> pull
```

This means:
- If direct delivery fails -> SMT catches it within 30-60s
- If a relay coordinator is down -> the overlap + SMT catches it
- If a subscribe connection drops -> cursor-based reconnect + SMT catches it
- If a provider doesn't support any delivery strategy -> agent-level pull + SMT still works

**The delivery strategies are optimizations for latency. The SMT guarantees correctness.**

## Spec Language Considerations

All delivery behavior is **provider-level optimization**, not a protocol-level requirement:

- Providers that support delivery **SHOULD** implement the strategy declared by `$delivery`
- Providers that do not support delivery **MAY** rely on participant agents performing pull-based sync
- Receiving providers **MUST** accept delivery of records that pass standard `processMessage()` authorization
- The `$delivery` directive is advisory -- the protocol functions correctly without it, just with higher latency

The key spec-level additions would be:

1. **`$delivery` directive** on `ProtocolRuleSet` -- `"direct"` | `"relay"` | `"subscribe"`
2. **Delivery manifest format** -- how a provider communicates "deliver this message to these tenant DIDs" to a peer provider (a lightweight envelope around the original signed message)
3. **Relay assignment algorithm** -- the rendezvous hashing specification so all providers independently compute the same relay topology
4. **Context establishment** -- the "join handshake" that delivers root record + role record + context key to a new participant's DWN

## Design Principles

1. **Self-certifying messages eliminate relay trust.** Any node can relay a message because the recipient verifies the author's signature. Relays can't forge or tamper.

2. **Idempotent processing eliminates exactly-once complexity.** Deliver as many times as you want. Duplicates return 409 and are ignored. Use redundant delivery paths aggressively.

3. **SMT provides convergence verification without consensus.** A single 32-byte root hash proves whether two nodes have the same message set. No Paxos, no Raft, no vector clocks.

4. **Provider-grouping exploits the natural topology.** Participants cluster by provider. Send one copy per provider, fan out locally. If average cluster size is 50 participants/provider, you send 98% fewer cross-network messages.

5. **Encryption is transparent to delivery.** All routing metadata is cleartext. Encrypted payloads are opaque. Relays never decrypt.

## Prior Art Considered

| System | Delivery Model | Lesson Taken |
|---|---|---|
| Matrix | Flat push, one transaction per server | Transaction batching, send-once-per-server grouping |
| Matrix | DAG-based ordering + state resolution | Deterministic convergence without central coordinator |
| ActivityPub | Origin pushes to all followers' inboxes | Shared inbox optimization (= provider-grouped delivery) |
| ActivityPub | O(servers) origin load | Why pure push doesn't scale -- motivated the relay strategy |
| AT Protocol | Relay/firehose model | Decoupling origin cost from audience size -- motivated subscribe strategy |
| AT Protocol | Self-certifying data repos | Validation that untrusted intermediaries work when data is signed |
| XMPP MIX | PubSub nodes + MAM catch-up | Persistent participation + cursor-based history -- already in DWN |
| Dynamo/Riak | Merkle tree anti-entropy | SMT reconciliation as universal consistency backstop |
| Plumtree | Push-lazy-push multicast | Eager delivery + lazy SMT reconciliation = the same pattern |
| NATS | Subject-based routing with server fan-out | Provider-grouped delivery mirrors NATS cluster routing |

## Open Questions

1. **Should `$delivery` be on the protocol definition or configurable per-context at runtime?** A large community might want relay for a 10,000-person general channel but direct for a 5-person subgroup -- both using the same protocol path.

2. **How should the delivery manifest be transported?** Options: a new JSON-RPC method (`dwn.deliverMessages`), an extension to the existing `dwn.processMessage` envelope, or a separate HTTP endpoint.

3. **Should providers advertise delivery capability in `/info`?** This would let protocol authors and agents know which providers support which delivery strategies.

4. **How should relay coordinator failures be detected and recovered?** The overlap provides immediate coverage, but should there be an explicit heartbeat or health-check protocol between coordinators?

5. **What is the right granularity for SMT reconciliation in multi-party contexts?** Per-protocol? Per-context? Per-provider-pair? The per-protocol tree already exists in the StateIndex; per-context would require additional tree management.
