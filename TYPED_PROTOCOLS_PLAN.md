# Typed Protocols Implementation Plan

## Overview

Four workstreams building on each other:

```
WS1: DWN SDK type tightening (protocols-types.ts)
WS2: Typed Protocol API (@enbox/api — defineProtocol, TypedDwnApi)
WS3: Standard Protocols package (@enbox/protocols)
WS4: App integration (wallet: Profile+Preferences, dapp: all 5 protocols)
```

## Dependency & Build Order

```
1. packages/dwn-sdk-js         (WS1 — type tightening)
2. packages/agent               (rebuild — depends on dwn-sdk-js)
3. packages/api                 (WS2 — typed protocol API)
4. packages/protocols           (WS3 — new package, depends on api + dwn-sdk-js)
5. examples/web-wallet          (WS4a — wallet integration)
6. examples/dapp-demo           (WS4b — dapp integration)
```

---

## WS1: DWN SDK Type Tightening

### 1.1 Tighten `ProtocolRuleSet` index signature

**File:** `packages/dwn-sdk-js/src/types/protocols-types.ts`

Extract `ProtocolTagsDefinition` as a named type. Replace `[key: string]: any` on
`ProtocolRuleSet` with a proper union of all `$`-prefixed property types plus
`ProtocolRuleSet` for child entries.

### 1.2 Use enum types in `ProtocolActionRule`

Change `who?: string` to `who?: ProtocolActor | \`${ProtocolActor}\`` and
`can: string[]` to `can: (ProtocolAction | \`${ProtocolAction}\`)[]`.

### 1.3 Fix downstream type errors

Audit code accessing child rule sets via index — add `as ProtocolRuleSet`
assertions where needed. Key files:
- `protocol-authorization.ts`
- `protocols-configure.ts`
- `protocols.ts` (utils)
- `protocols-configure.ts` (handler)

### 1.4 Validate

- `bun run build` from `packages/dwn-sdk-js/`
- `bun run test:node` — all 978 tests pass
- Rebuild `packages/agent/`, run its tests

---

## WS2: Typed Protocol API

### New files in `packages/api/src/`:

1. **`protocol-types.ts`** — Type utilities:
   - `ProtocolPaths<S>` — extract valid path strings from structure
   - `TypeNameAtPath<Path>` — last segment of a path
   - `SchemaForType<D, TypeName>` — lookup schema URI
   - `DataFormatsForType<D, TypeName>` — allowed data format literals
   - `TagsForPath<D, Path>` — tag shape from `$tags`

2. **`define-protocol.ts`** — `defineProtocol()` function + `TypedProtocol<D, SchemaMap>` type

3. **`typed-dwn-api.ts`** — `TypedDwnApi<D, SchemaMap>` class with typed
   `create`, `query`, `read`, `subscribe`, `delete`, `configure`

### Modified files:

4. **`dwn-api.ts`** — Add `using()` method
5. **`record.ts`** — Make `data.json()` generic: `json<T = any>(): Promise<T>`
6. **`index.ts`** — Export new modules

### Tests:

7. **`tests/typed-protocol.spec.ts`** — Runtime + type-level tests

---

## WS3: Standard Protocols Package

### New package: `packages/protocols/`

5 composable protocols:

| Protocol | URI | Types | Key Features |
|----------|-----|-------|-------------|
| Social Graph | `https://identity.foundation/protocols/social-graph` | friend, block, group, member | `$role`, `$tags`, nested list, owner-only |
| Profile | `https://identity.foundation/protocols/profile` | profile, avatar, link, privateNote | `uses` Social Graph, cross-protocol role, `$size`, binary formats, mixed visibility |
| Preferences | `https://identity.foundation/protocols/preferences` | theme, locale, privacy, notification | `encryptionRequired`, `$tags`, flat, owner-only |
| Status | `https://identity.foundation/protocols/status` | status, reaction | `uses` Social Graph, cross-protocol role, `$size`, published flag |
| Lists | `https://identity.foundation/protocols/lists` | list, item, folder, collaborator, comment | Both nesting patterns, `$role`, `uses` Social Graph, `$tags` with `enum`, deep paths |

### Composition graph:

```
Social Graph (foundation)
  ├── Profile    (uses social:friend for privateNote read)
  ├── Status     (uses social:friend for status read + reaction CRUD)
  └── Lists      (uses social:friend for list/item read + collaborator role)

Preferences (standalone)
```

### Installation order:

Social Graph first, then Profile/Status/Lists (any order). Preferences anytime.

### Data types per protocol:

**Social Graph:**
- `FriendData = { did: string; alias?: string; note?: string }`
- `BlockData = { did: string; reason?: string }`
- `GroupData = { name: string; description?: string; icon?: string }`
- `MemberData = { did: string; alias?: string }`

**Profile:**
- `ProfileData = { displayName: string; bio?: string; location?: string; website?: string; pronouns?: string }`
- `AvatarData = Blob` (binary)
- `LinkData = { url: string; title: string; icon?: string }`
- `PrivateNoteData = { content: string }`

**Preferences:**
- `ThemeData = { mode: 'light' | 'dark' | 'system'; accentColor?: string; fontSize?: 'small' | 'medium' | 'large' }`
- `LocaleData = { language: string; region?: string; timezone?: string; dateFormat?: string; hourCycle?: '12h' | '24h' }`
- `PrivacyData = { cookieConsent: { analytics: boolean; marketing: boolean; functional: boolean }; shareUsageData: boolean }`
- `NotificationData = { channel: string; enabled: boolean; quietHoursStart?: string; quietHoursEnd?: string }`

**Status:**
- `StatusData = { text: string; emoji?: string; activity?: 'online' | 'away' | 'busy' | 'offline'; expiresAt?: string }`
- `ReactionData = { emoji: string }`

**Lists:**
- `ListData = { name: string; description?: string; icon?: string; listType: 'todo' | 'bookmarks' | 'reading' | 'custom' }`
- `ItemData = { title: string; url?: string; note?: string; completed?: boolean }`
- `FolderData = { name: string; icon?: string }`
- `CollaboratorData = { did: string; alias?: string }`
- `CommentData = { text: string }`

---

## WS4: App Integration

### 4a: Wallet (Profile + Preferences only)

- Replace `src/lib/ProfileProtocol.ts` with `@enbox/protocols` imports + typed API
- Add Preferences support (theme, locale, privacy, notification)
- Update `ProtocolsContext.tsx` to install both protocols

### 4b: Demo Dapp (all 5 protocols)

- Replace tasks protocol with Lists protocol
- Replace local profile with `@enbox/protocols`
- Add Social Graph, Status, Preferences pages
- Rewrite repositories using typed API
- Update wallet connect `permissionRequests` for all 5 protocols

---

## Feature Coverage Matrix

| Feature | Social Graph | Profile | Preferences | Status | Lists |
|---------|:-----------:|:-------:|:-----------:|:------:|:-----:|
| `$role: true` | friend | — | — | — | collaborator |
| `$tags` + `$requiredTags` | friend, block, member | link | notification | — | list, collaborator, item, folders |
| `$tags` + `enum` | — | — | — | — | listType |
| `$size` | — | profile, avatar | — | status | — |
| `uses` / cross-protocol role | — | social:friend | — | social:friend | social:friend |
| `encryptionRequired` | — | — | privacy | — | — |
| Binary data formats | — | avatar (images) | — | — | — |
| Nested list (DWN-enforced) | group/member | profile/link | — | status/reaction | folder/folder/folder |
| Flat list (tag-based parent) | — | — | — | — | item + parentItemId |
| Published records | — | profile, avatar, link | — | status (flag) | — |
| Ordered collections | — | link (sortOrder) | — | — | item, folder (sortOrder) |
